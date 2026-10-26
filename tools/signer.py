#!/usr/bin/env python3
"""APK Signature Scheme v2 signing/verification in pure Python.

Injection rewrites the APK, so the template signature is invalid afterwards and
the result has to be re-signed. v2 is enough for ``minSdkVersion 24`` (Android
7.0, where the scheme was introduced) and needs no Java, no apksigner and no
third-party packages - just a PEM key/certificate pair.

Layout reference: https://source.android.com/docs/security/features/apksigning/v2
"""
from __future__ import annotations

import hashlib
import os
import shutil
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path

CHUNK_SIZE = 1024 * 1024
SIG_RSA_PKCS1_SHA256 = 0x0103
V2_BLOCK_ID = 0x7109871A
SIGNING_BLOCK_MAGIC = b"APK Sig Block 42"
EOCD_MAGIC = b"PK\x05\x06"
ZIP64_LOCATOR_MAGIC = b"PK\x06\x07"

DEBUG_KEY_NAME = "debug.key.pem"
DEBUG_CERT_NAME = "debug.cert.pem"


class SignatureError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# DER helpers
# --------------------------------------------------------------------------
def _tlv(buf: bytes, off: int) -> tuple[int, int, int, int]:
    """Return (tag, content_start, content_length, next_offset)."""
    if off + 2 > len(buf):
        raise SignatureError("truncated DER")
    tag = buf[off]
    pos = off + 1
    length = buf[pos]
    pos += 1
    if length & 0x80:
        count = length & 0x7F
        if count == 0 or pos + count > len(buf):
            raise SignatureError("unsupported DER length")
        length = int.from_bytes(buf[pos : pos + count], "big")
        pos += count
    end = pos + length
    if end > len(buf):
        raise SignatureError("truncated DER value")
    return tag, pos, length, end


def _children(buf: bytes) -> list[tuple[int, bytes, bytes]]:
    """Top-level TLVs of a content region: (tag, content, raw)."""
    out = []
    pos = 0
    while pos < len(buf):
        tag, start, length, end = _tlv(buf, pos)
        out.append((tag, buf[start : start + length], buf[pos:end]))
        pos = end
    return out


def _pem_to_der(path: Path, label: str) -> bytes:
    try:
        text = path.read_text(encoding="ascii")
    except FileNotFoundError:
        raise SignatureError(f"signing material not found: {path}") from None
    begin = f"-----BEGIN {label}-----"
    end = f"-----END {label}-----"
    if begin not in text or end not in text:
        raise SignatureError(f"{path} is not a PEM {label} file")
    body = text.split(begin, 1)[1].split(end, 1)[0]
    import base64

    return base64.b64decode("".join(body.split()))


def _ints(der: bytes) -> list[int]:
    return [int.from_bytes(content, "big") for tag, content, _ in _children(der) if tag == 0x02]


@dataclass
class SigningKey:
    n: int
    e: int
    d: int
    cert_der: bytes
    spki_der: bytes

    @property
    def key_size_bytes(self) -> int:
        return (self.n.bit_length() + 7) // 8


def _parse_rsa_private_key(der: bytes) -> tuple[int, int, int]:
    tag, start, length, _ = _tlv(der, 0)
    if tag != 0x30:
        raise SignatureError("not an RSA private key")
    fields = _children(der[start : start + length])
    # PKCS#8 wraps PKCS#1 in an OCTET STRING: version, AlgorithmIdentifier, key.
    if len(fields) >= 3 and fields[1][0] == 0x30 and fields[2][0] == 0x04:
        return _parse_rsa_private_key(fields[2][1])
    values = _ints(der[start : start + length])
    if len(values) < 4:
        raise SignatureError("not an RSA private key")
    _version, n, e, d = values[:4]
    return n, e, d


