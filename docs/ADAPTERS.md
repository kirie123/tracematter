# Adapters

Every agent writes its trajectory down differently. Claude Code emits one JSON
object per line with a `message.content` array. Codex CLI wraps each event in a
`payload`. The OpenAI Responses API streams items inside event envelopes. Your
own harness probably has a third shape again.

TraceMatter reads exactly one shape — the [canonical trace format](TRACE_FORMAT.md)
— and everything else goes through an **adapter**. This page explains how to add
one.

---

## Two kinds of adapter

There are two mechanisms, and they exist because formats fall into two groups.

**A profile** is a JSON file that declares a field-by-field mapping. It is read
by the Rust core, needs no build step, no interpreter, and no network. Reach for
a profile whenever the answer to "what does this field become?" can be written
down as a path.

**A script** is any executable that prints canonical records to stdout. Reach
for a script when the mapping needs a decision a declarative rule cannot make:
sorting events by an embedded sequence number, joining two files, reconstructing
a tool result that arrived in a later batch, decoding a bespoke binary framing.

| | Profile | Script |
|:---|:---|:---|
| Written in | JSON | anything (Python, Node, shell) |
| Runs | in-process, native | as a subprocess |
| Good for | renaming, nesting, value transforms, token arithmetic | ordering, joining, custom decoding |
| Ships with the app | four built-ins | — |
| Where it lives | `<config>/tracematter/profiles/` | anywhere you like |

Start with a profile. Move to a script only when you find something the profile
language genuinely cannot express — and treat that as a signal, because it
usually means the source has no stable record boundary.

---

## The four built-in profiles

| Id | Detects | Notes |
|:---|:---|:---|
| `claude-code` | `~/.claude/projects/**/*.jsonl` | The reference format. Passes records through untouched — the canonical format *is* this one. |
| `codex` | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | Events wrapped in `payload`; input/output text arrives as typed parts. |
| `openai-messages` | a single JSON document holding a `messages` array | Chat Completions exports, eval result files, hand-built datasets. |
| `openai-tool-calls` | Responses API item streams | Handles both bare items and event envelopes that wrap them under `item`. |

`claude-code` is one line of configuration, because a file that is already
canonical needs no mapping:

```json
{ "id": "claude-code", "name": "Claude Code", "source": { "kind": "jsonl" },
  "records": [{ "passthrough": true }] }
```

---

## Quick start

1. Point the app at a transcript. If it opens and the step count, token totals
   and tool calls look right, it was already recognised and you are done.

2. If it opens but the timeline is empty or the numbers are absurd, the file is
   being read as a native transcript and needs an adapter.

3. Ask the app which profile it would pick. `detect_profile(path)` returns every
   profile with a coverage score — the share of records its `match` accepts.
   A score above 0.9 usually means you have found the right one; a score near
   zero means no built-in fits and you are writing a new adapter.

4. Write the adapter, install it, and verify it with `tools/validate_trace.py`
   before trusting it on a directory full of files.

### Choosing a sample file

Do not write an adapter against a mental model of the format. Copy one real file
somewhere and keep it as your fixture. Then:

- Read the **first**, **middle** and **last** records. Log files change shape
  over time: a session that begins with `session_meta` and ends with a
  `token_count` reports its usage only at the end, so a mapping built from the
  first record will silently lose every token.
- Count the distinct values of the field you are about to branch on:
  ```bash
  python -c "import json,collections,sys; \
    print(collections.Counter(json.loads(l).get('type') \
    for l in open(sys.argv[1], encoding='utf-8') if l.strip()))" \
    path/to/sample.jsonl
  ```
  If you assumed three record types and there are nine, you will find out here
  rather than in production.
- Grep for the records you *expect* but have not seen yet: an error result, a
  retry, an aborted turn. Those are the ones that get mapped wrong, and they are
  the ones that matter when you later ask "which runs failed?".
- Confirm the file is really line-delimited. A pretty-printed JSON stream looks
  like JSONL until you try to parse one line. Check with:
  ```bash
  python -c "import json,sys; \
    [json.loads(l) for l in open(sys.argv[1], encoding='utf-8') if l.strip()]; \
    print('ok')" path/to/sample.jsonl
  ```
  If that raises, the source is one document, not a line stream — reach for a
  script, or ask the exporter to emit NDJSON.

---

## Writing a profile

A profile is a JSON object. The four sections that matter are `source`, an
optional `unwrap`, `match` (how the profile recognises a file), and `records`
(the mapping itself).

