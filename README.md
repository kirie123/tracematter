<div align="center">

# TraceMatter

**Turn agent transcripts into training data.**

A local, offline desktop workbench for reading agent trajectories, auditing what
the agent actually did, and labelling turns in bulk so they can go into an SFT set.

<a href="#quick-start">Quick start</a> ·
<a href="#what-it-does">What it does</a> ·
<a href="#labelling">Labelling</a> ·
<a href="#architecture">Architecture</a>

</div>

---

If you train models on agent traces, you already know the shape of the problem:
the transcripts pile up faster than anyone can read them, and the ones that look
good in a summary are often the ones you least want to imitate. An agent that
claims success without running the tests, edits the same file eleven times, or
gets interrupted halfway through a refactor produces a transcript that *reads*
fine and teaches the wrong thing.

TraceMatter is the tool we wanted for that. Point it at a folder of `.jsonl`
transcripts and you get a sortable index of every session, a step-by-step replay
of any one of them, and a batch labeller that asks a model the specific
questions that decide whether a turn belongs in a dataset — then lets you
review, filter, and export the answers.

Everything runs locally. The only network calls are the ones you configure.

## What it does

### 1. Index every session in a folder

The **Sessions** view scans a directory of transcripts and builds one row per
session: model, wall-clock duration, number of steps, tool calls, tool errors,
edit failures, human interruptions, tokens (input, output, reasoning, cache
read/write), and cost where the transcript records it.

Rows sort on any column and filter by text. The point is triage: sort by error
rate to find the sessions where something went wrong, sort by cost to find what
is eating the budget, sort by interruptions to find the tasks the agent could
not finish on its own.

### 2. Replay a session step by step

The **Trace** view opens one session and reconstructs it:

- **Timeline** — every step in order, with role, timestamp, tool name, and a
  one-line summary. Filter to assistant turns, tool calls, edits, errors, or
  human messages.
- **Step detail** — the full text of the step, thinking blocks collapsed,
  tool inputs and results, and errors called out.
- **Workspace** — the file tree as the agent saw it, rebuilt from its `Read`,
  `Write` and `Edit` calls, so you can jump to any file and see the state at any
  point in the session.
- **Terminal** — every bash command the agent ran, in order, with the commands
  that failed marked.
- **Turns** — the session chopped into user-request-sized turns, each with a
  pre-built digest and its tool/file/error counts.

### 3. Label turns in bulk

The **Annotate** view harvests turns from the sessions you select, filters them
with cheap rules before spending any tokens, and then runs a rubric against a
gateway you configure. Jobs run in the background with live progress, and every
raw response is kept so a failed judgement can be re-run without redoing the
rest.

### 4. Review and export

The **Review** view is the table of labels: filter by any enumerated field, by
confidence, or straight to the rows that were judged SFT-worthy. Export to
JSONL or CSV with the columns you choose.

## Labelling

### The digest

A turn can be hundreds of thousands of characters. You cannot send that to a
model per row, and you cannot naively truncate it either: cutting only the tail
leaves the reader staring at a sentence that stops mid-thought, and both humans
and models reliably conclude "the agent left this unfinished". That failure mode
silently inflates `partial` verdicts.

So a turn is compiled into a **digest** that keeps the head *and* the tail of the
long parts and marks the cut explicitly:

```text
WORK DONE
  Edited Board.tsx to accept a QuoteSource and render rows. npm test failed:
  cached() called the source twice within ttl. Read the test - the test was
  correct. ...

[... 680 chars omitted: one assertion dump, one file read ...]
```

The marker names the pipeline as the culprit, so the model reads the gap as an
artefact of the tool rather than as evidence about the agent. Head sizes, tail
sizes, and how many tool calls and files to list are all configurable in
**Settings** and stored per user.

### Rubrics are data

A rubric is a list of typed fields plus instructions. Adding a labelling task
means adding fields, not writing code. Three ship built in:

| Rubric | Asks for |
| --- | --- |
| **Turn quality (SFT curation)** | `task_type` · `outcome` (completed/partial/blocked/abandoned) · `struggle` 0-3 · `sft_worthy` · `confidence` · `reason` |
| **Reply quality (conversation review)** | `intent` · `answered` · `usefulness` 1-5 · `hallucination_risk` · `confidence` · `reason` |
| **Task compliance (checklist grading)** | `requirements_met` · `requirements_missed` · `verdict` (pass/partial/fail) · `confidence` · `evidence` |

Field kinds are `enum`, `bool`, `int`, `float`, and `text`, with optional
ranges. The rubric you select determines the JSON schema the model is held to,
the columns offered on export, and the filters in **Review**.

The instruction text matters more than the field list, so it is editable in the
app. The shipped `turn-quality` prompt is explicit about what counts as
evidence — verified success versus an unverified claim, thrashing, scope drift,
unfinished threads — because a model asked for a vibe will happily supply one.

### Gateways

Any OpenAI-compatible `/chat/completions` endpoint works: a hosted provider, a
local vLLM or Ollama, or your own proxy. Configure base URL, API key, model,
temperature, `max_tokens`, concurrency, timeout, retry count, and extra headers.

Servers differ in how much structured output they actually implement, so the
client negotiates downward and remembers what worked for the rest of the
process:

1. **`json_schema`** — the server enforces the schema (best)
2. **`json_object`** — the server guarantees valid JSON; the schema goes in the prompt
3. **`none`** — plain completion, the first JSON object is extracted

One failure downgrades every worker, which keeps a batch of a thousand rows from
spending a thousand requests rediscovering the same limitation. **Settings** has
a test button that reports which mode a gateway is actually giving you.

## Architecture