def load_key(key_path: Path, cert_path: Path) -> SigningKey:
    der = _pem_to_der(key_path, "PRIVATE KEY")
    n, e, d = _parse_rsa_private_key(der)

    cert_der = _pem_to_der(cert_path, "CERTIFICATE")
    tag, start, length, _ = _tlv(cert_der, 0)
    if tag != 0x30:
        raise SignatureError("malformed certificate")
    cert_body = cert_der[start : start + length]
    tbs = _children(cert_body)[0][1]
    fields = _children(tbs)
    if fields and fields[0][0] == 0xA0:  # optional [0] version
        fields = fields[1:]
    # serial, signatureAlgorithm, issuer, validity, subject, subjectPublicKeyInfo
    if len(fields) < 6:
        raise SignatureError("malformed certificate (missing subjectPublicKeyInfo)")
    spki_der = fields[5][2]

    spki_tag, spki_start, spki_length, _ = _tlv(spki_der, 0)
    if spki_tag != 0x30:
        raise SignatureError("malformed subjectPublicKeyInfo")
    alg_and_key = _children(spki_der[spki_start : spki_start + spki_length])
    if len(alg_and_key) < 2 or alg_and_key[1][0] != 0x03:
        raise SignatureError("malformed subjectPublicKeyInfo")
    bit_string = alg_and_key[1][1]
    if not bit_string or bit_string[0] != 0:
        raise SignatureError("unsupported public key encoding")
    pub_n, pub_e = parse_rsa_public_key(bit_string[1:])
    if (pub_n, pub_e) != (n, e):
        raise SignatureError("certificate does not match the private key")

    return SigningKey(n=n, e=e, d=d, cert_der=cert_der, spki_der=spki_der)


def parse_rsa_public_key(der: bytes) -> tuple[int, int]:
    tag, start, length, _ = _tlv(der, 0)
    if tag != 0x30:
        raise SignatureError("not an RSA public key")
    values = _ints(der[start : start + length])
    if len(values) < 2:
        raise SignatureError("not an RSA public key")
    return values[0], values[1]


# --------------------------------------------------------------------------
# RSA PKCS#1 v1.5 / SHA-256
# --------------------------------------------------------------------------
_SHA256_DIGEST_INFO_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def _sha256_digest_info(data: bytes) -> bytes:
    return _SHA256_DIGEST_INFO_PREFIX + hashlib.sha256(data).digest()


def _rsa_sign(data: bytes, key: SigningKey) -> bytes:
    size = key.key_size_bytes
    digest_info = _sha256_digest_info(data)
    padding = size - len(digest_info) - 3
    if padding < 8:
        raise SignatureError("RSA key too small")
    encoded = b"\x00\x01" + b"\xff" * padding + b"\x00" + digest_info
    signature = pow(int.from_bytes(encoded, "big"), key.d, key.n)
    return signature.to_bytes(size, "big")


def _rsa_verify(data: bytes, signature: bytes, n: int, e: int) -> bool:
    size = (n.bit_length() + 7) // 8
    if len(signature) != size:
        return False
    digest_info = _sha256_digest_info(data)
    padding = size - len(digest_info) - 3
    if padding < 8:
        return False
    expected = b"\x00\x01" + b"\xff" * padding + b"\x00" + digest_info
    try:
        got = pow(int.from_bytes(signature, "big"), e, n).to_bytes(size, "big")
    except OverflowError:
        return False
    return got == expected


# --------------------------------------------------------------------------
# ZIP / digest plumbing
# --------------------------------------------------------------------------
@dataclass
class ZipInfoAtEocd:
    eocd_offset: int
    eocd_length: int
    cd_offset: int
    cd_size: int


