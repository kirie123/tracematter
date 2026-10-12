# TraceMatter trace format

**Version 1** &middot; the wire format the reader consumes.

Every adapter in this repository &mdash; a declarative profile, a converter script,
or a hand-written module &mdash; exists to turn *some* agent's logs into the shape
described here. Nothing else in the app knows what an input format looks like.

If you are an agent being asked to support a new harness, this document is your
target: read it, then read `docs/ADAPTERS.md` for the two ways to hit it.

---

## 1. File shape

- **UTF-8**, newline-delimited JSON &mdash; one record per line, one record per event.
- Blank lines and whitespace-only lines are ignored.
- A line that does not parse as JSON is **counted, not skipped silently**. The
  count surfaces in the UI because a truncated tail is a real signal: it usually
  means the process was killed mid-write.
- Trailing content on the last line without a newline is fine.
- Key order is irrelevant. Unknown keys are preserved and ignored.
- Both `.jsonl` and `.json` extensions are picked up by the scanner.

A file may also be a **single JSON document** containing an array of records
&mdash; many API exports look like that. Profiles declare which of the two shapes
they expect; see `docs/ADAPTERS.md`.

## 2. Record header

Every record is a JSON object. These fields are read off the top level:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | string | **yes** | Record kind. Drives everything else. See section 3. |
| `timestamp` | string | recommended | RFC 3339, UTC. Gives the timeline its axis and the session its duration. |
| `sessionId` | string | recommended | Groups records into a session. Falls back to the file name stem. |
| `isSidechain` | bool | no | True for sub-agent traffic. Excluded from session totals, still shown. |
| `isMeta` | bool | no | True for bookkeeping the user did not type. |
| `origin` | object | no | `{"kind": "human"}` marks a message as human-authored. Anything else labels the record with that kind. |

`type` is the only hard requirement. A record whose `type` is not one of the
known values is ignored &mdash; harmless, and useful when a harness adds new
event kinds.

## 3. Record types

### `assistant`

A model turn. Carries text, reasoning, tool calls, and token usage.

```json
{
  "type": "assistant",
  "timestamp": "2026-03-04T09:14:02.481Z",
  "sessionId": "3f9a1c",
  "message": {
    "model": "some-model-id",
    "usage": { "input_tokens": 1204, "output_tokens": 318 },
    "content": [
      { "type": "thinking", "thinking": "The failing test points at the cache." },
      { "type": "text", "text": "The cache is re-reading the source." },
      { "type": "tool_use", "id": "tu_1", "name": "Read",
        "input": { "file_path": "src/lib/cache.ts" } }
    ]
  }
}
```

### `user`

Three different things share this type, distinguished by what the record
contains. This mirrors how harnesses actually work: tool output is fed back as a
user-role message.

1. **A human message** &mdash; has `content` blocks of type `text` and nothing else.
2. **A tool result** &mdash; has `content` blocks of type `tool_result`. The viewer
   labels these *observation*.
3. **Bookkeeping** &mdash; `isMeta: true`, or a peer/notification `origin`.

```json
{
  "type": "user",
  "timestamp": "2026-03-04T09:14:03.110Z",
  "message": {
    "content": [
      { "type": "tool_result", "tool_use_id": "tu_1",
        "is_error": false, "content": "export function cached(...) {" }
    ]
  }
}
```

`content` may also be a **plain string** for a simple human message. The reader
accepts both.

### `system`

Harness bookkeeping. It comes in two shapes and the reader treats them
differently.

1. **A notice** &mdash; `subtype` plus fields specific to it, and no `message`.
   This is what harnesses actually emit: `api_error` with `retryAttempt`, a hook
   summary with `hookCount`, the stdout of a local command. Every `system`
   record across 147 real transcripts is this shape. The reader skips it.
2. **A message** &mdash; a `message` object, rendered in the timeline but never
   counted as conversation.

```json
{ "type": "system", "subtype": "api_error", "level": "error",
  "retryAttempt": 1, "source": "connection_retry",
  "timestamp": "2026-03-04T09:20:11.004Z" }
```

### `ai-title`

A ready-made session title. Optional; without it the UI falls back to the first
human message.

```json
{ "type": "ai-title", "aiTitle": "Fix the cache test" }
```

### `cost-state`

A cumulative cost/duration snapshot. Harnesses emit these periodically; the
**last one wins**. All fields optional.

```json
{
  "type": "cost-state",
  "totalCostUSD": 12.44,
  "totalAPIDurationWithoutRetries": 184300,
  "totalToolDuration": 90210,
  "totalDuration": 4020000,
  "totalLinesAdded": 512,
  "totalLinesRemoved": 88
}
```

Durations are milliseconds. `totalCost` is accepted as an alias for
`totalCostUSD`.

## 4. The `message` object

| Field | Type | Meaning |
| --- | --- | --- |
| `content` | array or string | The payload. See section 5. |
| `model` | string | Model id. The most frequent one becomes the session's model. |
| `usage` | object | Token accounting. See section 7. |

## 5. Content blocks

