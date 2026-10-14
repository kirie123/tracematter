//! The data layer: read a file losslessly, describe its shape, and edit a value
//! in place without disturbing anything else on the line.
//!
//! Three properties this module exists to guarantee, because the older
//! `read_jsonl` command had none of them:
//!
//!   1. **Every line keeps its number and its bytes.** A row is
//!      `(line_no, raw, parsed)`. A line that does not parse is still a row —
//!      it comes back with its `error` set and its bytes intact, and is counted
//!      in `bad`. The old reader silently dropped those, which shifted every
//!      subsequent record's index and made the file un-editable.
//!   2. **Writing back is byte-preserving for untouched lines.** Only the rows
//!      that actually changed get re-serialised; everything else is copied
//!      verbatim. This is what makes an edit trustworthy on a 64,000-row file.
//!   3. **The source is never written by accident.** `fork` produces a *new*
//!      path and refuses to overwrite anything; only `overwrite` writes the
//!      original, and it takes a backup first and checks the guard.
//!
//! The guard is a (length, checksum) pair over the file bytes, captured at open
//! time. A save against a stale guard is refused rather than clobbering a file
//! that changed underneath the editor.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocKind {
    /// Newline-delimited JSON: one value per line.
    Jsonl,
    /// One JSON document with a trailing newline.
    JsonDoc,
}

/// What a file looks like it is. Detection is a scored guess with a stated
/// reason, never a silent assumption, and the UI lets the reader overrule it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Family {
    Unknown,
    /// harvey-labs `task.json`: a rubric with `criteria[]`.
    HarveyTask,
    /// harvey-labs `results/<run>/metrics.json` or `config.json`.
    HarveyRun,
    /// harvey-labs `scores_*.json`: a per-criterion verdict list.
    HarveyScores,
    /// An eval jsonl: `{model, n, acc}` head, then `{i, question, ref, pred, correct, gen}`.
    EvalSummary,
    EvalItems,
    /// A pass@k file: `pass_at_1..k` in the head, `{i, ref, preds, lens}` after.
    PassK,
    /// GRPO completions: `prompt` / `completion` / `reward` / `advantage`.
    GrpoCompletions,
    /// A training curve: `log_history[]`.
    TrainerCurve,
    /// An OpenAI chat-completion response.
    OpenAiChat,
    /// An OpenAI chat-completion request.
    OpenAiChatRequest,
    /// An Anthropic Messages API object or stream.
    AnthropicMessages,
    /// A Claude Code transcript.
    ClaudeCode,
}

/// One line of a line-oriented file, with its provenance intact.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// 1-based, counting every physical line including blanks. This is the
    /// anchor an edit addresses.
    pub line: u32,
    /// The exact bytes of the line, without its terminator.
    pub raw: String,
    /// The parsed value, when the line is JSON.
    pub value: Option<Value>,
    /// Why the line did not parse, when it did not.
    pub error: Option<String>,
}

/// A key seen across the sampled records: its type, how often it appears, and
/// one example. This is what a table lens builds its columns from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStat {
    pub path: String,
    /// Distinct JSON types seen at this path, e.g. `["string"]`.
    pub types: Vec<String>,
    /// Fraction of sampled objects carrying the key.
    pub coverage: f64,
    pub sample: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    pub keys: Vec<KeyStat>,
    /// How many records the shape was inferred from.
    pub sampled: usize,
    /// True when the sampled records share a key set closely enough to tabulate.
    pub tabular: bool,
}

/// The whole file, as the UI first sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub name: String,
    pub dir: String,
    pub kind: DocKind,
    pub family: Family,
    /// Why the family was chosen. Shown, so a wrong guess is visible.
    pub probe: Vec<String>,
    pub bytes: u64,
    pub mtime_ms: i64,
    /// The guard pair: a save is refused if the file no longer matches.
    pub guard_len: u64,
    pub guard_sum: u64,
    /// Total physical lines in the file.
    pub total_lines: u64,
    /// Rows in this page.
    pub rows: Vec<Row>,
    /// Lines that failed to parse, within the whole file.
    pub bad: u64,
    pub shape: Shape,
    /// For a whole-document JSON file: the parsed value and the original text.
    pub doc: Option<Value>,
    pub text: Option<String>,
    /// Present when the open was truncated for size; the UI says so.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Guard {
    pub len: u64,
    pub sum: u64,
}

