"""Generate the synthetic transcripts under examples/sample-sessions/.

Everything here is fabricated: a fictional partner-data ingest service, three
sessions, invented file contents and invented token counts. It ships with the
repository so the README can show the viewer at work, and so someone can open
the app and see it doing something before aiming it at their own transcripts.

Keeping the samples behind a generator rather than hand-written JSON keeps the
three files consistent -- ids pair up, timestamps advance, usage adds up -- and
it makes the provenance of the demo data obvious.

    python examples/make_samples.py
"""
import json
import pathlib
from datetime import datetime, timedelta

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "sample-sessions"

MODEL = "claude-opus-4-8"
S1 = "6b1f0a92-57c4-4a1e-9f3d-2c8e77b0d451"
S2 = "0d9c4e51-8a72-4f60-b1d8-3e5a9c21f7b4"
S3 = "c47a2b18-6e35-46d9-9a0c-51b8e3d90f27"


def at(start):
    """Return a function turning a second offset into an RFC 3339 stamp."""
    t0 = datetime.fromisoformat(start)

    def stamp(sec, ms=0):
        d = t0 + timedelta(seconds=sec, milliseconds=ms)
        return d.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (d.microsecond // 1000)

    return stamp


def usage(i, o, cache=0, think=0, create=0):
    u = {
        "input_tokens": i,
        "output_tokens": o,
        "cache_read_input_tokens": cache,
        "cache_creation_input_tokens": create,
    }
    if think:
        u["output_tokens_details"] = {"thinking_tokens": think}
    return u


def human(ts, sid, text):
    return {
        "type": "user",
        "timestamp": ts,
        "sessionId": sid,
        "origin": {"kind": "human"},
        "message": {"content": text},
    }


def result(ts, sid, uid, text, error=False):
    return {
        "type": "user",
        "timestamp": ts,
        "sessionId": sid,
        "message": {
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": uid,
                    "is_error": error,
                    "content": text,
                }
            ]
        },
    }


def turn(ts, sid, blocks, u, sidechain=False):
    r = {
        "type": "assistant",
        "timestamp": ts,
        "sessionId": sid,
        "message": {"model": MODEL, "usage": u, "content": blocks},
    }
    if sidechain:
        r["isSidechain"] = True
    return r


def think(t):
    return {"type": "thinking", "thinking": t}


def say(t):
    return {"type": "text", "text": t}


def call(uid, name, inp):
    return {"type": "tool_use", "id": uid, "name": name, "input": inp}


def block(*lines):
    return "\n".join(lines)


def title(ts, sid, text):
    return {"type": "ai-title", "timestamp": ts, "sessionId": sid, "aiTitle": text}


def cost(ts, sid, usd, api_ms, tool_ms, total_ms, added, removed):
    return {
        "type": "cost-state",
        "timestamp": ts,
        "sessionId": sid,
        "totalCostUSD": usd,
        "totalAPIDurationWithoutRetries": api_ms,
        "totalToolDuration": tool_ms,
        "totalDuration": total_ms,
        "totalLinesAdded": added,
        "totalLinesRemoved": removed,
    }


# ---------------------------------------------------------------- file bodies

BATCH_PY = block(
    " 1  \"\"\"Nightly export window for partner drops.\"\"\"",
    " 2  from datetime import date, datetime, timedelta",
    " 3",
    " 4  from .readers import csv_reader",
    " 5",
    " 6  ONE_DAY = timedelta(days=1)",
    " 7",
    " 8",
    " 9  class Window:",
    "10      def __init__(self, start, end):",
    "11          self.start = start",
    "12          self.end = end",
    "13",
    "14",
    "15  def _window(day):",
    "16      start = datetime(day.year, day.month, day.day)",
    "17      return Window(start, start + ONE_DAY)",
    "18",
    "19",
    "20  WINDOW = _window(date.today())",
    "21",
    "22",
    "23  def run(period=None):",
    "24      span = period or WINDOW",
    "25      rows = csv_reader.read(span.start, span.end)",
    "26      return [normalise(r) for r in rows]",
)

