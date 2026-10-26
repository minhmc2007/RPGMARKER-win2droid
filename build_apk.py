#!/usr/bin/env python3
"""Turn an RPG Maker MV/MZ (Windows) game folder into an installable APK.

This script never builds an Android app. It takes the empty WebView APK that
GitHub Actions produced (prebuilt/base.apk), rewrites its AndroidManifest.xml,
drops the game into assets/www/, and re-signs everything with the debug key.

    python build_apk.py --game-dir "../[Kimochi] RJ01610452 EN"
    python build_apk.py --game-dir "/path/to/Game" --name "My Game" --orientation portrait
"""
from __future__ import annotations

import argparse
import re
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tools import apkzip, axml, identity, signer  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_TEMPLATE = REPO_ROOT / "prebuilt" / "base.apk"
DEFAULT_KEY_DIR = REPO_ROOT / "tools" / "debug"

# NW.js / Chromium runtime, never needed by the web layer.
SKIP_DIRS = {"swiftshader", "locales", "gameupdate", "node_modules", "__pycache__"}
SKIP_SUFFIXES = {".exe", ".dll", ".bat", ".cmd", ".sh", ".pak", ".log"}
SKIP_FILES = {"icudtl.dat", "v8_context_snapshot.bin", "debug.log"}

MAX_ENTRY_BYTES = 0xFFFFFFFF - 1
MAX_TOTAL_BYTES = 3_800_000_000


class BuildError(RuntimeError):
    pass


def _skip_template_entry(name: str) -> bool:
    return name.startswith(("META-INF/", "assets/www/"))


def _iter_game_files(content: Path):
    for path in sorted(content.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(content)
        if any(part.lower() in SKIP_DIRS for part in rel.parts[:-1]):
            continue
        if path.suffix.lower() in SKIP_SUFFIXES or path.name.lower() in SKIP_FILES:
            continue
        yield path, rel


def _find_game_icon(content: Path) -> Path | None:
    for candidate in ("icon/icon.png", "icon/Icon.png", "www/icon/icon.png"):
        path = content / candidate
        if path.is_file():
            return path
    return None


def inject(
    template: Path,
    game: identity.Game,
    output: Path,
    orientation: str | None = None,
    icon: str = "auto",
) -> dict:
    if not template.is_file():
        raise BuildError(
            f"template APK not found: {template}\n"
            "Build it once from GitHub: Actions -> 'Build template APK' -> Run workflow.\n"
            "The workflow commits the result to prebuilt/base.apk."
        )

    icon_bytes = None
    icon_source = None
    if icon != "none":
        icon_path = Path(icon) if icon != "auto" else _find_game_icon(game.content)
        if icon_path and Path(icon_path).is_file():
            icon_bytes = Path(icon_path).read_bytes()
            icon_source = str(icon_path)
        elif icon != "auto":
            raise BuildError(f"icon not found: {icon}")

    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    stats = {"files": 0, "bytes": 0, "icon": icon_source}
    writer = apkzip.ApkWriter(output)
    try:
        with zipfile.ZipFile(template) as zin:
            for info in zin.infolist():
                name = info.filename
                if info.is_dir() or _skip_template_entry(name):
                    continue
                data = zin.read(name)
                if name == "AndroidManifest.xml":
                    data = axml.patch_manifest(
                        data,
                        package=game.package_id,
                        label=game.name,
                        orientation=orientation,
                    )
                elif icon_bytes is not None and re.fullmatch(
                    r"res/mipmap[^/]*/ic_launcher\.png", name
                ):
                    data = icon_bytes
                writer.add_bytes(name, data, info.compress_type)

        for path, rel in _iter_game_files(game.content):
            size = path.stat().st_size
            if size > MAX_ENTRY_BYTES:
                raise BuildError(f"file too large for a ZIP32 APK: {rel} ({size} bytes)")
            stats["bytes"] += size
            if stats["bytes"] > MAX_TOTAL_BYTES:
                raise BuildError(
                    "game is larger than ~3.8 GB, which does not fit in a ZIP32 APK. "
                    "Remove unused assets (audio/images) and retry."
                )
            writer.add_file(path, "assets/www/" + rel.as_posix())
            stats["files"] += 1
    finally:
        writer.close()

    return stats


def build(args: argparse.Namespace) -> int:
    started = time.time()
    game = identity.resolve(args.game_dir, args.name, args.package_id)
    template = Path(args.apk).expanduser().resolve()
    output = Path(args.out).expanduser().resolve() / f"{game.slug}.apk"
    key_dir = Path(args.key_dir).expanduser().resolve()

    print(f"game:       {game.name}")
    print(f"package id: {game.package_id}")
    print(f"source:     {game.content}")
    print(f"template:   {template}")

    if args.dry_run:
        print(f"output:     {output} (dry run, nothing written)")
        return 0

    stats = inject(template, game, output, orientation=args.orientation, icon=args.icon)
    print(f"injected:   {stats['files']} files, {stats['bytes'] / 1e6:.1f} MB"
          + (f", icon {stats['icon']}" if stats["icon"] else ""))

    key_path, cert_path = signer.ensure_debug_key(key_dir)
    key = signer.load_key(key_path, cert_path)
    signer.sign_v2(output, key)
    info = signer.verify_v2(output)

    print(
        f"manifest:   label={game.name!r} package={game.package_id!r}"
        + (f" orientation={args.orientation}" if args.orientation else "")
    )
    print(f"signed:     v2, {info['signer_pubkey_bits']} bit RSA (debug key)")
    print(f"output:     {output} ({output.stat().st_size / 1e6:.1f} MB)")
    print(f"done in     {time.time() - started:.1f}s")
    print()
    print(f"install with: adb install -r \"{output.name}\"")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Inject an RPG Maker game into the prebuilt WebView APK.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--game-dir", required=True,
                        help="game folder, or the folder containing it")
    parser.add_argument("--apk", default=str(DEFAULT_TEMPLATE),
                        help="template APK built by the GitHub workflow")
    parser.add_argument("--out", default=str(REPO_ROOT / "dist"),
                        help="output directory")
    parser.add_argument("--name", help="override the application name")
    parser.add_argument("--package", dest="package_id",
                        help="override the application id")
    parser.add_argument("--orientation", choices=sorted(axml.ORIENTATIONS),
                        help="override the screen orientation baked into the template")
    parser.add_argument("--icon", default="auto",
                        help="'auto' (game icon/icon.png), 'none', or a PNG path")
    parser.add_argument("--key-dir", default=str(DEFAULT_KEY_DIR),
                        help="directory holding debug.key.pem / debug.cert.pem")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the detected identity and exit")
    args = parser.parse_args(argv)

    try:
        return build(args)
    except (BuildError, identity.IdentityError, axml.AxmlError, apkzip.ApkZipError,
            signer.SignatureError) as exc:
        print(f"\nerror: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
