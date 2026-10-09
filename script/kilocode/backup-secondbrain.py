"""Copy SecondBrain sources and capture recovery inputs; never restore live state."""

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import uuid


def read(file):
    with file.open("rb") as stream:
        raw = stream.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Source exceeds the bounded snapshot size")
    return raw


def inventory(root):
    files = {}
    for file in sorted(root.rglob("*")):
        if file.is_symlink() or file.is_junction():
            raise ValueError("Linked sources require separate review")
        if not file.is_file():
            continue
        name = file.relative_to(root).as_posix()
        journal = name.startswith("System/Changes/") and (
            file.name == "manifest.json" or re.fullmatch(r"source-\d+\.txt", file.name)
        )
        capture = re.fullmatch(
            r"System/Capture/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/(?:input|request)\.json", name
        )
        if file.suffix.lower() != ".md" and file.name != ".rayaignore" and not journal and not capture:
            continue
        raw = read(file)
        files[name] = {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    if not files:
        raise ValueError("Source inventory is empty")
    return files


def backup(root, dest):
    if root.is_symlink() or root.is_junction():
        raise ValueError("Linked source root requires separate review")
    root = root.resolve(strict=True)
    dest = dest.resolve()
    if dest == root or root in dest.parents or dest in root.parents:
        raise ValueError("Backup must be separate from live notes")
    files = inventory(root)
    dest.mkdir(parents=True, exist_ok=False)
    for name, pin in files.items():
        raw = read(root / name)
        if len(raw) != pin["bytes"] or hashlib.sha256(raw).hexdigest() != pin["sha256"]:
            raise ValueError("Source changed before copying")
        copy = dest / "Files" / name
        copy.parent.mkdir(parents=True, exist_ok=True)
        with copy.open("xb") as stream:
            stream.write(raw)
        saved = read(copy)
        if len(saved) != pin["bytes"] or hashlib.sha256(saved).hexdigest() != pin["sha256"]:
            raise ValueError("Copied source differs")
    if inventory(root) != files:
        raise ValueError("Source inventory changed during copying; snapshot is incomplete")
    manifest = {
        "status": "stable_source_copy_verified",
        "source": str(root),
        "path": str(dest),
        "files": files,
        "count": len(files),
        "bytes": sum(pin["bytes"] for pin in files.values()),
        "scope": "Markdown, .rayaignore, note-change manifests/text and original capture input/request JSON",
        "live_restore": False,
        "off_pc_backup": False,
    }
    with (dest / "manifest.json").open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(manifest, indent=2) + "\n")
    (dest / "RESTORE.md").write_text(
        "# SecondBrain source recovery\n\n"
        "Stage Files into a separate new directory and verify every path, size and SHA-256 in manifest.json. "
        "Never overwrite healthy live notes. Preserve pending capture inputs and request records; copying them "
        "does not settle uncertainty or authorize replay. Use supported recovery before indexing. "
        "Indexes, service credentials, operation debt and binary media are excluded. "
        "A source copy does not prove installed recall or off-PC disaster recovery.\n",
        encoding="utf-8",
    )
    return {key: value for key, value in manifest.items() if key != "files"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("D:/Raya/SecondBrain"))
    parser.add_argument("--destination", type=Path)
    args = parser.parse_args()
    dest = args.destination or Path("D:/RayaBackups") / (
        "SecondBrain-Sources-" + datetime.now().strftime("%Y%m%d") + "-" + uuid.uuid4().hex[:8]
    )
    print(json.dumps(backup(args.root, dest), indent=2))