```json
{
  "id": "my-agent",
  "name": "My Agent",
  "description": "What this reads, in one sentence.",
  "source": { "kind": "jsonl" },
  "match": { "path": "kind", "in": ["turn", "tool"] },
  "records": [
    {
      "when": { "path": "kind", "equals": "turn" },
      "type": { "lookup": { "path": "from",
                            "table": { "human": "user", "agent": "assistant" },
                            "default": "system" } },
      "timestamp": { "path": "at" },
      "blocks": [{ "type": "text", "fields": { "text": { "path": "body" } } }]
    }
  ]
}
```

### `source`

`{ "kind": "jsonl" }` for one JSON value per line. `{ "kind": "doc", "array":
"messages" }` for a single JSON document whose records live in an array — each
element is then emitted as its own record, and the original document stays
reachable under `__doc` in case a mapping needs a session-level field.

### `unwrap`

Some formats wrap every record in an event envelope:

```json
{"type": "response.output_item.added", "item": {"type": "function_call", "name": "ls"}}
```

Set `"unwrap": "item"` and the payload is hoisted over the envelope before any
rule runs, so a mapping can address `name` directly instead of `item.name`.
Payload fields win on collision, which is what you want: the envelope's `type`
describes the envelope, while the payload's `type` describes the record you are
actually adapting. The untouched envelope remains available under `__envelope`.

This matters more than it looks. Without it you would write every single path
twice — `{"first": [{"path": "item.name"}, {"path": "name"}]}` — to survive
files that wrap some records and not others. One declaration replaces all of it.

### `match` — how a file is recognised

`match` is a selector evaluated against a **sample** of the file. Detection is
scored, not boolean: a profile's score is the share of sampled records its
`match` accepts. The app picks the highest-scoring adapter, and only when that
score reaches 0.5 and the file is not already canonical.

Keep `match` narrow. A selector of `{"path": "type", "exists": true}` will claim
every JSONL file on the machine.

### `when` — selectors

A rule applies when its `when` accepts the record. Omit `when` to apply the rule
to everything.

| Key | Meaning |
|:---|:---|
| `path` | Dotted path into the record. `a.b`, `a[0].b` and `a.0.b` are all accepted; a leading `$` is ignored. |
| `equals` | Loose equality — `2` matches `"2"`, `true` matches `"true"`. |
| `in` | Value is one of a list. |
| `exists` | The path resolves to something other than null. |
| `type` | `"string"`, `"number"`, `"bool"`, `"array"`, `"object"`. |
| `all` / `any` / `not` | Boolean composition of nested selectors. |

### `records` — the mapping

Rules are tried in order and the **first** one whose `when` accepts the record
wins. A record no rule accepts is dropped silently, so a catch-all rule placed
too early will swallow everything after it — put specific rules first.

Every rule may set:

| Field | Becomes |
|:---|:---|
| `type` | `assistant`, `user` or `system`. A rule that cannot derive one emits nothing, which is what keeps an over-broad `when` harmless. |
| `timestamp` | RFC 3339 string. |
| `sessionId` | Session identifier, if the source carries one. |
| `isSidechain` | True for side conversations that should not join the main timeline. |
| `isMeta` | True for bookkeeping records — usage reports, context compactions. They show up, but the transcript does not present them as turns. |
| `originKind` | `"human"` when a person typed it; anything else (classically `"harness"`) otherwise. This is what drives the human-versus-agent split in the UI. |
| `title` | Display title. |
| `model` | Model name. |
| `usage` | Token accounting — see below. |
| `blocks` | The content of the record. |
| `cost` | Cost bookkeeping. |
| `extra` | Arbitrary object merged into the record for anything the canonical shape does not name. |

### Value expressions

The same small language appears everywhere a value is expected. A bare
path is shorthand for `{ "path": "..." }`, and `{ "first": [...] }` is the
general form that every other operation is a case of.

| Operation | Meaning |
|:---|:---|
| `path` | Read a path. |
| `constant` | Use a fixed value. |
| `first` | First operand that resolves to a value. The workhorse for formats that drift. |
| `cat` | Concatenate parts into one string. |
| `lookup` | Map a value through a table, with a `default`. |
| `parseJson` | Parse a string that itself contains JSON. |
| `sub` | Numeric subtraction, floored at zero. |

`sub` exists for one specific and very common bug. OpenAI-style APIs report
`input_tokens` **inclusive** of the cached prefix:

```json
{"input_tokens": 2410, "cached_input_tokens": 1920, "output_tokens": 148}
```

