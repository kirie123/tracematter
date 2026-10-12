---
name: trace-adapter
description: Write a TraceMatter adapter for an agent transcript format that has no profile yet. Use when someone hands over a session log — from a harness, an internal tool, an evaluation export — and TraceMatter reads it as zero sessions, as garbage, or with silently wrong numbers.
---

# Writing a TraceMatter adapter

TraceMatter reads one thing: the canonical trace format in
`docs/TRACE_FORMAT.md`. Everything else is translated on the way in.

Your job is to produce that translation for a format nobody has handled yet, and
to *prove* it works before handing it back.

## The failure you are actually here to prevent

A bad adapter does not crash. It produces a session that renders, scrolls, and
shows totals — just not the right ones. Tokens counted twice, timestamps taken
from a field that is not the event time, tool results silently dropped so every
call looks unanswered.

So: do not stop when the file loads. Stop when you can show, with numbers, that
what came out matches what went in.

## Step 1 — Look before you map

Never write a rule against a format you have only read about. Open the file.

```bash
# How big, how many lines, is it even JSONL?
wc -l session.jsonl && head -c 400 session.jsonl

# The shape of the top-level keys, and how often each appears.
python - <<'PY'
import json, collections
c = collections.Counter()
for line in open('session.jsonl', encoding='utf-8'):
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
    except json.JSONDecodeError:
        continue
    if isinstance(r, dict):
        c[r.get('type', '<no type>')] += 1
for k, n in c.most_common():
    print(f'{n:8d}  {k}')
PY
```

Then take one record of each type and read it in full. You need to answer:

- **What marks a record's kind?** A `type` field, a `role`, an event name, or the
  shape of the payload.
- **Where is the timestamp?** Top level, or nested in a payload. Watch for a
  *second* timestamp that means something else — a session start, a file
  creation time. Using the wrong one puts the whole session at the wrong hour.
- **Where does message content live, and what shape is it?** A string, an array
  of `{type, text}` parts, or an array of arrays.
- **How are tool calls represented?** Name and arguments apart, or together; and
  arguments as an object or as a JSON *string* (very common — the profile
  language has `parseJson` for exactly this).
- **How are tool results tied back to their call?** A `call_id`, a `tool_use_id`,
  or positional order. If there is no id, say so in your report — matching by
  order is guesswork and the viewer will show unanswered calls.
- **Does it report tokens, and are the numbers inclusive?** This is the single
  most common source of wrong totals. If a field is "cached tokens", check
  whether the input total already contains it.

Run the numbers check early. A file that claims 4,000 input tokens on a
200-token prompt has an inclusive total, not a bug in your adapter.

## Step 2 — Decide: profile or script

There are two kinds of adapter. Pick the cheaper one that fits.

**A profile** — a JSON document mapping fields to fields. It covers renames,
reshapes, lookups, concatenation and JSON-in-string parsing. No build step, no
code review, and it lands in the app immediately.

**A converter script** — a program that reads the source and writes canonical
NDJSON. Needed when the translation is *stateful* or *computed*: stitching a
call and its result across records by position, computing a duration from
start/end pairs, merging split records, deriving an id, or walking nested
structures whose depth varies.

Rule of thumb: if you can express it as "this field becomes that field", write a
profile. If you catch yourself needing to remember something from an earlier
record, write a script.

Both are fine. The profile is not a lesser answer — it is just narrower.

## Step 3a — Writing a profile

Read `adapters/profile-template.json` and `adapters/profiles/claude-code.json`
first. The reference profile is the identity mapping, which is the clearest way
to see what the shape looks like.

A profile has five parts:

```json
{
  "id": "my-harness",
  "name": "My Harness",
  "description": "One sentence: which tool writes these files, and where they live.",
  "source": { "kind": "Jsonl" },
  "match": { "path": "event", "exists": true },
  "records": [ /* rules, in order; first match wins */ ]
}
```

- **`source`** — `{"kind": "Jsonl"}`, or `{"kind": "Doc", "array": "messages"}`
  for one JSON document holding an array of events. A Doc source still reads
  JSONL as a fallback, so a wrapped export and a line-per-record export can share
  one profile.
- **`match`** — a predicate over a *sample* of the file, used only to guess which
  profile fits an unrecognised file. Make it narrow enough that it cannot match
  some other harness by accident.
