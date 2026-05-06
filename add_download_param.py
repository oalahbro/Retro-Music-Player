#!/usr/bin/env python3
"""
Append `&export=download&authuser=0` to every Google Drive URL line in an
m3u playlist. Idempotent (skips lines that already have the suffix).

Usage:
    python add_download_param.py <path-to-m3u>

Creates a one-time backup at <path>.bak (only if it doesn't already exist).
"""

import re
import sys
from pathlib import Path

SUFFIX = b'&export=download&authuser=0'
URL_PATTERN = re.compile(
    rb'https://drive\.usercontent\.google\.com/download\?id=[^\r\n]+'
)


def main(path_str: str) -> None:
    path = Path(path_str)
    if not path.exists():
        print(f'ERROR: file not found: {path}', file=sys.stderr)
        sys.exit(1)

    backup = path.with_suffix(path.suffix + '.bak')
    original = path.read_bytes()

    if not backup.exists():
        backup.write_bytes(original)
        print(f'Backup created: {backup}')
    else:
        print(f'Backup already exists (not overwriting): {backup}')

    total = 0
    skipped = 0
    appended = 0

    def replace(m: re.Match) -> bytes:
        nonlocal total, skipped, appended
        total += 1
        line = m.group(0)
        if SUFFIX in line:
            skipped += 1
            return line
        appended += 1
        return line + SUFFIX

    new_content = URL_PATTERN.sub(replace, original)

    if new_content == original:
        print(f'No changes (matched {total} URLs, all already had suffix)')
    else:
        path.write_bytes(new_content)
        print(f'Updated: {path}')

    print(f'  total URLs matched: {total}')
    print(f'  appended suffix:    {appended}')
    print(f'  already had suffix: {skipped}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('Usage: python add_download_param.py <path-to-m3u>', file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1])