Tauri v2. A Rust backend does the file reading, parsing, HTTP, and job
management; a React frontend does the rendering and holds the view state. No
Python, no sidecar, no database — the transcripts on disk are the source of
truth and everything else is derived.

```text
src-tauri/src/
  model.rs        shared data model, serialised camelCase for the frontend
  transcript.rs   reads transcript JSONL, identifies record types, session metadata
  profile.rs      the adapter engine: profile parsing, detection, conversion
  steps.rs        folds records into ordered steps, pairs tool calls with results
  segments.rs     turn segmentation and digest compilation
  config.rs       persisted settings and the built-in rubrics
  gateway.rs      HTTP client, structured-output negotiation, bounded concurrency
  jobs.rs         background job registry, progress events, JSONL/CSV export
  commands.rs     the IPC surface
  main.rs         app wiring

src/
  lib/api.ts      typed wrappers over the IPC commands
  lib/types.ts    mirrors the Rust model
  lib/store.tsx   one app-wide context (config, sessions, trace, jobs, labels)
  lib/format.ts   every number, byte, duration and date the UI prints
  components/ui.tsx  primitives: badges, cards, tables, diff view, toasts
  pages/          Sessions · Trace · Annotate · Review · Settings
```

A few deliberate choices:

- **One context, no router.** Five views and a selection; a state library would
  be more machinery than the problem has. View switching is a field in the store.
- **All formatting in one module.** Tables and detail panes print the same
  numbers, so the formatting lives in one place and is shared.
- **Backends are read-mostly.** Scanning, parsing and digesting never write to
  your transcripts. The only writes are the config file and files you explicitly
  export.
- **Long jobs are resumable at the record level.** Labels stream to disk as they
  arrive, and the raw model response is kept alongside the parsed values, so a
  re-run can reuse what already succeeded.

## Adapters

Every agent writes its trajectory down differently, and a viewer that only
understands one of them is a viewer for one agent. TraceMatter reads a single
[canonical format](docs/TRACE_FORMAT.md) and adapts everything else into it.

### Built in

| Agent | What it reads |
|:---|:---|
| Claude Code | `~/.claude/projects/**/*.jsonl` — the reference format, passed through untouched |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` — events wrapped in a `payload` |
| OpenAI messages | any single JSON document with a `messages` array |
| OpenAI tool calls | Responses API item streams, bare or envelope-wrapped |

A profile is a small JSON file that declares a field-by-field mapping, executed
natively — no build step, no interpreter. When a format needs more than renaming
— reordering by an embedded sequence number, joining two files — an adapter
script that prints canonical records works just as well.

### Adapting an unknown format

There are four moving parts, and none of them is code:

1. Keep one real sample file. Read the first, middle and last record, because
   logs change shape over time and usage often appears only at the end.
2. Write a profile if the mapping is expressible as paths and simple value
   operations. Write a script if it is not.
3. Install the profile in the profiles directory shown on the Settings page. A
   profile with the same id as a built-in overrides it.
4. Prove it with `tools/validate_trace.py`, then check the token totals and the
   tool-call pairing against the raw file by hand.

`docs/ADAPTERS.md` covers the mapping language, the script protocol, a worked
example, and the six mistakes that cost the most. If you would rather have an
agent write the adapter, `skills/trace-adapter/` is a self-contained brief for
exactly that task.

## Transcript format

The indexer reads newline-delimited JSON, one event per line, which is what
Claude Code writes under `~/.claude/projects/<project>/<session>.jsonl`. Records
are typed (`assistant`, `user`, `system`, …) and assistant content arrives as a
list of blocks — `text`, `thinking`, `tool_use` — which is what makes a faithful
replay possible rather than a wall of concatenated text.

The tool-call layer is what the rest of the app is built on. `Read`, `Write`,
`Edit` and `Bash` calls are understood specifically: they drive the workspace
reconstruction, the terminal view, and the diff rendering. Other tools still
appear in the timeline with their inputs and results, they just do not get a
specialised renderer.

Session metadata is taken from the transcript rather than guessed: token counts
including cache reads, per-message cost, the model id, sidechain and
sub-agent flags, whether a message came from a human or a notification.

## Privacy

Your transcripts never leave the machine except through the gateway you
configure, and then only the digests of the turns you explicitly submit. There
is no telemetry, no analytics, no update check, and no account. The only two
things the app writes are its own config file and the exports you ask for:

```text
<OS config dir>/tracematter/config.json
```

## Development

```bash
npm run tauri dev     # app with hot-reloading frontend
npm run build         # type-check + bundle the frontend only
npm run tauri build   # release installers
```

Rust changes rebuild the backend; frontend changes hot-reload. `npm run build`
runs `tsc --noEmit` first, so a type error fails the build rather than shipping.

Issues and pull requests are welcome. If you are reporting a parsing problem,
include the record *type* that misbehaved (`assistant`, `user`, `system`, ...) and
the shape of the content blocks - that is usually enough to pin it down, and
please strip anything sensitive first.

## Status and limitations

Worth being straight about what this is:

- **The transcript reader targets one concrete format:** newline-delimited JSON
  with typed records and block-structured content. Other tools' logs are
  converted into that shape rather than parsed natively.
- **Labels are judgements, not ground truth.** A model scoring turns will be
  wrong sometimes, and it will be systematically wrong in whatever direction its
  prompt leans. The objective columns (tool errors, edit failures,
  interruptions, cost) are the ones to trust when the two disagree; the labels
  are what you get when there is no objective column for what you care about.
- **The three built-in rubrics are opinionated defaults.** They encode one
  team's idea of what makes a good SFT turn. Treat them as a starting point to
  edit, not a standard to adopt.
- **Single user, local files.** There is no server mode, no shared state, and no
  multi-user story.

## License

MIT - see [LICENSE](LICENSE).