def read_zip_info(fp, size: int) -> ZipInfoAtEocd:
    window = min(size, 65557)
    fp.seek(size - window)
    tail = fp.read(window)
    pos = tail.rfind(EOCD_MAGIC)
    if pos < 0:
        raise SignatureError("no end-of-central-directory record found")
    if pos + 22 > len(tail):
        raise SignatureError("truncated end-of-central-directory record")
    comment_len = struct.unpack_from("<H", tail, pos + 20)[0]
    if pos + 22 + comment_len != len(tail):
        raise SignatureError("APK has a broken comment length")
    eocd_offset = size - window + pos
    cd_size, cd_offset = struct.unpack_from("<II", tail, pos + 12)
    if cd_offset + cd_size != eocd_offset:
        raise SignatureError("central directory is not adjacent to the EOCD")
    if eocd_offset >= 20:
        fp.seek(eocd_offset - 20)
        if fp.read(4) == ZIP64_LOCATOR_MAGIC:
            raise SignatureError("ZIP64 APKs are not supported")
    return ZipInfoAtEocd(eocd_offset, size - eocd_offset, cd_offset, cd_size)


def _chunk_hash(chunk: bytes) -> bytes:
    return hashlib.sha256(b"\xa5" + struct.pack("<I", len(chunk)) + chunk).digest()


def _content_digest(fp, spans: list) -> bytes:
    """Hash the protected content.

    Each span is either ``(file_offset, length)`` or raw ``bytes`` (used for the
    EOCD, whose central-directory offset has to be adjusted before hashing).
    Chunks are 1 MB and run continuously across span boundaries.
    """
    chunk_digests: list[bytes] = []
    for span in spans:
        if isinstance(span, (bytes, bytearray)):
            blocks = iter([bytes(span)])
        else:
            blocks = _file_blocks(fp, *span)
        # Chunks are per segment: the 1 MB grid restarts at every span.
        pending = bytearray()
        for block in blocks:
            pending += block
            while len(pending) >= CHUNK_SIZE:
                chunk_digests.append(_chunk_hash(bytes(pending[:CHUNK_SIZE])))
                del pending[:CHUNK_SIZE]
        if pending:
            chunk_digests.append(_chunk_hash(bytes(pending)))
    digest = hashlib.sha256()
    digest.update(b"\x5a" + struct.pack("<I", len(chunk_digests)))
    for chunk_digest in chunk_digests:
        digest.update(chunk_digest)
    return digest.digest()


def _file_blocks(fp, offset: int, length: int):
    fp.seek(offset)
    remaining = length
    while remaining:
        block = fp.read(min(CHUNK_SIZE, remaining))
        if not block:
            raise SignatureError("unexpected end of APK while hashing")
        remaining -= len(block)
        yield block


def _lp(data: bytes) -> bytes:
    return struct.pack("<I", len(data)) + data


def _read_lp(buf: bytes, offset: int) -> tuple[bytes, int]:
    if offset + 4 > len(buf):
        raise SignatureError("truncated length-prefixed value")
    length = struct.unpack_from("<I", buf, offset)[0]
    start = offset + 4
    end = start + length
    if end > len(buf):
        raise SignatureError("truncated length-prefixed value")
    return buf[start:end], end


def _lp_sequence(items: list[bytes]) -> bytes:
    return struct.pack("<I", sum(len(i) for i in items)) + b"".join(items)