- **`records[].when`** — the predicate that selects this rule's input records.
  Omit it and the rule matches everything, which is how a catch-all is written —
  and also how an over-broad rule quietly eats records meant for a later one.
- **`passthrough: true`** — emit the input record unchanged. If the format is
  already canonical, this is the entire profile.

Field values can be: `path`, `constant`, `first` (first non-null wins), `lookup`,
`cat` (concatenate as text), `parseJson`, `sub` (numeric difference, floored at
zero).

For content, remember:

- A record *must* produce a `type`, or the rule is skipped. That is deliberate:
  it makes an over-broad rule harmless.
- `text` and `thinking` fields are coerced to strings, so pointing them at an
  array of `{text}` parts works.
- `tool_use` needs `name`; `input` defaults to `{}`.
- Every matching block rule contributes blocks. Suppress one with `when`.
- `each` runs a rule per element of an array — that is how one record becomes
  several tool calls.

Then install it:

```bash
# The app reports this path; it is the profiles directory under your config.
python -c "print(__import__('os').path.expandvars(r'%APPDATA%\tracematter\profiles'))"
```

Drop the file in as `<id>.json`. A profile whose id matches a built-in replaces
it — that is how you fix a built-in mapping without forking. Either restart the
app or rescan.

### If a converter script is the right answer

Write it to `adapters/<id>.<ext>` next to the profiles, and follow two rules:

1. **Read the source, write canonical NDJSON to stdout.** Do not add flags, do
   not write in place, do not touch the input.
2. **Count what you could not map.** Print a summary to stderr: records in,
   records out, records skipped and why, fields you recognised but did not map.
   A silent converter is how data disappears.

Keep it dependency-free if you can. The reader accepts `{ "type": ... }` per
line and nothing else is required.

## Step 4 — Prove it

This is not optional, and a passing exit code is not proof.

```bash
# 1. Structure: types, required fields, tool pairing, timestamp order.
python tools/validate_trace.py converted.jsonl

# 2. Field-level: what input fields did the mapping never touch?
python tools/validate_trace.py --strict --unmapped converted.jsonl
```

Then check the *content* by hand, on real records:

```bash
# Do the numbers survive the round trip? Compare a few tokens and costs.
python - <<'PY'
import json
n_in = n_out = 0
for line in open('converted.jsonl', encoding='utf-8'):
    r = json.loads(line)
    n_out += 1
    u = (r.get('message') or {}).get('usage') or {}
    if u:
        print(r.get('type'), u.get('input_tokens'), u.get('output_tokens'))
PY
```

And confirm the counts line up end to end:

```bash
wc -l source.jsonl                      # records in
wc -l converted.jsonl                   # records out
grep -c '"type":"tool_use"' converted.jsonl
grep -c '"type":"tool_result"' converted.jsonl
```

The last two must be equal unless the session genuinely has unanswered calls. If
they are not, you have lost tool results, which is the most common real bug.

Then load it in the app and look at the timeline: are the turns in order, do the
tool calls show their arguments, does the terminal panel show commands, does the
cost and token totals look like the file's own numbers?

## Step 5 — Report honestly

When you hand back the adapter, state:

- What you mapped, and what you **did not** map, with counts.
- Anything you had to guess — especially anything order-dependent.
- Where a number is an approximation rather than a reading.
- Whether you tested against a real session or a synthetic one. If synthetic,
  say so plainly: a fixture you wrote from documentation proves the mapping is
  well-formed, not that it is correct for files in the wild.

Do not describe an adapter as working because the file loaded. Say what you
verified and how.

## Things that have actually gone wrong

- **Inclusive input tokens.** `prompt_tokens` usually contains the cached portion.
  Mapping it straight to `input_tokens` double counts the context and inflates
  the cost roughly twofold. Use `sub`.
- **The wrong timestamp.** Session metadata carries a start time; every record
  carries an event time. Taking the former makes a 40-minute session look
  instantaneous and breaks turn segmentation.
- **Dropping the errors.** A failed tool call is data. Losing `is_error` turns
  every struggle into a success.
- **Order-dependent tool pairing.** Records get reordered by log rotation. If the
  format has no call id, say so rather than pairing by position.
- **A catch-all rule first.** `records` is first-match-wins: a rule with no
  `when` placed before a specific one will swallow everything after it.
- **Case and separator drift.** `toolCall` / `tool_call` / `tool-call`,
  `sessionId` / `session_id`. Check the actual file rather than assuming.