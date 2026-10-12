#!/usr/bin/env python3
"""Validate a trace file against the canonical format.

    python tools/validate_trace.py path/to/session.jsonl [more.jsonl ...]
    python tools/validate_trace.py --strict path/to/session.jsonl

The point of this tool is to catch an adapter that produced something *almost*
right. A converter that drops a timestamp or forgets to pair a tool call with
its result does not crash the viewer; it renders a session that looks plausible
and reports numbers that are quietly wrong. That is the failure mode worth
spending a validator on, so the checks below are about structure and
cross-references rather than about schema conformance for its own sake.

Exit status is 0 when every file passes, 1 otherwise, so it can gate a build or
a skill's self-check.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

# ---------------------------------------------------------------------------
# The canonical vocabulary. Kept in sync with docs/TRACE_FORMAT.md; the Rust
# reader is deliberately more permissive than this, because a viewer should
# degrade rather than refuse, but an adapter's output should not need that.
# ---------------------------------------------------------------------------

RECORD_TYPES = {"assistant", "user", "system", "ai-title", "cost-state"}

# A record whose `type` is not one of the above is *inert*: the reader skips it
# and moves on. Every harness writes bookkeeping events beside the conversation,
# and minting a canonical name for each of them would only make the format
# harder to hit. Claude Code alone emits `attachment`, `file-history-delta`,
# `file-history-snapshot`, `queue-operation`, `mode`, `worktree-state`,
# `atis-latch`, `relocated` and `last-prompt`; across 147 real transcripts those
# outnumber the `system` records by two orders of magnitude. Passing them
# through untouched and dropping them are both correct, so they are reported as
# a note rather than a failure.

# Types that carry a message payload.
MESSAGE_TYPES = {"assistant", "user", "system"}

BLOCK_TYPES = {"text", "thinking", "redacted_thinking", "tool_use", "tool_result", "image"}

REQUIRED_BLOCK_FIELDS = {
    "text": ("text",),
    "thinking": ("thinking",),
    "redacted_thinking": (),
    "tool_use": ("name",),
    "tool_result": (),
    "image": (),
}

# A `thinking` field is allowed to be empty. It usually is: of 4,366 thinking
# blocks across 147 transcripts from the reference harness, 3,411 carry an empty
# string and nothing but a signature. Requiring text here would reject the
# format this project treats as canonical, which is the opposite of useful.
EMPTY_TEXT_OK = {"thinking"}

TOOL_INPUT_KEYS = ("command", "file_path", "notebook_path", "path", "pattern", "url", "query")

EDIT_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit", "str_replace_editor"}

USAGE_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
)

COST_FIELDS = (
    "totalCostUSD",
    "totalAPIDurationWithoutRetries",
    "totalToolDuration",
    "totalDuration",
    "totalLinesAdded",
    "totalLinesRemoved",
)

# Accepts the shapes that appear in the wild: with or without a timezone, with
# or without fractional seconds, and the space-separated variant some exporters
# emit.
TS_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$"
)


class Report:
    def __init__(self, path: Path, strict: bool) -> None:
        self.path = path
        self.strict = strict
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.stats: Counter[str] = Counter()
        self.seen_fields: Counter[str] = Counter()
        self.tool_uses: dict[str, int] = {}
        self.tool_results: set[str] = set()
        self.timestamps: list[tuple[str, int]] = []
        self.unmapped: set[str] = set()
        self.inert: Counter[str] = Counter()
        self.unknown_blocks: Counter[str] = Counter()
        self.notices: int = 0
        self.notes: list[str] = []

    def error(self, lineno: int, msg: str) -> None:
        self.errors.append(f"line {lineno}: {msg}")

    def warn(self, lineno: int, msg: str) -> None:
        self.warnings.append(f"line {lineno}: {msg}")

    def note(self, msg: str) -> None:
        self.notes.append(msg)


def load(path: Path, rep: Report) -> list[tuple[int, object]]:
    """Read NDJSON, or a single JSON document holding an array.

    Both shapes are valid input for the reader, so both are valid here.
    """
    raw = path.read_text(encoding="utf-8", errors="replace")

    stripped = raw.lstrip()
    if stripped.startswith("[") or stripped.startswith("{"):
        # Try the whole-file parse first. A pretty-printed array is a document;
        # a single long line is one record and must not be mistaken for one.
        try:
            doc = json.loads(raw)
        except json.JSONDecodeError:
            doc = None
        if isinstance(doc, list):
            return [(i + 1, v) for i, v in enumerate(doc)]
        if isinstance(doc, dict) and "messages" in doc and isinstance(doc["messages"], list):
            return [(i + 1, v) for i, v in enumerate(doc["messages"])]
        if isinstance(doc, dict) and "records" in doc and isinstance(doc["records"], list):
            return [(i + 1, v) for i, v in enumerate(doc["records"])]

    out: list[tuple[int, object]] = []
    for i, line in enumerate(raw.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append((i, json.loads(line)))
        except json.JSONDecodeError as e:
            rep.error(i, f"not valid JSON ({e.msg})")
    return out


def check_block(rep: Report, lineno: int, b: object, where: str) -> None:
    if not isinstance(b, dict):
        rep.error(lineno, f"{where}: block is {type(b).__name__}, expected object")
        return
    kind = b.get("type")
    if kind is None:
        rep.error(lineno, f"{where}: block has no 'type'")
        return
    if kind not in BLOCK_TYPES:
        # The spec says an unknown block is ignored, and the reader obliges.
        # So this is a signal rather than a failure: it is nearly always a
        # misspelt type on the adapter's side, and content is lost quietly.
        rep.unknown_blocks[kind] += 1
        return
    rep.stats[f"block:{kind}"] += 1

    for field in REQUIRED_BLOCK_FIELDS.get(kind, ()):
        v = b.get(field)
        if not isinstance(v, str):
            rep.error(lineno, f"{where}: {kind} block needs a string {field!r}")
        elif not v and kind not in EMPTY_TEXT_OK:
            rep.error(lineno, f"{where}: {kind} block has an empty {field!r}")

    if kind == "tool_use":
        name = b.get("name")
        args = b.get("input")
        if not isinstance(args, dict):
            rep.error(lineno, f"{where}: tool_use {name!r} has no object 'input'")
        # A tool that takes a file or a command but has neither is almost always
        # an adapter that read the wrong key rather than a tool with no argument.
        elif not any(k in args for k in TOOL_INPUT_KEYS):
            rep.warn(
                lineno,
                f"{where}: tool_use {name!r} has none of the conventional argument "
                f"keys {TOOL_INPUT_KEYS}; got {sorted(args)[:6]}",
            )

    if kind == "image":
        src = b.get("source")
        if not isinstance(src, dict):
            rep.error(lineno, f"{where}: image block needs a 'source' object")
        elif not isinstance(src.get("data"), str) and not isinstance(src.get("url"), str):
            rep.error(lineno, f"{where}: image source needs base64 'data' or a 'url'")

    if kind == "tool_result":
        content = b.get("content")
        if content is None:
            rep.warn(lineno, f"{where}: tool_result without 'content'")
        elif not isinstance(content, str):
            # The reader flattens {text: ...} parts, so an array is survivable,
            # but a profile that emits a string avoids the ambiguity entirely.
            rep.warn(
                lineno,
                f"{where}: tool_result content is {type(content).__name__}, "
                "preferred shape is a plain string",
            )


def check_record(rep: Report, lineno: int, rec: object) -> None:
    if not isinstance(rec, dict):
        rep.error(lineno, f"record is {type(rec).__name__}, expected object")
        return

    kind = rec.get("type")
    if kind is None:
        rep.error(lineno, "record has no 'type'")
        return
    if kind not in RECORD_TYPES:
        rep.inert[kind] += 1
        return
    rep.stats[f"record:{kind}"] += 1

    for key in rec:
        rep.seen_fields[key] += 1

    ts = rec.get("timestamp")
    if ts is not None:
        if not isinstance(ts, str) or not TS_RE.match(ts):
            rep.error(lineno, f"timestamp {ts!r} is not an ISO-8601 instant")
        else:
            rep.timestamps.append((ts, lineno))
    elif kind in MESSAGE_TYPES and not rec.get("isMeta"):
        rep.warn(lineno, f"{kind} record has no timestamp; the timeline cannot place it")

    origin = rec.get("origin")
    if origin is not None:
        if not isinstance(origin, dict) or not isinstance(origin.get("kind"), str):
            rep.error(lineno, "origin must be an object with a string 'kind'")

    for key in ("isSidechain", "isMeta"):
        if key in rec and not isinstance(rec[key], bool):
            rep.error(lineno, f"{key} must be a boolean")

    if kind == "ai-title":
        if not isinstance(rec.get("aiTitle"), str):
            rep.error(lineno, "ai-title record needs a string 'aiTitle'")
        return

    if kind == "cost-state":
        if not any(f in rec for f in COST_FIELDS):
            rep.error(lineno, f"cost-state record carries none of {COST_FIELDS}")
        for f in COST_FIELDS:
            if f in rec and not isinstance(rec[f], (int, float)):
                rep.error(lineno, f"cost-state field {f!r} must be numeric")
        return

    # --- message-carrying records -----------------------------------------
    msg = rec.get("message")
    if not isinstance(msg, dict):
        if kind == "system":
            # Every `system` record in the wild is a harness notice -- an API
            # error, a hook summary, the output of a local command -- and it
            # carries `subtype` and friends instead of a message. Fourty-five of
            # them across 147 real transcripts, none with a `message`.
            rep.notices += 1
            return
        rep.error(lineno, f"{kind} record needs a 'message' object")
        return

    usage = msg.get("usage")
    if usage is not None:
        if not isinstance(usage, dict):
            rep.error(lineno, "message.usage must be an object")
        else:
            for f in USAGE_FIELDS:
                if f in usage and not isinstance(usage[f], int):
                    rep.error(lineno, f"message.usage.{f} must be an integer")
            details = usage.get("output_tokens_details")
            if details is not None:
                if not isinstance(details, dict):
                    rep.error(lineno, "usage.output_tokens_details must be an object")
                elif "thinking_tokens" in details and not isinstance(
                    details["thinking_tokens"], int
                ):
                    rep.error(lineno, "usage.output_tokens_details.thinking_tokens must be an integer")
            out_tokens = usage.get("output_tokens")
            thinking = (details or {}).get("thinking_tokens") if isinstance(details, dict) else None
            if isinstance(out_tokens, int) and isinstance(thinking, int) and thinking > out_tokens:
                rep.warn(
                    lineno,
                    f"thinking tokens ({thinking}) exceed output tokens ({out_tokens}); "
                    "one of the two is mapped to the wrong field",
                )

    content = msg.get("content")
    if content is None:
        rep.warn(lineno, f"{kind} record has a message with no 'content'")
        return
    if isinstance(content, str):
        return
    if not isinstance(content, list):
        rep.error(lineno, "message.content must be a string or an array of blocks")
        return

    for i, b in enumerate(content):
        where = f"message.content[{i}]"
        check_block(rep, lineno, b, where)
        if not isinstance(b, dict):
            continue
        if b.get("type") == "tool_use":
            tid = b.get("id")
            if not isinstance(tid, str) or not tid:
                rep.warn(
                    lineno,
                    f"{where}: tool_use has no 'id', so its result cannot be matched back",
                )
            else:
                if tid in rep.tool_uses:
                    rep.error(lineno, f"{where}: duplicate tool_use id {tid!r}")
                rep.tool_uses[tid] = lineno
        elif b.get("type") == "tool_result":
            rid = b.get("tool_use_id")
            if isinstance(rid, str) and rid:
                rep.tool_results.add(rid)


def cross_check(rep: Report) -> None:
    """Relations that only make sense across records."""
    orphan_results = sorted(rep.tool_results - set(rep.tool_uses))
    if orphan_results:
        shown = ", ".join(repr(x) for x in orphan_results[:5])
        rep.error(
            0,
            f"{len(orphan_results)} tool_result id(s) match no tool_use: {shown}"
            + (" ..." if len(orphan_results) > 5 else ""),
        )

    # Ordering. An inversion means either the adapter is reading a clock field
    # that is not the event time, or the records were written out of order.
    # It is a warning rather than an error because transcripts really do contain
    # them: a tool result and the assistant turn that produced it are written
    # concurrently, and the result can land a few milliseconds 'early'. The
    # reader walks records in file order, so a small inversion changes nothing;
    # a large one is worth looking at, which is what the span below is for.
    bad_order = 0
    first_bad = None
    for (prev, _), (cur, lineno) in zip(rep.timestamps, rep.timestamps[1:]):
        if cur < prev:
            bad_order += 1
            if first_bad is None:
                first_bad = (prev, cur, lineno)
    if bad_order:
        prev, cur, lineno = first_bad
        rep.warn(
            0,
            f"timestamps go backwards {bad_order} time(s); first at line {lineno}: "
            f"{cur} after {prev}",
        )

    if not rep.tool_uses:
        rep.warn(0, "no tool calls found; if this session really had none, ignore this")

    if not any(rep.seen_fields[f] for f in ("timestamp",)):
        rep.error(0, "no record carries a timestamp; the timeline would be empty")

    has_usage = any(
        rep.seen_fields[k] for k in ("message",)
    ) and rep.stats["record:assistant"] > 0
    if has_usage and not any(f in rep.seen_fields for f in ("message",)):
        rep.warn(0, "assistant records carry no usage; token totals will read zero")


# Fields a profile language can produce but a collapse into the canonical
# format loses. Reported so nothing disappears silently.
KNOWN_TOP_LEVEL = {
    "type",
    "timestamp",
    "sessionId",
    "isSidechain",
    "isMeta",
    "origin",
    "message",
    "aiTitle",
    "totalCostUSD",
    "totalAPIDurationWithoutRetries",
    "totalToolDuration",
    "totalDuration",
    "totalLinesAdded",
    "totalLinesRemoved",
    "totalCost",
    "uuid",
    "parentUuid",
    "cwd",
    "version",
    "gitBranch",
    "userType",
    "requestId",
    "toolUseResult",
    "summary",
    "leafUuid",
}


def validate(path: Path, strict: bool, show_unmapped: bool) -> Report:
    rep = Report(path, strict)
    records = load(path, rep)
    if not records:
        rep.error(0, "no records")
        return rep

    types: Counter[str] = Counter()
    for lineno, rec in records:
        check_record(rep, lineno, rec)
        if isinstance(rec, dict):
            t = rec.get("type")
            if isinstance(t, str):
                types[t] += 1
            if t in RECORD_TYPES:
                for k in rec:
                    if k not in KNOWN_TOP_LEVEL:
                        rep.unmapped.add(k)

    cross_check(rep)

    # A file that produced no canonical records at all is the signature of a
    # profile whose rules did not match: the adapter ran and emitted nothing.
    if not any(types.get(t) for t in RECORD_TYPES):
        rep.error(
            0,
            "no canonical records; every rule in the profile missed, "
            f"input record types seen: {sorted(t for t in types)}",
        )
    if rep.notices:
        rep.note(
            f"{rep.notices} system record(s) carry harness metadata (subtype, level) "
            "rather than a message; the reader skips them"
        )
    if rep.unknown_blocks:
        listed = ", ".join(f"{k} ({v})" for k, v in rep.unknown_blocks.most_common())
        rep.warn(0, f"block type(s) outside the canonical set, ignored by the reader: {listed}")
    if rep.inert:
        listed = ", ".join(f"{k} ({v})" for k, v in rep.inert.most_common())
        rep.note(
            f"{sum(rep.inert.values())} record(s) of {len(rep.inert)} inert type(s), "
            f"ignored by the reader: {listed}"
        )
    if show_unmapped and rep.unmapped:
        rep.warn(0, f"fields outside the canonical vocabulary: {sorted(rep.unmapped)}")
    return rep


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Validate a canonical trace file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("paths", nargs="+", type=Path)
    ap.add_argument(
        "--strict",
        action="store_true",
        help="treat warnings as failures",
    )
    ap.add_argument(
        "--unmapped",
        action="store_true",
        help="list input fields the canonical format does not model",
    )
    ap.add_argument("--quiet", action="store_true", help="only print the summary line")
    args = ap.parse_args(argv)

    failed = 0
    for path in args.paths:
        if not path.exists():
            print(f"FAIL {path}: no such file", file=sys.stderr)
            failed += 1
            continue

        rep = validate(path, args.strict, args.unmapped)
        bad = len(rep.errors) + (len(rep.warnings) if args.strict else 0)
        status = "FAIL" if bad else "ok  "

        records = {k.split(":", 1)[1]: v for k, v in rep.stats.items() if k.startswith("record:")}
        blocks = {k.split(":", 1)[1]: v for k, v in rep.stats.items() if k.startswith("block:")}
        summary = ", ".join(f"{v} {k}" for k, v in sorted(records.items()))
        detail = ", ".join(f"{v} {k}" for k, v in sorted(blocks.items()))

        print(f"{status} {path}")
        if not args.quiet:
            print(f"     records: {summary or 'none'}")
            print(f"     blocks:  {detail or 'none'}")
            print(
                f"     tools:   {len(rep.tool_uses)} call(s), "
                f"{len(rep.tool_results)} result id(s), "
                f"{len(rep.tool_uses) - len(set(rep.tool_uses) & rep.tool_results)} unmatched"
            )
        for e in rep.errors:
            print(f"     ERROR   {e}")
        for w in rep.warnings:
            print(f"     warning {w}")
        for n in rep.notes:
            print(f"     note    {n}")
        if bad:
            failed += 1

    if len(args.paths) > 1:
        print(f"\n{len(args.paths) - failed}/{len(args.paths)} file(s) passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))