# --------------------------------------------------------------------------
# Signing
# --------------------------------------------------------------------------
def sign_v2(apk_path: Path, key: SigningKey) -> None:
    """Sign *apk_path* in place (v2 only), replacing any existing signature."""
    path = Path(apk_path)
    size = path.stat().st_size
    with path.open("rb") as fp:
        info = read_zip_info(fp, size)

        # Digests cover the file as it looks *before* the signing block exists,
        # with the EOCD pointing at where the block will start (== old CD offset).
        fp.seek(info.eocd_offset)
        eocd = fp.read(info.eocd_length)
        spans = [
            (0, info.cd_offset),
            (info.cd_offset, info.cd_size),
            eocd,
        ]
        digest = _content_digest(fp, spans)

        # Every record inside these sequences is itself length-prefixed.
        digest_record = _lp(struct.pack("<I", SIG_RSA_PKCS1_SHA256) + _lp(digest))
        signed_data = (
            _lp_sequence([digest_record])
            + _lp_sequence([_lp(key.cert_der)])
            + _lp_sequence([])
        )
        signature = _rsa_sign(signed_data, key)
        signature_record = _lp(struct.pack("<I", SIG_RSA_PKCS1_SHA256) + _lp(signature))
        signer = (
            _lp(signed_data)
            + _lp_sequence([signature_record])
            + _lp(key.spki_der)
        )
        v2_value = _lp_sequence([_lp(signer)])

        pairs = struct.pack("<Q", 4 + len(v2_value)) + struct.pack(
            "<I", V2_BLOCK_ID
        ) + v2_value
        block_size = len(pairs) + 8 + 16
        block = (
            struct.pack("<Q", block_size)
            + pairs
            + struct.pack("<Q", block_size)
            + SIGNING_BLOCK_MAGIC
        )

    new_cd_offset = info.cd_offset + len(block)
    tmp_path = path.with_name(path.name + ".signed")
    with path.open("rb") as src, tmp_path.open("wb") as dst:
        _copy_range(src, dst, 0, info.cd_offset)
        dst.write(block)
        src.seek(info.cd_offset)
        offset = info.cd_offset
        while offset < size:
            block_bytes = src.read(min(CHUNK_SIZE, size - offset))
            if not block_bytes:
                break
            data = bytearray(block_bytes)
            # The EOCD's central-directory offset has to skip the new block.
            start = info.eocd_offset - offset
            if start < len(data):
                struct.pack_into("<I", data, start + 16, new_cd_offset)
            dst.write(data)
            offset += len(block_bytes)
    os.replace(tmp_path, path)


def _copy_range(src, dst, start: int, end: int) -> None:
    src.seek(start)
    remaining = end - start
    while remaining:
        block = src.read(min(CHUNK_SIZE, remaining))
        if not block:
            raise SignatureError("unexpected end of file while copying")
        dst.write(block)
        remaining -= len(block)


# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------
def verify_v2(apk_path: Path) -> dict:
    """Verify the v2 signature block and the digests it protects."""
    path = Path(apk_path)
    size = path.stat().st_size
    with path.open("rb") as fp:
        info = read_zip_info(fp, size)
        if info.cd_offset < 32:
            raise SignatureError("APK is too small to be v2 signed")
        fp.seek(info.cd_offset - 24)
        footer = fp.read(24)
        if footer[8:] != SIGNING_BLOCK_MAGIC:
            raise SignatureError("no APK Signing Block found (unsigned or v1-only APK)")
        block_size = struct.unpack_from("<Q", footer, 0)[0]
        block_start = info.cd_offset - block_size - 8
        if block_start < 0:
            raise SignatureError("corrupt APK Signing Block size")
        fp.seek(block_start)
        block = fp.read(block_size + 8)
        if struct.unpack_from("<Q", block, 0)[0] != block_size:
            raise SignatureError("APK Signing Block sizes disagree")

        pairs = block[8 : 8 + block_size - 24]
        values: dict[int, bytes] = {}
        pos = 0
        while pos < len(pairs):
            pair_len = struct.unpack_from("<Q", pairs, pos)[0]
            pair_id = struct.unpack_from("<I", pairs, pos + 8)[0]
            values[pair_id] = pairs[pos + 12 : pos + 8 + pair_len]
            pos += 8 + pair_len

        if V2_BLOCK_ID not in values:
            raise SignatureError("no APK Signature Scheme v2 block")
        signers, _ = _read_lp(values[V2_BLOCK_ID], 0)
        if not signers:
            raise SignatureError("v2 block has no signers")

        signer, _ = _read_lp(signers, 0)
        signed_data, signer_pos = _read_lp(signer, 0)
        signatures, signer_pos = _read_lp(signer, signer_pos)
        public_key, _ = _read_lp(signer, signer_pos)

        digests, pos = _read_lp(signed_data, 0)
        certificates, pos = _read_lp(signed_data, pos)

        recorded: dict[int, bytes] = {}
        dpos = 0
        while dpos < len(digests):
            record, dpos = _read_lp(digests, dpos)
            algorithm = struct.unpack_from("<I", record, 0)[0]
            value, _ = _read_lp(record, 4)
            recorded[algorithm] = value

        sig_map: dict[int, bytes] = {}
        spos = 0
        while spos < len(signatures):
            record, spos = _read_lp(signatures, spos)
            algorithm = struct.unpack_from("<I", record, 0)[0]
            value, _ = _read_lp(record, 4)
            sig_map[algorithm] = value

        # Recompute the digest exactly the way a verifier does: the EOCD of the
        # signed APK claims a CD offset past the block; treat it as block_start.
        fp.seek(info.eocd_offset)
        eocd = bytearray(fp.read(info.eocd_length))
        struct.pack_into("<I", eocd, 16, block_start)
        expected = _content_digest(
            fp,
            [
                (0, block_start),
                (info.cd_offset, info.cd_size),
                bytes(eocd),
            ],
        )

    if SIG_RSA_PKCS1_SHA256 not in recorded:
        raise SignatureError("v2 block has no RSA/PKCS#1/SHA-256 digest")
    if recorded[SIG_RSA_PKCS1_SHA256] != expected:
        raise SignatureError("content digest does not match the signed digest")
    if SIG_RSA_PKCS1_SHA256 not in sig_map:
        raise SignatureError("v2 block has no RSA/PKCS#1/SHA-256 signature")

    cert_der, _ = _read_lp(certificates, 0)
    n, e = parse_rsa_public_key(_cert_public_key_der(cert_der))
    if not _rsa_verify(signed_data, sig_map[SIG_RSA_PKCS1_SHA256], n, e):
        raise SignatureError("v2 signature does not verify against the certificate")

    signer_n, signer_e = parse_rsa_public_key(_spki_public_key_der(public_key))
    if (signer_n, signer_e) != (n, e):
        raise SignatureError("v2 public key does not match the certificate")

    return {
        "scheme": "v2",
        "signer_pubkey_bits": n.bit_length(),
        "digest": recorded[SIG_RSA_PKCS1_SHA256].hex(),
        "certificate_sha256": hashlib.sha256(cert_der).hexdigest(),
    }


