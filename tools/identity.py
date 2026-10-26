#!/usr/bin/env python3
"""Detect an RPG Maker MV/MZ game folder and derive its Android identity.

The application name comes from the *game root folder* (the folder that holds
index.html), never from its parent. The application id is
``com.<random-ish>.<gamename-slug>`` where the random-looking part is a stable
hash of the name, so rebuilding the same game keeps the same package id.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

# Files that prove a folder is the root of an RPG Maker MV/MZ deployment.
RUNTIME_FILES = {"game.exe", "nw.dll", "node.dll", "package.json", "credits.html"}


class IdentityError(RuntimeError):
    pass


def _entries(path: Path) -> list[Path]:
    try:
        return list(path.iterdir())
    except OSError as exc:  # permission problems etc.
        raise IdentityError(f"cannot list {path}: {exc}") from exc


def _names(path: Path) -> set[str]:
    return {p.name.lower() for p in _entries(path)}


def is_game_dir(path: Path) -> bool:
    """True when *path* looks like an RPG Maker MV/MZ content folder."""
    if not path.is_dir():
        return False
    names = _names(path)
    if "index.html" not in names:
        return False
    if "js" in names and (path / "js").is_dir():
        return True
    return bool(names & RUNTIME_FILES)


def display_name(folder_name: str) -> str:
    """Turn a folder name into something presentable on a launcher."""
    name = unicodedata.normalize("NFC", folder_name).strip()
    # Trailing "_", "-" or spaces are very common on extracted archives.
    name = re.sub(r"[\s_\-]+$", "", name)
    # Drop a leading "[group]" / "(group)" tag, e.g. "[Kimochi] ...".
    stripped = re.sub(r"^[\[(][^\])]*[\])]+\s*", "", name)
    if stripped:
        name = stripped
    name = re.sub(r"\s+", " ", name).strip()
    return name or "RPG Maker Game"


def slugify(name: str) -> str:
    """ASCII, lowercase, no spaces - a valid Java package segment."""
    ascii_name = (
        unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    )
    slug = re.sub(r"[^a-z0-9]", "", ascii_name.lower())
    if not slug:
        # Non-latin title: keep it unique without inventing a translation.
        slug = "game" + hashlib.sha256(name.encode("utf-8")).hexdigest()[:6]
    if slug[0].isdigit():
        slug = "g" + slug
    return slug[:40]


def random_part(name: str) -> str:
    """Stable, random-looking, always letters (package segments cannot start
    with a digit, and eyeballing hex gets confusing)."""
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:8]
    return "".join(chr(ord("a") + int(ch, 16)) for ch in digest)


def make_package_id(name: str, slug: str | None = None) -> str:
    slug = slug or slugify(name)
    return f"com.{random_part(name)}.{slug}"


@dataclass
class Game:
    root: Path | None      # folder used for the name (None in name-only mode)
    content: Path | None   # folder that contains index.html
    name: str
    package_id: str

    @property
    def slug(self) -> str:
        return self.package_id.rsplit(".", 1)[-1]

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "slug": self.slug,
            "package_id": self.package_id,
            "root": str(self.root) if self.root else "",
            "content": str(self.content) if self.content else "",
        }


def _pick_root(children: list[Path]) -> Path | None:
    candidates = [c for c in children if is_game_dir(c)]
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]

    def score(path: Path) -> tuple[int, int]:
        names = _names(path)
        # Prefer a Windows export (has the NW.js runtime) and the biggest
        # index.html, which is usually the real game rather than a launcher.
        runtime = 1 if names & RUNTIME_FILES else 0
        try:
            size = (path / "index.html").stat().st_size
        except OSError:
            size = 0
        return runtime, size

    return max(candidates, key=score)


def resolve(game_dir: str | Path | None, name: str | None = None,
            package_id: str | None = None) -> Game:
    """Find the game root inside *game_dir* and build its identity.

    *game_dir* may be None when only a name is known (GitHub Actions has no
    game files in the repository).
    """
    if game_dir is None:
        if not name:
            raise IdentityError("--name is required when no game folder is given")
        game_name = display_name(name)
        return Game(
            root=None,
            content=None,
            name=game_name,
            package_id=package_id or make_package_id(game_name),
        )

    path = Path(game_dir).expanduser()
    if not path.exists():
        raise IdentityError(f"game folder not found: {path}")
    if not path.is_dir():
        raise IdentityError(f"not a folder: {path}")
    path = path.resolve()

    if is_game_dir(path):
        root = path
    else:
        root = _pick_root(_entries(path))
        if root is None:
            raise IdentityError(
                f"{path} does not contain an RPG Maker game.\n"
                "Point --game-dir at the folder with index.html (or at its parent)."
            )

    # Older MV exports wrap the game in a "www" folder.
    content = root
    if not (content / "index.html").is_file() and (content / "www" / "index.html").is_file():
        content = content / "www"

    game_name = display_name(name) if name else display_name(root.name)
    slug = slugify(game_name)
    return Game(
        root=root,
        content=content,
        name=game_name,
        package_id=package_id or make_package_id(game_name, slug),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--game-dir", help="game folder or its parent")
    parser.add_argument("--name-only", action="store_true",
                        help="derive the identity from --name without a game folder")
    parser.add_argument("--name", help="override the detected application name")
    parser.add_argument("--package", dest="package_id", help="override the application id")
    parser.add_argument("--json", action="store_true", help="print everything as JSON")
    parser.add_argument("--field",
                        choices=["name", "slug", "package_id", "root", "content"],
                        help="print a single value")
    args = parser.parse_args(argv)

    if not args.game_dir and not args.name_only:
        parser.error("--game-dir is required (or --name-only with --name)")
    try:
        game = resolve(args.game_dir, args.name, args.package_id)
    except IdentityError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.field:
        print(game.as_dict()[args.field])
    elif args.json:
        print(json.dumps(game.as_dict(), indent=2, ensure_ascii=False))
    else:
        print(f"name:       {game.name}")
        print(f"package id: {game.package_id}")
        print(f"root:       {game.root}")
        print(f"content:    {game.content}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