The canonical format keeps cached reads in their own field so that context size
can be reconstructed without double counting. Map the raw number straight across
and every prompt is counted twice, which inflates the cache ratio and the cost
estimate together. The correct mapping is a subtraction:

```json
"usage": {
  "input":  { "sub": [{ "path": "input_tokens" },
                      { "first": [{ "path": "cached_input_tokens" },
                                  { "constant": 0 }] }] },
  "output": { "path": "output_tokens" },
  "cacheRead": { "path": "cached_input_tokens" }
}
```

The `first` around the cached count is not decoration: usage lines in the same
file are not guaranteed to carry it, and a missing subtrahend must mean zero
rather than a dropped record.

### `blocks`

`blocks` is a list of block rules. Each has a `type` (`text`, `thinking`,
`tool_use`, `tool_result`) and a `fields` object supplying that block's keys.

| Block | Keys |
|:---|:---|
| `text` | `text` |
| `thinking` | `thinking` (a `redacted_thinking` block uses `text`) |
| `tool_use` | `id`, `name`, `input` |
| `tool_result` | `tool_use_id`, `is_error`, `content` |

`text` and `thinking` are always coerced to strings. If the source hands you
`[{"type": "input_text", "text": "..."}]` — an array of typed parts, which is
what both Codex and the Responses API do — a `text` field pointed at that array
flattens to the joined text rather than an array. Forgetting this yields records
the reader accepts but shows as empty, which is a quiet failure worth a test.

A block rule may also carry `each` to expand an array into many blocks (one
`tool_use` per element of `tool_calls`), and `flatten` to force parts-style
flattening on a field that is not `text`.

Ordering matters for pairing. A `tool_use` block carries the id that its
`tool_result` will quote, and the reader uses those ids to match results to
calls. If your format names the field differently on each side, map both to the
same id or the timeline will show every call as unanswered.

---

## Installing a profile

Drop the file in the profiles directory. The app shows you the exact path on the
Settings page, and `profiles_dir()` returns it programmatically. On Windows it is
`%APPDATA%\tracematter\profiles`; on macOS
`~/Library/Application Support/tracematter/profiles`; on Linux
`~/.config/tracematter/profiles`.

Profiles are read at startup. A user profile with the same `id` as a built-in
**overrides** it, so if a built-in is almost right you can copy it, fix the two
fields that are wrong, and keep your version without patching the app.

Validation is deliberately strict at load time and forgiving at run time. A
profile that fails to parse is skipped and reported rather than taking the whole
list down; a profile that parses but matches nothing simply produces no records.

---

## Writing a script

A script adapter is any executable that reads a source file and prints canonical
records to stdout, one JSON object per line. Write to stdout and nothing else —
diagnostics belong on stderr, and a stray `print()` in the wrong stream will
corrupt the output.

```
my-adapter  <source-file>  >canonical.jsonl
```

A minimal one in Python:

```python
import json, sys

for line in open(sys.argv[1], encoding="utf-8"):
    if not line.strip():
        continue
    ev = json.loads(line)
    if ev.get("kind") != "turn":
        continue
    print(json.dumps({
        "type": "assistant" if ev["from"] == "agent" else "user",
        "timestamp": ev["at"],
        "originKind": "harness" if ev["from"] == "agent" else "human",
        "message": {
            "content": [{"type": "text", "text": ev["body"]}],
            "usage": {
                "input_tokens": max(0, ev["usage"]["in"] - ev["usage"].get("cached", 0)),
                "output_tokens": ev["usage"]["out"],
                "cache_read_input_tokens": ev["usage"].get("cached", 0),
            },
        },
    }, ensure_ascii=False))
```

Three things to get right:

- **Always open files with an explicit encoding.** `open(path)` uses the
  platform default, which on a Chinese Windows install is GBK, not UTF-8. Real
  transcripts contain em dashes and box-drawing characters; decoding them as GBK
  either raises halfway through the file or silently produces mojibake.
- **Never drop a record because one field is missing.** Emit it with the field
  absent. A record you skip is invisible; a record with a gap is visible, and
  visible gaps are what you can debug.
- **Keep the exit code honest.** Exit non-zero when the input could not be read
  at all. That is the difference between "this file has no turns" and "this file
  is not what you think it is".

Scripts are the escape hatch, and they are also the right answer when the source
is not a log at all — an SQLite database, a directory of request/response pairs,
a capture file. Normalise it into canonical records and everything downstream
works unchanged.

---

## Verifying an adapter