BATCH_TAIL = block(
    "12          self.end = end",
    "13",
    "14",
    "15  def _window(day):",
    "16      start = datetime(day.year, day.month, day.day)",
    "17      return Window(start, start + ONE_DAY)",
    "18",
    "19",
    "20  WINDOW = _window(date.today())",
    "21",
)

GREP_HITS = block(
    "services/ingest/batch.py:20:WINDOW = _window(date.today())",
    "services/ingest/tests/test_batch.py:9:    day = date.today()",
)

PYTEST_FAIL = block(
    "services/ingest/tests/test_batch.py .F",
    "================================== FAILURES ===================================",
    "______________________ test_nightly_window_is_closed ______________________",
    "",
    "    def test_nightly_window_is_closed():",
    "        report = batch.run()",
    ">       assert report[0].day == date.today()",
    "E       AssertionError: assert datetime.date(2026, 3, 3) == datetime.date(2026, 3, 4)",
    "",
    "=========================== short test summary info ===========================",
    "FAILED services/ingest/tests/test_batch.py::test_nightly_window_is_closed",
    "1 failed, 1 passed in 4.12s",
)

PYTEST_PASS = block(
    "services/ingest/tests/test_batch.py ..",
    "2 passed in 3.87s",
)


REGRESSION_TEST = block(
    "from datetime import date",
    "",
    "from services.ingest import batch",
    "",
    "",
    "class _Day:",
    "    # Stands in for datetime.date so the test owns what today() returns.",
    "    def __init__(self, day):",
    "        self._day = date.fromisoformat(day)",
    "",
    "    def today(self):",
    "        return self._day",
    "",
    "",
    "def test_window_moves_when_the_day_does(monkeypatch):",
    "    monkeypatch.setattr(batch, 'date', _Day('2026-03-04'))",
    "    before = batch.window()",
    "",
    "    monkeypatch.setattr(batch, 'date', _Day('2026-03-05'))",
    "    after = batch.window()",
    "",
    "    assert before.start.date() == date(2026, 3, 4)",
    "    assert after.start.date() == date(2026, 3, 5)",
    "",
    "",
    "def test_window_is_stable_within_a_day(monkeypatch):",
    "    monkeypatch.setattr(batch, 'date', _Day('2026-03-05'))",
    "    assert batch.window() == batch.window()",
)