impl Document {
    /// The guard pair for a save. Read from the fields rather than stored twice.
    pub fn guard(&self) -> Guard {
        Guard { len: self.guard_len, sum: self.guard_sum }
    }
}

// ---------------------------------------------------------------------------
// Addressing an edit
// ---------------------------------------------------------------------------

/// Where a value lives. One address type covers a JSONL row and a whole-document
/// JSON file, so the editor has a single path instead of two.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Anchor {
    /// A line-oriented file: which physical line, and (optionally) an RFC 6901
    /// pointer into that line's value. No pointer means "replace the whole row".
    Line { n: u32, pointer: Option<String> },
    /// A whole-document JSON file: an RFC 6901 pointer into the document.
    Pointer { p: String },
}

/// One change: where, and what to put there.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub anchor: Anchor,
    pub value: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetArgs {
    pub path: String,
    /// The target to write to. Only ever produced by `fork`, so a caller cannot
    /// invent one.
    pub target: String,
    /// Every change to apply, in one pass. More than one edit must be a single
    /// write, or the second would be rendered against the untouched source and
    /// silently undo the first.
    pub edits: Vec<Edit>,
    /// The guard captured when the document was opened.
    pub guard: Guard,
    /// Compute the bytes and return them without writing anything.
    #[serde(default)]
    pub dry_run: bool,
    /// Go ahead even though the guard no longer matches.
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub wrote: bool,
    pub target: String,
    pub source: String,
    pub bytes: u64,
    pub backup: Option<String>,
    /// The resulting file text, when the caller asked for a dry run.
    pub preview: Option<String>,
    /// Lines whose bytes differ from the source, for the UI's change count.
    pub changed_lines: Vec<u32>,
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// A cheap, order-sensitive checksum. Not cryptographic — the job is to notice
/// that a file changed underneath the editor, not to resist an attacker.
fn checksum(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).with_context(|| format!("read {}", path.display()))
}

/// Parse one line, distinguishing "not JSON" from "blank".
fn parse_row(line: u32, raw: &str) -> Row {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Row { line, raw: raw.to_string(), value: None, error: None };
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(v) => Row { line, raw: raw.to_string(), value: Some(v), error: None },
        Err(e) => Row {
            line,
            raw: raw.to_string(),
            value: None,
            error: Some(e.to_string()),
        },
    }
}

/// Read a line-oriented file keeping every line's number and bytes.
pub fn read_rows(path: &Path, offset: u64, limit: usize) -> Result<(Vec<Row>, u64, u64)> {
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = BufReader::with_capacity(1 << 20, file);
    let mut rows = Vec::new();
    let mut total = 0u64;
    let mut bad = 0u64;
    for (i, line) in reader.lines().enumerate() {
        let n = (i + 1) as u64;
        total = n;
        let raw = line.with_context(|| format!("read line {n} of {}", path.display()))?;
        let row = parse_row(n as u32, &raw);
        if row.error.is_some() {
            bad += 1;
        }
        if n > offset && rows.len() < limit {
            rows.push(row);
        }
    }
    Ok((rows, total, bad))
}

// ---------------------------------------------------------------------------
// Shape inference
// ---------------------------------------------------------------------------

fn type_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_i64() || n.is_u64() => "int",
        Value::Number(_) => "float",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Infer column definitions from a sample of records: which top-level keys