def _spki_public_key_der(spki_der: bytes) -> bytes:
    tag, start, length, _ = _tlv(spki_der, 0)
    if tag != 0x30:
        raise SignatureError("malformed public key")
    fields = _children(spki_der[start : start + length])
    if len(fields) < 2 or fields[1][0] != 0x03:
        raise SignatureError("malformed public key")
    return fields[1][1][1:]


def _cert_public_key_der(cert_der: bytes) -> bytes:
    tag, start, length, _ = _tlv(cert_der, 0)
    if tag != 0x30:
        raise SignatureError("malformed certificate")
    tbs = _children(cert_der[start : start + length])[0][1]
    fields = _children(tbs)
    if fields and fields[0][0] == 0xA0:
        fields = fields[1:]
    return _spki_public_key_der(fields[5][2])


# --------------------------------------------------------------------------
# Debug key material
# --------------------------------------------------------------------------
def ensure_debug_key(material_dir: Path) -> tuple[Path, Path]:
    """Return (key, cert), generating a throwaway key pair if it is missing."""
    key_path = material_dir / DEBUG_KEY_NAME
    cert_path = material_dir / DEBUG_CERT_NAME
    if key_path.is_file() and cert_path.is_file():
        return key_path, cert_path

    openssl = shutil.which("openssl")
    if not openssl:
        raise SignatureError(
            f"missing signing material in {material_dir} and openssl is not installed.\n"
            f"Restore {DEBUG_KEY_NAME}/{DEBUG_CERT_NAME} from the repository or install openssl."
        )
    material_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [openssl, "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048",
         "-out", str(key_path)],
        check=True, stdout=subprocess.DEVNULL,
    )
    subprocess.run(
        [openssl, "req", "-new", "-x509", "-key", str(key_path), "-out", str(cert_path),
         "-days", "36500", "-subj", "/CN=RPG2Android Debug/O=rpg2android"],
        check=True, stdout=subprocess.DEVNULL,
    )
    return key_path, cert_path