When `content` is an array, each element is a block. Blocks with an unknown
`type` are ignored.

| `type` | Fields | Notes |
| --- | --- | --- |
| `text` | `text` | Prose. Multiple text blocks in one record are joined with a blank line. |
| `thinking` | `thinking`, or `text` as a fallback | Reasoning. Rendered collapsed. The field may be empty &mdash; most real thinking blocks carry a signature and no text. |
| `redacted_thinking` | &mdash; | Rendered as `[redacted thinking]`. |
| `tool_use` | `id`, `name`, `input` | A tool call. `id` is what pairs it with its result. |
| `tool_result` | `tool_use_id`, `is_error`, `content` | A tool's output. `content` is a string or an array of `{ "text": ... }`. |
| `image` | `source` (`{"type": "base64", "media_type": ..., "data": ...}`) | An attachment, usually a screenshot pasted into a turn. Preserved on the record; the timeline notes that one is present rather than inlining it. |

## 6. Tool input conventions

The reader does not require any particular tool names &mdash; anything works and
appears in the timeline. But four inputs unlock the specialised views, and
adapters should map into them wherever the source format has an equivalent:

| Convention | Unlocks |
| --- | --- |
| `command` (string) | The **Terminal** view lists it; repeated identical commands become the thrash signal. |
| `file_path`, or `notebook_path`, or `path` | The **Workspace** view reconstructs the file tree from it. |
| `pattern` | Readable one-line summaries for search tools. |
| `description`, `url`, `query` | Readable one-line summaries for agent/web tools. |

Tool names `Edit`, `MultiEdit`, `Write`, `NotebookEdit` and `str_replace_editor`
are treated as workspace mutations: they feed the workspace reconstruction and
their failures are counted separately from general tool errors.

## 7. Token usage

```json
"usage": {
  "input_tokens": 1204,
  "output_tokens": 318,
  "cache_read_input_tokens": 88000,
  "cache_creation_input_tokens": 2048,
  "output_tokens_details": { "thinking_tokens": 120 }
}
```

All optional, all default to zero. `input_tokens` is the *uncached* input; the
context size for a step is `input + cache_read + cache_creation`, which is what
the UI reports. Getting this wrong is the most common adapter mistake: if a
harness reports a single total, map it to `input_tokens` and leave the cache
fields at zero rather than inventing a split.

## 8. What the reader derives

Nothing below is part of the wire format &mdash; it is computed, and listed so
adapters know what their mapping feeds.

- **Session summary** &mdash; step and message counts, tool calls by name, tool
  errors, edit calls and edit failures, human messages, interruptions, slash
  commands, compactions, repeated bash commands, files touched, token totals,
  peak context, duration, cost.
- **Steps** &mdash; one canonical `Step` per `assistant`/`user`/`system` record,
  in file order. Records are never split or merged.
- **Turns** &mdash; steps grouped by human request, then compiled into digests.
- **Workspace** &mdash; file contents replayed from `Read`, `Write` and `Edit`
  calls, so the tree can be reconstructed at any step.

## 9. Minimal valid file

Two lines, enough to appear as a session with one turn:

```jsonl
{"type":"user","timestamp":"2026-03-04T09:14:00Z","sessionId":"demo","origin":{"kind":"human"},"message":{"content":"Why is the test failing?"}}
{"type":"assistant","timestamp":"2026-03-04T09:14:02Z","sessionId":"demo","message":{"model":"demo-model","content":[{"type":"text","text":"The cache re-reads the source."}],"usage":{"input_tokens":40,"output_tokens":12}}}
```

## 10. Tolerance rules

A converter should aim for correctness, not completeness. The reader is built to
degrade:

- **Missing timestamps** &mdash; steps lose their offsets; the session still loads.
- **Missing `tool_use_id`** &mdash; the result is still shown, just unpaired.
- **Missing usage** &mdash; token columns read zero rather than failing.
- **Unknown block types** &mdash; ignored.
- **A record that produces no content** &mdash; dropped, not rendered as an empty
  step. Tool results that came back empty, prompts that carried only an
  attachment, harness notices: none of them are worth a blank row.
- **Timestamps that step backwards** &mdash; kept in file order. Transcripts
  really do contain them, because a tool result and the assistant turn that
  produced it are written concurrently and the result can land a few
  milliseconds early. `tools/validate_trace.py` reports the count.
- **Unknown record types** &mdash; ignored. Every harness writes bookkeeping
  events beside the conversation, and those are not errors. Claude Code emits
  `attachment`, `atis-latch`, `file-history-delta`, `file-history-snapshot`,
  `last-prompt`, `mode`, `queue-operation`, `relocated` and `worktree-state`;
  across 147 real transcripts there are 19,000 of them against 45 `system`
  records. An adapter may pass them through or drop them.
- **A string where an array was expected** (or the reverse) &mdash; accepted for
  `content`; elsewhere the field is treated as absent.

So an adapter that maps 80% of a format faithfully is a working adapter. Ship it,
then improve it against real transcripts.