/// exist, how often, and what they hold. `tabular` is true when the sample is
/// homogeneous enough that a table is the honest rendering.
pub fn infer_shape(rows: &[Row]) -> Shape {
    use std::collections::BTreeMap;
    let objs: Vec<&serde_json::Map<String, Value>> = rows
        .iter()
        .filter_map(|r| r.value.as_ref())
        .filter_map(|v| v.as_object())
        .collect();
    if objs.is_empty() {
        return Shape::default();
    }
    let mut acc: BTreeMap<String, (BTreeMap<String, usize>, usize, Value)> = BTreeMap::new();
    for o in &objs {
        for (k, v) in o.iter() {
            let e = acc
                .entry(k.clone())
                .or_insert_with(|| (BTreeMap::new(), 0, v.clone()));
            *e.0.entry(type_of(v).to_string()).or_insert(0) += 1;
            e.1 += 1;
        }
    }
    let n = objs.len();
    let mut keys: Vec<KeyStat> = acc
        .into_iter()
        .map(|(path, (types, hits, sample))| KeyStat {
            path,
            types: types.into_keys().collect(),
            coverage: hits as f64 / n as f64,
            sample,
        })
        .collect();
    // Most-present keys first: that is the order a table wants its columns in.
    keys.sort_by(|a, b| {
        b.coverage
            .partial_cmp(&a.coverage)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
    let shared = keys.iter().filter(|k| k.coverage >= 0.8).count();
    let total_keys = keys.len();
    Shape {
        keys,
        sampled: n,
        tabular: n >= 4 && shared >= 2 && shared as f64 >= (total_keys as f64) * 0.6,
    }
}

// ---------------------------------------------------------------------------
// Family detection
// ---------------------------------------------------------------------------

fn is_obj(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .map(|o| keys.iter().all(|k| o.contains_key(*k)))
        .unwrap_or(false)
}

/// A pass@k head carries `pass_at_1` (or the older `mean_correct_of_G`).
fn has_passk_head(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    o.contains_key("mean_correct_of_G")
        || o.keys().any(|k| k.starts_with("pass_at_"))
        || o.get("E0").map(has_passk_head).unwrap_or(false)
        || o.get("E0p").map(has_passk_head).unwrap_or(false)
}

/// Score the file against the families we know, returning the winner and the
/// reasons for it. Order matters: the most specific test comes first.
pub fn detect(path: &Path, kind: DocKind, docs: &[&Value]) -> (Family, Vec<String>) {
    let mut why = Vec::new();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let has = |k: &str| name == k;
    let _ = &mut why;

    // -- tier 1: the path. Cheapest and most reliable, because the datasets are
    // organised by convention.
    if (has("task.json") || name.ends_with(".task.json")) && docs.iter().any(|d| d.get("criteria").is_some()) {
        why.push("filename is task.json and it carries a criteria list".into());
        return (Family::HarveyTask, why);
    }
    if has("metrics.json") || has("config.json") {
        if path.to_string_lossy().replace('\\', "/").contains("/results/") {
            why.push("lives under results/ and is named config/metrics".into());
            return (Family::HarveyRun, why);
        }
    }
    if name.starts_with("scores") && name.ends_with(".json") {
        why.push("filename starts with scores".into());
        return (Family::HarveyScores, why);
    }
    if has("trainer_state.json") {
        why.push("filename is trainer_state.json".into());
        return (Family::TrainerCurve, why);
    }

    // -- tier 2: the structure of the first meaningful record.
    let first = docs.iter().find(|d| !d.is_null());
    if let Some(f) = first {
        // pass@k before the eval check: a pass@k head also has `n`.
        if has_passk_head(f) {
            why.push("carries pass_at_* in its head".into());
            return (Family::PassK, why);
        }
        if is_obj(f, &["i", "ref", "preds", "lens"]) {
            why.push("rows are {i, ref, preds, lens}".into());
            return (Family::PassK, why);
        }
        if is_obj(f, &["model", "n", "acc"]) {
            why.push("head is {model, n, acc}".into());
            return (Family::EvalSummary, why);
        }
        if is_obj(f, &["i", "question", "ref", "pred", "correct", "gen"]) {
            why.push("rows are {i, question, ref, pred, correct, gen}".into());
            return (Family::EvalItems, why);
        }
        if is_obj(f, &["prompt", "completion"]) && f.get("reward").is_some() {
            why.push("rows are {prompt, completion, reward, advantage}".into());
            return (Family::GrpoCompletions, why);
        }
        if f.get("log_history").map(|v| v.is_array()).unwrap_or(false) {
            why.push("document carries a log_history array".into());
            return (Family::TrainerCurve, why);
        }
        if is_obj(f, &["criteria"]) {
            why.push("document carries a criteria list".into());
            return (Family::HarveyTask, why);
        }
        if is_obj(f, &["messages", "system"]) || is_obj(f, &["messages", "max_tokens"]) {
            why.push("document is an Anthropic Messages payload".into());
            return (Family::AnthropicMessages, why);
        }
        if f.get("type").and_then(|v| v.as_str()) == Some("message") {
            why.push("document is an Anthropic message".into());
            return (Family::AnthropicMessages, why);
        }
        if is_obj(f, &["choices"]) || f.get("object").and_then(|v| v.as_str()).map(|s| s.starts_with("chat.completion")).unwrap_or(false) {
            why.push("document is an OpenAI chat completion".into());
            return (Family::OpenAiChat, why);
        }
        if is_obj(f, &["messages", "model"]) {
            why.push("document is an OpenAI chat request".into());
            return (Family::OpenAiChatRequest, why);
        }
        if f.get("messages").map(|v| v.is_array()).unwrap_or(false) {
            why.push("document carries a messages array".into());
            return (Family::OpenAiChatRequest, why);
        }
        // A Claude Code transcript: typed records with block content.
        let typed = f.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if matches!(typed, "assistant" | "user" | "system")
            && (f.get("uuid").is_some() || f.get("message").map(|m| m.get("role").is_some()).unwrap_or(false))
        {
            why.push("records are typed transcript events".into());
            return (Family::ClaudeCode, why);
        }
    }

    match kind {
        DocKind::Jsonl => why.push("unrecognised jsonl - shown as a tree and a generic table".into()),
        DocKind::JsonDoc => why.push("unrecognised json document".into()),
    }
    (Family::Unknown, why)
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

fn read_whole_doc(path: &Path) -> Result<(Value, String)> {
    let bytes = read_bytes(path)?;
    // Strip a UTF-8 BOM; some Windows tools write one and serde_json refuses it.
    let text = String::from_utf8_lossy(&bytes)
        .trim_start_matches('\u{feff}')
        .to_string();
    let v: Value = serde_json::from_str(&text).with_context(|| {
        format!(
            "{} is not a single JSON document",
            path.file_name().unwrap_or_default().to_string_lossy()
        )
    })?;
    Ok((v, text))
}

/// Is this file line-oriented? A `.jsonl` always is. A `.json` is one document
/// unless the first non-blank line parses as a complete value *and* the second
/// one does too, which means it is really a stream.
fn is_line_oriented(path: &Path, bytes: &[u8]) -> bool {
    let ext = path
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext == "jsonl" || ext == "ndjson" {
        return true;
    }
    if ext != "json" {
        return false;
    }
    let text = String::from_utf8_lossy(bytes);
    let mut parsed = 0;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if serde_json::from_str::<Value>(t).is_err() {
            return false;
        }
        parsed += 1;
        if parsed >= 2 {
            return true;
        }
    }
    false
}

/// Open a file for reading. `limit` bounds how many rows travel; `0` means the
/// default page.
pub fn open(path: &Path, limit: usize) -> Result<Document> {
    if !path.exists() {
        return Err(anyhow!("{} does not exist", path.display()));
    }
    let meta = fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
    let bytes = read_bytes(path)?;
    let guard = Guard { len: bytes.len() as u64, sum: checksum(&bytes) };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let kind = if is_line_oriented(path, &bytes) {
        DocKind::Jsonl
    } else {
        DocKind::JsonDoc
    };

    let mut note = None;
    let page_size = if limit == 0 { 400 } else { limit };

    match kind {
        DocKind::Jsonl => {
            let (rows, total_lines, bad) = read_rows(path, 0, page_size)?;
            if total_lines as usize > rows.len() {
                note = Some(format!(
                    "showing {} of {total_lines} lines",
                    rows.len()
                ));
            }
            let shape = infer_shape(&rows);
            let docs: Vec<&Value> = rows.iter().take(24).filter_map(|r| r.value.as_ref()).collect();
            let (family, probe) = detect(path, kind, &docs);
            Ok(Document {
                path: path.to_string_lossy().to_string(),
                name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                dir: path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                kind,
                family,
                probe,
                bytes: bytes.len() as u64,
                mtime_ms,
                guard_len: guard.len,
                guard_sum: guard.sum,
                total_lines,
                rows,
                bad,
                shape,
                doc: None,
                text: None,
                note,
            })
        }
        DocKind::JsonDoc => {
            let (doc, text) = read_whole_doc(path)?;
            let samples: Vec<&Value> = match &doc {
                Value::Array(items) => items.iter().take(24).collect(),
                other => vec![other],
            };
            let shape = infer_shape(
                &samples
                    .iter()
                    .map(|v| Row { line: 0, raw: String::new(), value: Some((*v).clone()), error: None })
                    .collect::<Vec<_>>(),
            );
            let (family, probe) = detect(path, kind, &samples);
            Ok(Document {
                path: path.to_string_lossy().to_string(),
                name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                dir: path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                kind,
                family,
                probe,
                bytes: bytes.len() as u64,
                mtime_ms,
                guard_len: guard.len,
                guard_sum: guard.sum,
                total_lines: text.lines().count() as u64,
                rows: Vec::new(),
                bad: 0,
                shape,
                doc: Some(doc),
                text: Some(text),
                note,
            })
        }
    }
}

/// One row, by line number, with no preview clipping. This is how a cell asks
/// for the value the first page deliberately left out.
pub fn row_at(path: &Path, line: u32) -> Result<Row> {
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = BufReader::new(file);
    for (i, l) in reader.lines().enumerate() {
        if (i + 1) as u32 == line {
            return Ok(parse_row(line, &l?));
        }
    }
    Err(anyhow!("{} has no line {line}", path.display()))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Apply a value at a pointer inside a JSON value. RFC 6901, the subset that
/// can be expressed with object keys and array indices.
fn set_pointer(root: &mut Value, pointer: &str, value: Value) -> Result<()> {
    if pointer.is_empty() {
        *root = value;
        return Ok(());
    }
    let tokens: Vec<String> = pointer
        .trim_start_matches('/')
        .split('/')
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect();
    let mut cur = root;
    for (i, tok) in tokens.iter().enumerate() {
        let last = i + 1 == tokens.len();
        match cur {
            Value::Object(map) => {
                if last {
                    map.insert(tok.clone(), value);
                    return Ok(());
                }
                cur = map
                    .get_mut(tok)
                    .ok_or_else(|| anyhow!("no key `{tok}` on the way to `{pointer}`"))?;
            }
            Value::Array(items) => {
                let idx: usize = tok
                    .parse()
                    .map_err(|_| anyhow!("`{tok}` is not an array index in `{pointer}`"))?;
                if last {
                    let slot = items
                        .get_mut(idx)
                        .ok_or_else(|| anyhow!("index {idx} is past the end of `{pointer}`"))?;
                    *slot = value;
                    return Ok(());
                }
                cur = items
                    .get_mut(idx)
                    .ok_or_else(|| anyhow!("index {idx} is past the end of `{pointer}`"))?;
            }
            _ => return Err(anyhow!("`{pointer}` runs into a scalar value")),
        }
    }
    Ok(())
}

/// Produce the new file text for a set of edits, without writing anything.
/// Returns the text and the line numbers whose bytes changed.
///
/// All edits are applied in a single pass over the source. That matters: a
/// naive loop that re-rendered the file once per edit would render the second
/// edit against the original bytes and silently drop the first.
fn render_edits(path: &Path, edits: &[Edit]) -> Result<(String, Vec<u32>)> {
    if edits.is_empty() {
        let text = String::from_utf8_lossy(&read_bytes(path)?).to_string();
        return Ok((text, Vec::new()));
    }
    let bytes = read_bytes(path)?;
    let text = String::from_utf8_lossy(&bytes).to_string();

    // Split the edits by kind. A document has exactly one root, so a pointer
    // edit is applied to the document value; line edits are applied per line.
    let doc_edits: Vec<&Edit> = edits
        .iter()
        .filter(|e| matches!(e.anchor, Anchor::Pointer { .. }))
        .collect();
    let mut by_line: std::collections::BTreeMap<u32, Vec<&Edit>> = Default::default();
    for e in edits {
        if let Anchor::Line { n, .. } = &e.anchor {
            by_line.entry(*n).or_default().push(e);
        }
    }

    if !doc_edits.is_empty() {
        let (mut doc, _) = read_whole_doc(path)?;
        for e in &doc_edits {
            if let Anchor::Pointer { p } = &e.anchor {
                set_pointer(&mut doc, p, e.value.clone())?;
            }
        }
        let mut s = serde_json::to_string_pretty(&doc)?;
        s.push('\n');
        let changed: Vec<u32> = (1..=(text.lines().count() as u32)).collect();
        return Ok((s, changed));
    }

    let mut out = String::with_capacity(text.len() + 128);
    let mut changed: Vec<u32> = Vec::new();
    let mut seen: std::collections::BTreeSet<u32> = Default::default();
    for (i, line) in text.lines().enumerate() {
        let ln = (i + 1) as u32;
        let Some(edits_here) = by_line.get(&ln) else {
            // Untouched lines are copied byte for byte. This is the property
            // the whole editor rests on.
            out.push_str(line);
            out.push('\n');
            continue;
        };
        seen.insert(ln);
        let mut v: Value = serde_json::from_str(line.trim())
            .with_context(|| format!("line {ln} is not JSON, so it cannot be edited by field"))?;
        for e in edits_here {
            match &e.anchor {
                Anchor::Line { pointer: Some(p), .. } if !p.is_empty() => {
                    set_pointer(&mut v, p, e.value.clone())?
                }
                _ => v = e.value.clone(),
            }
        }
        let s = serde_json::to_string(&v)?;
        if s != line {
            changed.push(ln);
        }
        out.push_str(&s);
        out.push('\n');
    }
    let missing: Vec<u32> = by_line.keys().copied().filter(|n| !seen.contains(n)).collect();
    if let Some(n) = missing.first() {
        return Err(anyhow!("line {n} is past the end of the file"));
    }
    Ok((out, changed))
}

/// Write `text` to `target` atomically: a sibling temp file, then a rename.
/// A rename inside one directory does not leave a half-written file behind.
fn write_atomic(target: &Path, text: &str) -> Result<u64> {
    let dir = target.parent().ok_or_else(|| anyhow!("{} has no parent", target.display()))?;
    let pid = std::process::id();
    let tmp = dir.join(format!(
        ".{}.tm-{pid}.tmp",
        target.file_name().unwrap_or_default().to_string_lossy()
    ));
    {
        let mut f = fs::File::create(&tmp)
            .with_context(|| format!("create {}", tmp.display()))?;
        f.write_all(text.as_bytes())?;
        f.sync_all().ok();
    }
    // On Windows a rename onto an existing file fails, so clear the way first.
    // The window is a few microseconds and the temp file is already complete.
    if target.exists() {
        fs::remove_file(target).with_context(|| format!("replace {}", target.display()))?;
    }
    fs::rename(&tmp, target).with_context(|| {
        let _ = fs::remove_file(&tmp);
        format!("move {} into place", target.display())
    })?;
    Ok(text.len() as u64)
}

fn check_guard(path: &Path, want: Guard) -> Result<()> {
    let bytes = read_bytes(path)?;
    let got = Guard { len: bytes.len() as u64, sum: checksum(&bytes) };
    if got.len != want.len || got.sum != want.sum {
        return Err(anyhow!(
            "the file changed on disk since it was opened ({} bytes then, {} now) - reopen it or save with force",
            want.len,
            got.len
        ));
    }
    Ok(())
}

/// Write an edit to `target`. Never touches the source.
pub fn set_value(args: &SetArgs) -> Result<SaveResult> {
    let source = PathBuf::from(&args.path);

    // The edit is always rendered from the *source*, so a target is a pure
    // output and re-running is idempotent.
    let (text, changed) = render_edits(&source, &args.edits)?;

    if args.dry_run {
        return Ok(SaveResult {
            wrote: false,
            target: args.target.clone(),
            source: args.path.clone(),
            bytes: text.len() as u64,
            backup: None,
            preview: Some(text),
            changed_lines: changed,
        });
    }

    if !args.force {
        check_guard(&source, args.guard)?;
    }

    let target = PathBuf::from(&args.target);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let bytes = write_atomic(&target, &text)?;
    Ok(SaveResult {
        wrote: true,
        target: args.target.clone(),
        source: args.path.clone(),
        bytes,
        backup: None,
        preview: None,
        changed_lines: changed,
    })
}

/// Pick a fresh sibling path for an edited copy: `<stem>.edited.<ext>`, then
/// `.edited.2`, and so on. Never returns an existing path.
pub fn fork_path(source: &Path) -> Result<PathBuf> {
    let dir = source.parent().ok_or_else(|| anyhow!("{} has no parent", source.display()))?;
    let stem = source
        .file_stem()
        .ok_or_else(|| anyhow!("{} has no stem", source.display()))?
        .to_string_lossy()
        .to_string();
    let ext = source
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let first = dir.join(format!("{stem}.edited{ext}"));
    if !first.exists() {
        return Ok(first);
    }
    for n in 2..10_000u32 {
        let p = dir.join(format!("{stem}.edited.{n}{ext}"));
        if !p.exists() {
            return Ok(p);
        }
    }
    Err(anyhow!("too many edited copies of {stem} in {}", dir.display()))
}

/// Write the source in place, after a timestamped backup. This is the only
/// function in the app that overwrites a file it did not create.
pub fn overwrite(args: &SetArgs) -> Result<SaveResult> {
    let source = PathBuf::from(&args.path);
    if !args.force {
        check_guard(&source, args.guard)?;
    }
    let (text, changed) = render_edits(&source, &args.edits)?;

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let backup = source.with_file_name(format!(
        "{}.{stamp}.bak",
        source.file_name().unwrap_or_default().to_string_lossy()
    ));
    fs::copy(&source, &backup)
        .with_context(|| format!("back up {} to {}", source.display(), backup.display()))?;

    let bytes = write_atomic(&source, &text)?;
    Ok(SaveResult {
        wrote: true,
        target: args.path.clone(),
        source: args.path.clone(),
        bytes,
        backup: Some(backup.to_string_lossy().to_string()),
        preview: None,
        changed_lines: changed,
    })
}

/// A unified-ish diff between two texts, capped so a giant file cannot flood
/// the UI. Line-by-line; enough to show what a save will do.
pub fn diff_text(old: &str, new: &str, max_lines: usize) -> String {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let mut out = String::new();
    let mut shown = 0usize;
    // A whole-file diff is expensive; compare the shorter of the two by index
    // and report insertions at the tail. This is a preview, not a merge tool.
    let common = a.len().min(b.len());
    let mut i = 0usize;
    while i < common {
        if a[i] != b[i] {
            if shown >= max_lines {
                out.push_str("... diff truncated ...\n");
                return out;
            }
            out.push_str(&format!("- {}\n+ {}\n", trim_for_diff(a[i]), trim_for_diff(b[i])));
            shown += 1;
            // Skip a run of differing lines in one hunk.
            let mut j = i + 1;
            while j < common && a[j] != b[j] && shown < max_lines {
                out.push_str(&format!("- {}\n+ {}\n", trim_for_diff(a[j]), trim_for_diff(b[j])));
                shown += 1;
                j += 1;
            }
            i = j;
            continue;
        }
        i += 1;
    }
    if a.len() != b.len() {
        out.push_str(&format!(
            "... {} lines became {} lines ...\n",
            a.len(),
            b.len()
        ));
    }
    if out.is_empty() {
        out.push_str("(no change)\n");
    }
    out
}

fn trim_for_diff(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= 240 {
        return t.to_string();
    }
    let head: String = t.chars().take(240).collect();
    format!("{head}...")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tm-data-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A line edit at `n`, optionally aimed at a pointer inside that line.
    fn le(n: u32, pointer: Option<&str>, v: Value) -> Edit {
        Edit {
            anchor: Anchor::Line { n, pointer: pointer.map(|s| s.to_string()) },
            value: v,
        }
    }

    #[test]
    fn blank_and_bad_lines_keep_their_numbers() {
        let d = tmp_dir("bad");
        let p = d.join("a.jsonl");
        fs::write(&p, "{\"a\":1}\n\nnot json\n{\"a\":2}\n").unwrap();
        let (rows, total, bad) = read_rows(&p, 0, 100).unwrap();
        assert_eq!(total, 4, "every physical line is counted");
        assert_eq!(rows.len(), 4, "the blank line is a row too");
        assert_eq!(bad, 1, "the malformed line is counted, not dropped");
        assert_eq!(rows[0].line, 1);
        assert_eq!(rows[2].line, 3);
        assert!(rows[2].error.is_some());
        assert_eq!(rows[2].raw, "not json", "the bad line keeps its bytes");
        assert_eq!(rows[3].value.as_ref().unwrap()["a"], json!(2));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn untouched_lines_come_back_byte_identical() {
        let d = tmp_dir("fidelity");
        let p = d.join("a.jsonl");
        // Deliberately odd spacing on the lines we will not touch.
        let original = "{\"z\":1,   \"a\":2}\n{\"b\":  3}\n{\"c\":4}\n";
        fs::write(&p, original).unwrap();
        let (text, changed) = render_edits(&p, &[le(3, None, json!({"c": 99}))]).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "{\"z\":1,   \"a\":2}", "line 1 is copied verbatim");
        assert_eq!(lines[1], "{\"b\":  3}", "line 2 is copied verbatim");
        assert_eq!(changed, vec![3]);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn key_order_is_preserved_in_an_edited_line() {
        let d = tmp_dir("order");
        let p = d.join("a.jsonl");
        fs::write(&p, "{\"zebra\":1,\"apple\":2}\n").unwrap();
        let (text, _) = render_edits(&p, &[le(1, None, json!({"zebra":1,"apple":9}))]).unwrap();
        assert!(
            text.starts_with("{\"zebra\":1,\"apple\":9}"),
            "keys must not be alphabetised, got {text}"
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_pointer_edit_touches_only_that_field() {
        let d = tmp_dir("ptr");
        let p = d.join("a.jsonl");
        fs::write(&p, "{\"id\":\"C-1\",\"title\":\"t\",\"match_criteria\":\"old\"}\n").unwrap();
        let (text, changed) =
            render_edits(&p, &[le(1, Some("/match_criteria"), json!("new"))]).unwrap();
        let v: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(v["id"], json!("C-1"));
        assert_eq!(v["match_criteria"], json!("new"));
        assert_eq!(changed, vec![1]);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn fork_never_returns_an_existing_path() {
        let d = tmp_dir("fork");
        let p = d.join("t.json");
        fs::write(&p, "{}").unwrap();
        let f1 = fork_path(&p).unwrap();
        assert!(f1.to_string_lossy().ends_with("t.edited.json"));
        fs::write(&f1, "{}").unwrap();
        let f2 = fork_path(&p).unwrap();
        assert!(f2.to_string_lossy().ends_with("t.edited.2.json"));
        assert_ne!(f1, f2);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_stale_guard_refuses_the_write() {
        let d = tmp_dir("guard");
        let p = d.join("a.jsonl");
        fs::write(&p, "{\"a\":1}\n").unwrap();
        let doc = open(&p, 0).unwrap();
        // Something else edits the file behind our back.
        fs::write(&p, "{\"a\":1}\n{\"b\":2}\n").unwrap();
        let args = SetArgs {
            path: p.to_string_lossy().to_string(),
            target: d.join("out.jsonl").to_string_lossy().to_string(),
            edits: vec![le(1, None, json!({"a": 5}))],
            guard: doc.guard(),
            dry_run: false,
            force: false,
        };
        let e = set_value(&args).unwrap_err().to_string();
        assert!(e.contains("changed on disk"), "got: {e}");
        assert!(!d.join("out.jsonl").exists(), "nothing was written");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn overwrite_leaves_a_backup_of_the_original() {
        let d = tmp_dir("backup");
        let p = d.join("a.jsonl");
        fs::write(&p, "{\"a\":1}\n").unwrap();
        let doc = open(&p, 0).unwrap();
        let args = SetArgs {
            path: p.to_string_lossy().to_string(),
            target: p.to_string_lossy().to_string(),
            edits: vec![le(1, None, json!({"a": 2}))],
            guard: doc.guard(),
            dry_run: false,
            force: false,
        };
        let res = overwrite(&args).unwrap();
        let bak = res.backup.expect("a backup path");
        assert_eq!(fs::read_to_string(&bak).unwrap(), "{\"a\":1}\n");
        assert_eq!(fs::read_to_string(&p).unwrap(), "{\"a\":2}\n");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn shape_finds_the_columns_and_marks_it_tabular() {
        let rows: Vec<Row> = (0..6)
            .map(|i| Row {
                line: i + 1,
                raw: String::new(),
                value: Some(json!({"i": i, "q": "x", "ok": true})),
                error: None,
            })
            .collect();
        let s = infer_shape(&rows);
        assert!(s.tabular);
        assert_eq!(s.sampled, 6);
        assert_eq!(s.keys.iter().map(|k| k.path.as_str()).collect::<Vec<_>>(), vec!["i", "ok", "q"]);
        assert!((s.keys[0].coverage - 1.0).abs() < 1e-9);
    }

    #[test]
    fn detection_reads_a_passk_head_before_an_eval_head() {
        let head = json!({"n": 200, "E0": {"pass_at_1": 0.63, "mean_correct_of_G": 10.1}});
        let (fam, _) = detect(Path::new("x.jsonl"), DocKind::Jsonl, &[&head]);
        assert_eq!(fam, Family::PassK);
    }

    #[test]
    fn detection_reads_a_harvey_task() {
        let t = json!({"title": "T", "instructions": "I", "criteria": [{"id": "C-001"}]});
        let (fam, _) = detect(Path::new("task.json"), DocKind::JsonDoc, &[&t]);
        assert_eq!(fam, Family::HarveyTask);
    }
}
