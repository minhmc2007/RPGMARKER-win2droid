#!/usr/bin/env python3
"""Minimal reader/writer for Android binary XML (AXML).

Reads the string pool, walks the element tree and points attributes at strings.
Elements and attributes keep their exact layout; only the string pool changes.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass

XML_TYPE = 0x0003
STRING_POOL_TYPE = 0x0001
START_ELEMENT_TYPE = 0x0102

UTF8_FLAG = 1 << 8
NO_ENTRY = 0xFFFFFFFF
TYPE_STRING = 0x03
TYPE_INT_DEC = 0x10

ANDROID_NS = "http://schemas.android.com/apk/res/android"

# android:screenOrientation / ActivityInfo.SCREEN_ORIENTATION_*
ORIENTATIONS = {
    "unspecified": -1,
    "landscape": 0,
    "portrait": 1,
    "user": 2,
    "behind": 3,
    "sensor": 4,
    "nosensor": 5,
    "sensorLandscape": 6,
    "sensorPortrait": 7,
    "reverseLandscape": 8,
    "reversePortrait": 9,
    "fullSensor": 10,
    "userLandscape": 11,
    "userPortrait": 12,
    "fullUser": 13,
    "locked": 14,
}


class AxmlError(RuntimeError):
    pass


def _read_len8(buf, pos: int) -> tuple[int, int]:
    value = buf[pos]
    if value & 0x80:
        return ((value & 0x7F) << 8) | buf[pos + 1], pos + 2
    return value, pos + 1


def _read_len16(buf, pos: int) -> tuple[int, int]:
    value = struct.unpack_from("<H", buf, pos)[0]
    if value & 0x8000:
        low = struct.unpack_from("<H", buf, pos + 2)[0]
        return ((value & 0x7FFF) << 16) | low, pos + 4
    return value, pos + 2


def _write_len8(value: int) -> bytes:
    if value > 0x7FFF:
        raise AxmlError(f"string too long for a UTF-8 pool: {value}")
    if value > 0x7F:
        return bytes(((value >> 8) | 0x80, value & 0xFF))
    return bytes((value,))


def _write_len16(value: int) -> bytes:
    if value > 0x7FFFFFFF:
        raise AxmlError(f"string too long for a UTF-16 pool: {value}")
    if value > 0x7FFF:
        return struct.pack("<HH", (value >> 16) | 0x8000, value & 0xFFFF)
    return struct.pack("<H", value)


class StringPool:
    def __init__(self, chunk: bytes) -> None:
        res_type, header_size, chunk_size = struct.unpack_from("<HHI", chunk, 0)
        if res_type != STRING_POOL_TYPE:
            raise AxmlError("first chunk is not a string pool")
        count, style_count, flags, strings_start, styles_start = struct.unpack_from(
            "<IIIII", chunk, 8
        )
        self.utf8 = bool(flags & UTF8_FLAG)
        self.style_count = style_count
        offsets = struct.unpack_from("<%dI" % count, chunk, header_size)
        self.strings = [self._decode(chunk, strings_start + off) for off in offsets]
        self.style_offsets = b""
        self.style_data = b""
        if style_count:
            self.style_offsets = chunk[
                header_size + 4 * count : header_size + 4 * (count + style_count)
            ]
            self.style_data = chunk[styles_start:chunk_size]

    def _decode(self, chunk: bytes, pos: int) -> str:
        if self.utf8:
            _, pos = _read_len8(chunk, pos)          # length in UTF-16 code units
            nbytes, pos = _read_len8(chunk, pos)     # length in UTF-8 bytes
            return chunk[pos : pos + nbytes].decode("utf-8", "replace")
        length, pos = _read_len16(chunk, pos)
        return chunk[pos : pos + length * 2].decode("utf-16-le", "replace")

    def index_of(self, text: str) -> int | None:
        try:
            return self.strings.index(text)
        except ValueError:
            return None

    def add(self, text: str) -> int:
        existing = self.index_of(text)
        if existing is not None:
            return existing
        self.strings.append(text)
        return len(self.strings) - 1

    def serialize(self) -> bytes:
        data = bytearray()
        offsets: list[int] = []
        for text in self.strings:
            offsets.append(len(data))
            if self.utf8:
                raw = text.encode("utf-8")
                data += _write_len8(len(text.encode("utf-16-le")) // 2)
                data += _write_len8(len(raw))
                data += raw + b"\x00"
            else:
                raw = text.encode("utf-16-le")
                data += _write_len16(len(raw) // 2)
                data += raw + b"\x00\x00"
        while len(data) % 4:  # keep the pool 4-byte aligned, like aapt
            data.append(0)

        header_size = 28
        strings_start = header_size + 4 * (len(self.strings) + self.style_count)
        styles_start = strings_start + len(data) if self.style_count else 0
        total = strings_start + len(data) + len(self.style_data)

        out = bytearray()
        out += struct.pack("<HHI", STRING_POOL_TYPE, header_size, total)
        out += struct.pack(
            "<IIIII",
            len(self.strings),
            self.style_count,
            UTF8_FLAG if self.utf8 else 0,
            strings_start,
            styles_start,
        )
        out += struct.pack("<%dI" % len(offsets), *offsets)
        out += self.style_offsets
        out += data
        out += self.style_data
        return bytes(out)


@dataclass
class Attribute:
    ns: int
    name: int
    raw: int
    data_type: int
    data: int
    offset: int  # byte offset of the attribute struct inside the node area


@dataclass
class Element:
    name: int
    attributes: list[Attribute]
    offset: int


class AxmlDoc:
    def __init__(self, data: bytes) -> None:
        if len(data) < 8:
            raise AxmlError("truncated binary XML")
        res_type, header_size, _total = struct.unpack_from("<HHI", data, 0)
        if res_type != XML_TYPE:
            raise AxmlError("not a binary XML document")
        if header_size < 8:
            raise AxmlError("unexpected XML header size")
        chunk_type, _chunk_header_size, chunk_size = struct.unpack_from("<HHI", data, header_size)
        if chunk_type != STRING_POOL_TYPE:
            raise AxmlError("binary XML does not start with a string pool")
        self.header = data[:header_size]
        self.pool = StringPool(data[header_size : header_size + chunk_size])
        self.rest = bytearray(data[header_size + chunk_size :])
    def string_at(self, index: int) -> str:
        if index == NO_ENTRY or index >= len(self.pool.strings):
            return ""
        return self.pool.strings[index]

    def index_of(self, text: str) -> int | None:
        return self.pool.index_of(text)

    def add_string(self, text: str) -> int:
        return self.pool.add(text)
    def iter_elements(self) -> list[Element]:
        elements: list[Element] = []
        buf = self.rest
        pos = 0
        while pos + 8 <= len(buf):
            node_type, _header_size, size = struct.unpack_from("<HHI", buf, pos)
            if size < 8 or pos + size > len(buf):
                break
            if node_type == START_ELEMENT_TYPE and size >= 36:
                _ns, name = struct.unpack_from("<II", buf, pos + 16)
                attr_start, attr_size, attr_count = struct.unpack_from("<HHH", buf, pos + 24)
                attributes = []
                base = pos + 16 + attr_start
                for i in range(attr_count):
                    off = base + i * attr_size
                    if off + 20 > len(buf):
                        break
                    ans, aname, raw = struct.unpack_from("<III", buf, off)
                    attributes.append(
                        Attribute(
                            ns=ans,
                            name=aname,
                            raw=raw,
                            data_type=buf[off + 15],
                            data=struct.unpack_from("<I", buf, off + 16)[0],
                            offset=off,
                        )
                    )
                elements.append(Element(name=name, attributes=attributes, offset=pos))
            pos += size
        return elements

    def find_attribute(self, element: Element, attr_name: str, ns_uri: str | None) -> Attribute | None:
        """Find an attribute by name. ns_uri None means no namespace."""
        ns_index = self.index_of(ns_uri) if ns_uri else NO_ENTRY
        for attr in element.attributes:
            if attr.ns != ns_index:
                continue
            if self.string_at(attr.name) == attr_name:
                return attr
        return None
    def set_attribute_string(self, attr: Attribute, text: str) -> None:
        index = self.add_string(text)
        struct.pack_into("<I", self.rest, attr.offset + 8, index)   # rawValue
        self.rest[attr.offset + 15] = TYPE_STRING                   # typedValue.dataType
        struct.pack_into("<I", self.rest, attr.offset + 16, index)  # typedValue.data

    def set_attribute_int(self, attr: Attribute, value: int) -> None:
        struct.pack_into("<I", self.rest, attr.offset + 8, NO_ENTRY)
        self.rest[attr.offset + 15] = TYPE_INT_DEC
        struct.pack_into("<i", self.rest, attr.offset + 16, value)

    def serialize(self) -> bytes:
        out = bytearray(self.header)
        out += self.pool.serialize()
        out += self.rest
        struct.pack_into("<I", out, 4, len(out))
        return bytes(out)


def patch_manifest(
    data: bytes,
    package: str | None = None,
    label: str | None = None,
    orientation: str | None = None,
) -> bytes:
    """Patch package, label and orientation in a binary AndroidManifest.xml."""
    doc = AxmlDoc(data)
    if orientation is not None and orientation not in ORIENTATIONS:
        raise AxmlError(
            f"unknown orientation {orientation!r}; expected one of "
            + ", ".join(sorted(ORIENTATIONS))
        )

    saw_manifest = saw_application = saw_activity = False
    for element in doc.iter_elements():
        name = doc.string_at(element.name)
        if name == "manifest":
            saw_manifest = True
            if package:
                attr = doc.find_attribute(element, "package", None)
                if attr is None:
                    raise AxmlError("<manifest> has no package attribute to patch")
                doc.set_attribute_string(attr, package)
        elif name == "application":
            saw_application = True
            if label:
                attr = doc.find_attribute(element, "label", ANDROID_NS)
                if attr is None:
                    raise AxmlError("<application> has no android:label attribute to patch")
                doc.set_attribute_string(attr, label)
        elif name == "activity" and orientation:
            attr = doc.find_attribute(element, "screenOrientation", ANDROID_NS)
            if attr is not None:
                saw_activity = True
                doc.set_attribute_int(attr, ORIENTATIONS[orientation])

    if not saw_manifest:
        raise AxmlError("no <manifest> element found")
    if label and not saw_application:
        raise AxmlError("no <application> element found")
    if orientation and not saw_activity:
        raise AxmlError("no <activity android:screenOrientation> attribute to patch")
    return doc.serialize()


def read_manifest(data: bytes) -> dict[str, object]:
    """Read package, label and orientation. Used by the tests."""
    doc = AxmlDoc(data)
    info: dict[str, object] = {}
    for element in doc.iter_elements():
        name = doc.string_at(element.name)
        if name == "manifest":
            attr = doc.find_attribute(element, "package", None)
            if attr is not None:
                info["package"] = doc.string_at(attr.data)
        elif name == "application":
            attr = doc.find_attribute(element, "label", ANDROID_NS)
            if attr is not None:
                info["label"] = (
                    doc.string_at(attr.data) if attr.data_type == TYPE_STRING else attr.data
                )
        elif name == "activity":
            attr = doc.find_attribute(element, "screenOrientation", ANDROID_NS)
            if attr is not None:
                info["orientation"] = attr.data
    return info


if __name__ == "__main__":
    import sys

    path = sys.argv[1]
    with open(path, "rb") as fh:
        print(read_manifest(fh.read()))