def session_one():
    ts = at("2026-03-04T09:14:00")
    s = S1
    return [
        {"type": "system", "subtype": "hook_summary", "hookCount": 2,
         "timestamp": ts(0), "sessionId": s},
        human(ts(4), s, "The nightly ingest test fails maybe one run in three on CI "
                        "and never locally. Make it deterministic."),
        turn(ts(7), s, [
            think("Flaky on CI only, never locally. That smell is nearly always time: "
                  "the test and the code disagree about what day it is."),
            call("tu_01", "Bash", {
                "command": "pytest services/ingest/tests/test_batch.py -k nightly -x -q",
                "description": "reproduce the flaky test"}),
        ], usage(1840, 96, 1204, 41)),
        result(ts(11), s, "tu_01", PYTEST_FAIL, error=True),
        turn(ts(15), s, [
            think("Read the window builder before touching anything."),
            call("tu_02", "Read", {
                "file_path": "services/ingest/batch.py", "offset": 1, "limit": 26}),
        ], usage(2204, 142, 1204, 58)),
        result(ts(16), s, "tu_02", BATCH_PY),
        turn(ts(20), s, [
            think("Line 20 builds the window once, at import. A worker that boots before "
                  "midnight and runs the job after it keeps yesterday's window."),
            call("tu_03", "Grep", {
                "pattern": "date\\.today|utcnow", "path": "services/ingest", "-n": True}),
        ], usage(2650, 118, 1204, 62)),
        result(ts(21), s, "tu_03", GREP_HITS),
        turn(ts(25), s, [
            call("tu_04", "Edit", {
                "file_path": "services/ingest/batch.py",
                "old_string": "WINDOW = _window(today())",
                "new_string": "WINDOW = _window(date.today())"}),
        ], usage(2890, 88, 1204)),
        result(ts(26), s, "tu_04",
               "String to replace not found in file.\n"
               "The file may have changed since it was last read.", error=True),
        turn(ts(30), s, [
            think("I guessed at the exact line. Read it back and replace what is "
                  "actually there."),
            call("tu_05", "Read", {
                "file_path": "services/ingest/batch.py", "offset": 12, "limit": 10}),
        ], usage(3120, 74, 1204, 22)),
        result(ts(31), s, "tu_05", BATCH_TAIL),
        turn(ts(35), s, [
            call("tu_06", "Edit", {
                "file_path": "services/ingest/batch.py",
                "old_string": "WINDOW = _window(date.today())",
                "new_string": block(
                    "def window():",
                    "    # Resolved per run, so a worker that outlives midnight does not",
                    "    # keep the day it started on.",
                    "    return _window(date.today())")}),
        ], usage(3300, 96, 1204)),
        result(ts(36), s, "tu_06", "Applied 1 edit to services/ingest/batch.py"),
        turn(ts(40), s, [
            call("tu_07", "Edit", {
                "file_path": "services/ingest/batch.py",
                "old_string": "    span = period or WINDOW",
                "new_string": "    span = period or window()"}),
        ], usage(3480, 84, 1204)),
        result(ts(41), s, "tu_07", "Applied 1 edit to services/ingest/batch.py"),
        turn(ts(43), s, [
            call("tu_09", "Write", {
                "file_path": "services/ingest/tests/test_batch_window.py",
                "content": REGRESSION_TEST}),
        ], usage(4260, 418, 1204)),
        result(ts(44), s, "tu_09",
               "File created successfully at: "
               "services/ingest/tests/test_batch_window.py"),
        turn(ts(45), s, [
            call("tu_08", "Bash", {
                "command": "pytest services/ingest/tests/test_batch.py -k nightly -x -q",
                "description": "re-run the suite"}),
        ], usage(3660, 92, 1204)),
        result(ts(49), s, "tu_08", PYTEST_PASS),
        turn(ts(53), s, [
            say("The window was built once at import time, so any process that outlives "
                "midnight keeps the day it started on. CI boots the worker before the "
                "job runs it; a local test run never crosses the rollover, which is why "
                "only CI sees it.\n\n"
                "`WINDOW` is now a `window()` call resolved per run, and the call site "
                "no longer shadows it. Both nightly tests pass, and the rollover now "
                "has a regression test: it swaps `date` for a stub and checks the "
                "window moves when the day does."),
        ], usage(3820, 168, 1204)),
        title(ts(60), s, "Make the nightly ingest test deterministic"),
        cost(ts(62), s, 0.9124, 19900, 2380, 63100, 33, 5),
    ]
# ----------------------------------------------------------------------------
# Part two: sessions two and three.


QUEUE_PY = block(
    " 1  \"\"\"Worker that drains the partner-ingest queue.\"\"\"",
    " 2  import time",
    " 3",
    " 4  from .broker import BrokerUnavailable",
    " 5",
    " 6  IDLE_SLEEP = 0.05",
    " 7",
    " 8",
    " 9  class Worker:",
    "10      def __init__(self, broker, handler):",
    "11          self.broker = broker",
    "12          self.handler = handler",
    "13",
    "14      def run_forever(self):",
    "15          while True:",
    "16              try:",
    "17                  job = self.broker.take()",
    "18              except BrokerUnavailable:",
    "19                  continue",
    "20              if job is None:",
    "21                  time.sleep(IDLE_SLEEP)",
    "22                  continue",
    "23              self.handler(job)",
)

