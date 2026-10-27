"""Stamps the version from a release tag into src/tgbp_kit/_version.py.

The repo carries 0.0.0; publish-python.yml runs this before it verifies and
publishes, so the tag is the only source of the published version.

    python python/scripts/stamp_version.py python-v1.2.3     (or python-v1.2.3rc1 for a prerelease)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# PEP 440 release and pre-release versions only, behind the python-v prefix.
TAG = re.compile(r"python-v((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)((a|b|rc)(0|[1-9][0-9]*))?)")
VERSION_FILE = Path(__file__).resolve().parent.parent / "src" / "tgbp_kit" / "_version.py"


def main() -> int:
    tag = sys.argv[1] if len(sys.argv) > 1 else ""
    match = TAG.fullmatch(tag)
    if not match:
        print(f"stamp_version: '{tag}' is not a release tag of the form python-vX.Y.Z", file=sys.stderr)
        return 1
    version = match.group(1)
    text = VERSION_FILE.read_text()
    stamped = re.sub(r'__version__ = "[^"]*"', f'__version__ = "{version}"', text)
    if stamped == text and f'"{version}"' not in text:
        print("stamp_version: no __version__ line to stamp", file=sys.stderr)
        return 1
    VERSION_FILE.write_text(stamped)
    # The only stdout, so a workflow can capture the version.
    print(version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
