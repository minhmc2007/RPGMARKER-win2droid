#!/usr/bin/env python3
"""Read the template APK, write a new one with game files injected.

Kept deliberately small: preserve compression of copied entries, store media
files (they are already compressed) and 4-byte align stored entries so Android
can mmap them.
"""
from __future__ import annotations

import struct
import zipfile
from pathlib import Path

STORE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ogg", ".m4a", ".mp3",
    ".wav", ".mp4", ".webm", ".zip", ".woff", ".woff2", ".ttf", ".otf", ".pak",
}

ALIGNMENT = 4
EXTRA_ID_PADDING = 0xD935  # what zipalign uses


class ApkZipError(RuntimeError):
    pass


def compression_for(name: str) -> int:
    suffix = Path(name).suffix.lower()
    return zipfile.ZIP_STORED if suffix in STORE_EXTENSIONS else zipfile.ZIP_DEFLATED


class ApkWriter:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.zip = zipfile.ZipFile(self.path, "w", compression=zipfile.ZIP_DEFLATED,
                                   allowZip64=False)
        self._entries = 0

    # -- internals --------------------------------------------------------
    def _padding_extra(self, name: str, stored: bool) -> bytes:
        if not stored or self.zip.fp is None:
            return b""
        offset = self.zip.fp.tell()
        name_len = len(name.encode("utf-8"))
        pad = (-(offset + 30 + name_len + 4)) % ALIGNMENT
        # 4 bytes of header (id + length) plus the padding bytes themselves.
        return struct.pack("<HH", EXTRA_ID_PADDING, pad) + b"\x00" * pad

    def _add(self, name: str, data: bytes, compress_type: int | None = None) -> None:
        if name.endswith("/"):
            return
        compress_type = compression_for(name) if compress_type is None else compress_type
        info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
        info.compress_type = compress_type
        info.external_attr = 0o644 << 16
        info.extra = self._padding_extra(name, compress_type == zipfile.ZIP_STORED)
        self.zip.writestr(info, data)
        self._entries += 1

    # -- public API -------------------------------------------------------
    def add_bytes(self, name: str, data: bytes, compress_type: int | None = None) -> None:
        self._add(name, data, compress_type)

    def add_file(self, path: Path, arcname: str) -> None:
        data = Path(path).read_bytes()
        self._add(arcname, data, compression_for(arcname))

    def copy_from(self, source: Path, skip) -> None:
        """Copy every entry of *source* for which ``skip(name)`` is False."""
        with zipfile.ZipFile(source) as zin:
            for info in zin.infolist():
                if info.is_dir() or skip(info.filename):
                    continue
                self.add_bytes(info.filename, zin.read(info.filename), info.compress_type)

    def close(self) -> None:
        self.zip.close()
        if self._entries > 0xFFFF:
            raise ApkZipError(
                f"{self._entries} entries in one APK; ZIP64 is not supported by the "
                "v2 signer, split the game or drop unused assets"
            )