SQL = block(
    " 1  -- Tenant activity for the dashboard header.",
    " 2  SELECT t.id,",
    " 3         count(e.*)               AS events,",
    " 4         max(e.occurred_at)       AS last_seen",
    " 5  FROM tenants t",
    " 6  JOIN events e ON e.tenant_id = t.id",
    " 7  WHERE e.occurred_at > now() - interval '30 days'",
    " 8  GROUP BY t.id",
    " 9  ORDER BY events DESC",
    "10  LIMIT 50;",
)

EXPLAIN = block(
    "Limit  (cost=284113.55..284113.68 rows=50 width=24) (actual time=38411.9..38412.0 rows=50)",
    "  ->  GroupAggregate  (cost=284113.55..301882.10 rows=71062 width=24)",
    "        ->  Sort  (cost=284113.55..284291.21 rows=710629 width=16)",
    "              Sort Key: (count(e.*)) DESC",
    "              ->  Hash Join  (cost=211.00..276880.00 rows=710629 width=16)",
    "                    Hash Cond: (e.tenant_id = t.id)",
    "                    ->  Seq Scan on events e  (cost=0.00..248310.00 rows=4263776 width=8)",
    "                          Filter: (occurred_at > (now() - '30 days'::interval))",
    "                          Rows Removed by Filter: 8120441",
    "                    ->  Hash  (cost=186.00..186.00 rows=2000 width=8)",
    "Planning Time: 1.204 ms",
    "Execution Time: 38412.004 ms",
)