An adapter that runs is not an adapter that is correct. The failure mode is not a
crash; it is a mapping that quietly loses every thinking block, or double-counts
cached tokens so the cost column is 40% too high — believable enough that nobody
looks.

```bash
python tools/validate_trace.py canonical.jsonl
python tools/validate_trace.py --strict canonical.jsonl     # warnings fail too
python tools/validate_trace.py --unmapped canonical.jsonl   # list unknown keys
```

It checks the structural invariants of the canonical format: record types are
known, timestamps parse, token counts are integers and non-negative, thinking
tokens never exceed output tokens, block types carry their required fields,
tool_result ids refer to a tool_use that appeared earlier, and timestamps move
forward. Two checks catch the expensive mistakes — a file with **zero** canonical
records means every rule missed, and an orphaned `tool_result` means the id
mapping disagrees between the two sides.

Then check the numbers by hand, because the validator cannot know what the right
answer is. For a small fixture, compute the expected totals directly from the
source and compare:

```bash
python -c "
import json,sys
ins=outs=cached=0
for l in open(sys.argv[1], encoding='utf-8'):
    if l.strip():
        u=json.loads(l).get('usage') or {}
        ins+=u.get('input_tokens',0); outs+=u.get('output_tokens',0)
        cached+=u.get('cache_read_input_tokens',0)
print('source says:', ins, outs, cached)
" path/to/source.jsonl
```

and confirm the app reports the same three numbers for the adapted file. If they
disagree, the discrepancy is the bug. Also compare the `tool_use` count against
the number of calls you can see in the raw file: a call with no matching result
in the source is fine, a call that exists in the source but not in the output is
a rule that is not firing.

Three invariants worth asserting in a test, because all three have failed in
practice:

1. one record out per record in (or a deliberate, counted reduction),
2. `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` for
   the last turn is plausible as a context size — not twice the model's window,
3. every `tool_use` id and every `tool_result` id appears on both sides.

---

## A worked example

The `openai-tool-calls` profile adapts a Responses API stream. It is worth
reading because it exercises every awkward feature at once, and because it is
short:

```json
{
  "source": { "kind": "jsonl" },
  "unwrap": "item",
  "match": { "any": [
    { "path": "type", "in": ["message", "reasoning", "function_call",
                             "function_call_output", "response.done"] },
    { "path": "item.type", "exists": true },
    { "path": "response.usage", "type": "object" }
  ]},
  "records": [
    { "when": { "all": [{ "path": "type", "equals": "message" },
                        { "path": "role", "equals": "user" }] },
      "type": { "constant": "user" },
      "timestamp": { "path": "created_at" },
      "originKind": { "constant": "human" },
      "blocks": [{ "type": "text", "fields": { "text": { "path": "content" } } }] }
  ]
}
```

Four decisions in that fragment:

- `unwrap` collapses the envelope, so `type` and `role` can be read directly
  whether or not a given line was wrapped.
- `match` lists both the wrapped and bare spellings (`item.type` alongside
  `type`) because the same file mixes them, and adds the two usage shapes.
- The user rule is first, and the assistant rule that follows is not a catch-all
  — an unmatched record is dropped rather than mislabelled.
- `originKind` is set by the rule, not inferred. A `user` record coming from the
  API's own replay path is not a human turn, and the UI splits on this field.

The remaining rules follow the same shape. The tool-call rule maps `call_id`
into the block `id`, the output rule maps the same `call_id` into `tool_use_id`
— that shared key is what pairs them — and both usage shapes land on one rule
whose `when` accepts either.

---

## Mistakes that cost the most

**Reading a field the record does not have.** `first` exists so you can fall
back. The real damage is not a missing value but a *rule that stops matching*: a
record whose `when` reads a path that is absent in half the file will silently
vanish from those halves.

**Trusting the first record.** Repositories of real transcripts are dominated by
long sessions, and long sessions are exactly the ones that change format partway
through. Sample the middle and the end.

**Assuming cached tokens are additional.** They are a subset of the prompt. See
`sub` above; this is the single most common mapping error.

**Catch-all rules at the top.** Rules match first-wins. A permissive rule placed
before a specific one makes the specific one dead code that still looks correct
in review.

**Silently skipping unparseable lines.** Tolerating a malformed line is correct,
because real logs contain truncated writes. Tolerating it *silently* is not. A
file whose third line is corrupt should report one skipped line, not lose the
next thousand records.

**Renaming on one side only.** If you map `call_id` to `id` on the call, map it
to `tool_use_id` on the result. Half a pairing is worse than none, because the
timeline looks populated while every call reads as unanswered.
