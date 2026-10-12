"""Audit src/lib/strings.zh.ts against every t('...') the app renders.

A used key with no entry silently falls back to English, so that is an error
(non-zero exit). Entries nothing looks up are reported as stale -- a renamed
string is how a translation quietly rots.

    python tools/check_i18n.py [--unused]
"""

import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
DICT = SRC / "lib" / "strings.zh.ts"

# Rendered verbatim in both languages, or assembled from data at the call site.
VERBATIM = {"CSV", "JSONL", "errors: "}
HEADER = re.compile(r"\b(?:label|k):\s*'([^']*)'")
DYNAMIC = {"c.label", "f.label", "k", "l.label", "stepLabel(s)", "stepLabel(step)"}

CALL = re.compile(r"\b(?:t|tGlobal)\(\s*'([^']*)'")
BRANCH = re.compile(r"\b(?:t|tGlobal)\(\s*[^'\"()]*\?\s*'([^']*)'\s*:\s*'([^']*)'")


def used():
    found = {}
    for path in sorted(list(SRC.rglob("*.tsx")) + list(SRC.rglob("*.ts"))):
        if path.name.startswith("strings.") or path.name == "i18n.tsx":
            continue
        rel = path.relative_to(ROOT).as_posix()
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for m in CALL.finditer(line):
                found.setdefault(m.group(1), f"{rel}:{n}")
            for m in HEADER.finditer(line):
                found.setdefault(m.group(1), f"{rel}:{n}")
            for m in BRANCH.finditer(line):
                for key in m.groups():
                    found.setdefault(key, f"{rel}:{n}")
    return found


def dictionary():
    parts = DICT.read_text(encoding="utf-8").split("`")
    if len(parts) < 3:
        raise SystemExit(f"{DICT.name}: expected a backtick-quoted table")
    entries, dups = {}, []
    for line in parts[1].splitlines():
        row = line.strip()
        eq = row.find("=")
        if eq <= 0:
            continue
        for key in row[:eq].split("|"):
            key = key.strip()
            if key in entries:
                dups.append(key)
            entries[key] = row[eq + 1 :]
    return entries, dups


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--unused", action="store_true", help="list unreferenced entries")
    args = ap.parse_args()

    used_keys, (entries, dups) = used(), dictionary()
    missing = sorted(k for k in used_keys if k not in entries and k not in VERBATIM)
    unused = sorted(k for k in entries if k not in used_keys and k not in DYNAMIC)

    print(
        f"used={len(used_keys)}  dict={len(entries)}  missing={len(missing)}  "
        f"unused={len(unused)}  duplicates={len(set(dups))}"
    )
    if missing:
        print("\nMISSING -- these render in English:")
        for key in missing:
            print(f"  {key!r:52} {used_keys[key]}")
    if dups:
        print("\nDUPLICATE -- last one wins:")
        for key in sorted(set(dups)):
            print(f"  {key!r}")
    if args.unused and unused:
        print("\nUNUSED -- entries nothing looks up:")
        for key in unused:
            print(f"  {key!r}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())