def session_two():
    ts = at("2026-03-05T14:02:00")
    s = S2
    return [
        human(ts(3), s, "When the broker is down the worker spins in a tight retry loop "
                        "and saturates a core. Add exponential backoff with jitter, and "
                        "cover it with a test."),
        turn(ts(6), s, [
            think("Two things to check: how the loop handles BrokerUnavailable, and "
                  "whether there is already a retry helper in the service."),
            call("tu_11", "Read", {"file_path": "services/ingest/queue.py"}),
        ], usage(1602, 88, 980, 34)),
        result(ts(7), s, "tu_11", QUEUE_PY),
        turn(ts(11), s, [
            think("Line 19 continues immediately on failure. Every retry is a fresh "
                  "round trip at full speed. A capped backoff with jitter is enough; "
                  "no new dependency."),
            call("tu_12", "Edit", {
                "file_path": "services/ingest/queue.py",
                "old_string": block(
                    "import time",
                    "",
                    "from .broker import BrokerUnavailable",
                    "",
                    "IDLE_SLEEP = 0.05"),
                "new_string": block(
                    "import random",
                    "import time",
                    "",
                    "from .broker import BrokerUnavailable",
                    "",
                    "IDLE_SLEEP = 0.05",
                    "BACKOFF_BASE = 0.25",
                    "BACKOFF_MAX = 30.0",
                    "",
                    "",
                    "def backoff(attempt, rand=random.random):",
                    "    \"\"\"Capped exponential backoff, jittered so workers do not",
                    "    retry in lockstep after a broker restart.\"\"\"",
                    "    window = min(BACKOFF_MAX, BACKOFF_BASE * 2 ** attempt)",
                    "    return window * (0.5 + rand() / 2)")}),
        ], usage(1912, 264, 980, 96)),
        result(ts(12), s, "tu_12", "Applied 1 edit to services/ingest/queue.py"),
        turn(ts(16), s, [
            call("tu_13", "Edit", {
                "file_path": "services/ingest/queue.py",
                "old_string": block(
                    "        def run_forever(self):",
                    "            while True:"),
                "new_string": block(
                    "        def run_forever(self):",
                    "            attempt = 0",
                    "            while True:")}),
        ], usage(2240, 118, 980, 18)),
        result(ts(17), s, "tu_13", "Applied 1 edit to services/ingest/queue.py"),
        turn(ts(21), s, [
            call("tu_14", "Edit", {
                "file_path": "services/ingest/queue.py",
                "old_string": block(
                    "            except BrokerUnavailable:",
                    "                continue",
                    "            if job is None:"),
                "new_string": block(
                    "            except BrokerUnavailable:",
                    "                time.sleep(backoff(attempt))",
                    "                attempt += 1",
                    "                continue",
                    "            attempt = 0",
                    "            if job is None:")}),
        ], usage(2510, 152, 980, 12)),
        result(ts(22), s, "tu_14", "Applied 1 edit to services/ingest/queue.py"),
        turn(ts(26), s, [
            call("tu_15", "Write", {
                "file_path": "services/ingest/tests/test_queue.py",
                "content": block(
                    "import time",
                    "from unittest.mock import MagicMock",
                    "",
                    "import pytest",
                    "",
                    "from services.ingest.broker import BrokerUnavailable",
                    "from services.ingest.queue import BACKOFF_MAX, Worker, backoff",
                    "",
                    "",
                    "@pytest.mark.parametrize(\"attempt,ceiling\", [(0, 0.25), (3, 2.0), (40, BACKOFF_MAX)])",
                    "def test_backoff_is_capped(attempt, ceiling):",
                    "    assert 0 < backoff(attempt, rand=lambda: 1.0) <= ceiling",
                    "",
                    "",
                    "def test_backoff_is_jittered():",
                    "    fast = backoff(4, rand=lambda: 0.0)",
                    "    slow = backoff(4, rand=lambda: 1.0)",
                    "    assert fast < slow",
                    "",
                    "",
                    "def test_worker_sleeps_instead_of_spinning(monkeypatch):",
                    "    slept = []",
                    "    monkeypatch.setattr(time, 'sleep', slept.append)",
                    "    broker = MagicMock()",
                    "    broker.take.side_effect = [BrokerUnavailable, BrokerUnavailable, None]",
                    "    with pytest.raises(StopIteration):",
                    "        Worker(broker, handler=MagicMock()).run_forever()",
                    "    assert len(slept) >= 2")}),
        ], usage(2780, 486, 980, 40)),
        result(ts(27), s, "tu_15", "Wrote 26 lines to services/ingest/tests/test_queue.py"),
        {"type": "user", "timestamp": ts(28), "sessionId": s, "isSidechain": True,
         "origin": {"kind": "subagent"},
         "message": {"content": "counting sleep calls in the sub-agent copy of the test"}},
        turn(ts(33), s, [
            call("tu_16", "Bash", {
                "command": "pytest services/ingest/tests/test_queue.py -q",
                "description": "run the new test file"}),
        ], usage(3120, 104, 980)),
        result(ts(37), s, "tu_16", "5 passed in 0.94s"),
        turn(ts(41), s, [
            call("tu_17", "Bash", {
                "command": "ruff check services/ingest && mypy services/ingest/queue.py",
                "description": "lint and type check the change"}),
        ], usage(3260, 96, 980)),
        result(ts(44), s, "tu_17", block(
            "All checks passed!",
            "Success: no issues found in 1 source file")),
        turn(ts(48), s, [
            say("`BrokerUnavailable` used to `continue` straight away, so a dead broker "
                "meant a hot loop. The retry path now sleeps for a capped, jittered "
                "backoff: `0.25 * 2**attempt`, halved to full via `random()` so two "
                "workers do not come back at the same instant.\n\n"
                "The attempt counter resets on the first job that arrives, so a healthy "
                "broker is never penalised for an old failure. Five tests cover the cap, "
                "the jitter, and the sleeping loop; ruff and mypy are clean."),
        ], usage(3420, 214, 980)),
        title(ts(58), s, "Add exponential backoff to the queue worker"),
        cost(ts(60), s, 1.3277, 31200, 8900, 132400, 78, 12),
    ]


def session_three():
    ts = at("2026-03-06T08:30:00")
    s = S3
    return [
        {"type": "user", "timestamp": ts(0), "sessionId": s,
         "message": {"content": [{"type": "text", "text": "<command-name>/model</command-name>"}]}},
        human(ts(5), s, "The tenant dashboard takes 40 seconds for our biggest customer. "
                        "Where is the time actually going?"),
        turn(ts(9), s, [
            think("Get the real plan before reading anything. The dashboard header query "
                  "is the obvious suspect."),
            call("tu_21", "Bash", {
                "command": "psql -d warehouse -f services/ingest/queries/tenant_dashboard.sql "
                           "--explain-analyze",
                "description": "profile the dashboard query"}),
        ], usage(1440, 112, 760, 44)),
        result(ts(48), s, "tu_21", EXPLAIN),
        turn(ts(52), s, [
            think("38 of the 40 seconds are the sequential scan over events. 8.1M rows "
                  "are read and discarded by the time filter, so the index either does "
                  "not exist or is not usable."),
            call("tu_22", "Read", {"file_path": "services/ingest/queries/tenant_dashboard.sql"}),
        ], usage(2088, 132, 760, 58)),
        result(ts(53), s, "tu_22", SQL),
        turn(ts(57), s, [
            call("tu_23", "Bash", {
                "command": "psql -d warehouse -c \"\\d events\"",
                "description": "list the indexes on events"}),
        ], usage(2340, 88, 760, 12)),
        result(ts(59), s, "tu_23", block(
            "Indexes:",
            "    \"events_pkey\" PRIMARY KEY, btree (id)",
            "    \"events_tenant_idx\" btree (tenant_id)",
            "  Partition key: RANGE (occurred_at)",
            "  Partitions: events_2026_01, events_2026_02, events_2026_03")),
        {"type": "user", "timestamp": ts(64), "sessionId": s,
         "message": {"content": [
             {"type": "text", "text": "[Request interrupted by user]"}]}},
        {"type": "user", "timestamp": ts(66), "sessionId": s, "isMeta": True,
         "message": {"content": [
             {"type": "text", "text": "<local-command-stdout>12 rows</local-command-stdout>"}]}},
        human(ts(70), s, "Stop - we already know it is the scan. What I need to know is "
                         "whether we can add a covering index on a live box without "
                         "taking the dashboard down."),
        turn(ts(74), s, [
            say("Yes, if this is Postgres 11 or newer: `CREATE INDEX CONCURRENTLY` builds "
                "without holding a write lock, so the dashboard keeps serving and the "
                "nightly ingest keeps writing.\n\n"
                "Two things decide whether it is safe here, and I cannot read them off "
                "the transcript:\n\n"
                "1. **Version** - partitioned tables only support concurrent index builds "
                "from 11 onward, and this table is range-partitioned by `occurred_at`.\n"
                "2. **Write volume** - a concurrent build does two passes over the table "
                "and waits for every transaction older than the build to finish, so it "
                "needs the long-running ingest transaction to end.\n\n"
                "Which Postgres version is the warehouse on, and can the index build run "
                "outside the ingest window?"),
        ], usage(2980, 342, 760, 0)),
        {"type": "assistant", "timestamp": ts(78), "sessionId": s, "isSidechain": True,
         "message": {"model": MODEL, "usage": usage(880, 64, 0, 22), "content": [
             say("Checking whether the partition key makes the index unusable: it does "
                 "not, but the predicate is not sargable as written.")]}},
        title(ts(84), s, "Dashboard query is slow for large tenants"),
        cost(ts(86), s, 2.1004, 22800, 1140, 258000, 0, 0),
    ]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for sid, build in ((S1, session_one), (S2, session_two), (S3, session_three)):
        path = OUT / (sid + ".jsonl")
        rows = build()
        with path.open("w", encoding="utf-8", newline="\n") as fh:
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        print("%-4d records  %s" % (len(rows), path.relative_to(HERE.parent)))


if __name__ == "__main__":
    main()