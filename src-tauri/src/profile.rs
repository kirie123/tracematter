//! Format profiles: declarative mappings from a foreign event stream into the
//! canonical trace format documented in `docs/TRACE_FORMAT.md`.
//!
//! A profile is a small program in JSON. It says which records to look at, how to
//! recognise them, and how to spell each canonical field. It exists because every
//! harness invents its own vocabulary and rewriting a parser per harness does not
//! scale; most differences are a rename and a reshape, which is what a profile
//! expresses. Formats that genuinely need code get a converter script instead
//! (see `docs/ADAPTERS.md`).
//!
//! Profiles come from two places: the ones compiled into the binary (a starting
//! point for the harnesses people actually use) and any `*.json` in the user's
//! profiles directory, which is where an adapter written for a one-off format
//! lands. A user profile with the same id as a built-in replaces it.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Built-in profiles. Kept in the repository as plain JSON so they can be read,
/// copied and edited without touching Rust.
const BUILTIN: &[(&str, &str)] = &[
    ("claude-code", include_str!("../profiles/claude-code.json")),
    ("openai-messages", include_str!("../profiles/openai-messages.json")),
    ("codex", include_str!("../profiles/codex.json")),
    ("openai-tool-calls", include_str!("../profiles/openai-tool-calls.json")),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source: Source,
    /// Hoist a nested payload over its envelope before mapping.
    ///
    /// Event envelopes wrap the interesting part under a key:
    /// `{"type":"response.output_item.added","item":{...}}`. Naming that
    /// key here makes the payload addressable directly, so a mapping is
    /// written once instead of duplicating every path with a fallback.
    /// Payload fields win over the envelope's own, because the envelope's
    /// `type` describes the envelope, not the record inside it.
    #[serde(default)]
    pub unwrap: Option<String>,
    /// Detection hints, evaluated against a sample of an unknown file.
    #[serde(default, rename = "match")]
    pub matches: Option<Selector>,
    pub records: Vec<RecordRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Source {
    /// One JSON value per line, the usual case.
    Jsonl,
    /// A single document holding an array of events.
    Doc { array: String },
}

impl Default for Source {
    fn default() -> Self {
        Source::Jsonl
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRule {
    /// Omitted means "always", which is how a catch-all rule is written.
    #[serde(default)]
    pub when: Option<Selector>,
    /// Emit the input record unchanged.
    ///
    /// This is what makes a profile for an already-canonical format trivial: the
    /// identity mapping becomes one line of JSON instead of a transcription of
    /// every field.
    #[serde(default)]
    pub passthrough: bool,
    #[serde(flatten)]
    pub emit: Emit,
}

/// A boolean test over an input record. Deliberately small: compare a path to a
/// value, test whether it exists, test its JSON type, and combine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selector {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub equals: Option<Value>,
    #[serde(default, rename = "in")]
    pub one_of: Option<Vec<Value>>,
    #[serde(default)]
    pub exists: Option<bool>,
    /// `string`, `array`, `number`, `object`, `bool`, `null`.
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub all: Option<Vec<Selector>>,
    #[serde(default)]
    pub any: Option<Vec<Selector>>,
    #[serde(default)]
    pub not: Option<Box<Selector>>,
}

impl Selector {
    pub fn test(&self, root: &Value) -> bool {
        if let Some(list) = &self.all {
            if !list.iter().all(|s| s.test(root)) {
                return false;
            }
        }
        if let Some(list) = &self.any {
            if !list.iter().any(|s| s.test(root)) {
                return false;
            }
        }
        if let Some(inner) = &self.not {
            if inner.test(root) {
                return false;
            }
        }
        let leaf = self.path.is_some()
            || self.equals.is_some()
            || self.one_of.is_some()
            || self.exists.is_some()
            || self.kind.is_some();
        if !leaf {
            return true;
        }
        let got = self.path.as_deref().and_then(|p| get(root, p));
        let present = matches!(got, Some(v) if !v.is_null());

        if let Some(want) = self.exists {
            if present != want {
                return false;
            }
        }
        if let Some(kind) = &self.kind {
            let ok = match (kind.as_str(), got) {
                ("string", Some(Value::String(_))) => true,
                ("array", Some(Value::Array(_))) => true,
                ("object", Some(Value::Object(_))) => true,
                ("number", Some(Value::Number(_))) => true,
                ("bool", Some(Value::Bool(_))) => true,
                ("null", Some(Value::Null)) | ("null", None) => true,
                _ => false,
            };
            if !ok {
                return false;
            }
        }
        if let Some(want) = &self.equals {
            match got {
                Some(v) if loose_eq(v, want) => {}
                _ => return false,
            }
        }
        if let Some(list) = &self.one_of {
            let hit = match got {
                Some(v) => list.iter().any(|w| loose_eq(v, w)),
                None => false,
            };
            if !hit {
                return false;
            }
        }
        true
    }
}

/// Numbers read from JSON and from profile literals should compare equal even
/// when one side is `1` and the other `1.0`.
fn loose_eq(a: &Value, b: &Value) -> bool {
    if a == b {
        return true;
    }
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => (x - y).abs() < f64::EPSILON,
        _ => false,
    }
}

/// A value in the output, computed from the input record.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSpec {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub constant: Option<Value>,
    /// First spec that yields a non-null value wins.
    #[serde(default)]
    pub first: Option<Vec<FieldSpec>>,
    /// Translate a value through a table, with an optional fallback.
    #[serde(default)]
    pub lookup: Option<Lookup>,
    /// Concatenate specs as text. Used for synthetic ids and titles.
    #[serde(default)]
    pub cat: Option<Vec<FieldSpec>>,
    /// Parse a JSON document carried inside a string, which is how tool
    /// arguments arrive from every OpenAI-shaped API.
    #[serde(default)]
    pub parse_json: Option<Box<FieldSpec>>,
    /// Numeric difference, floored at zero.
    ///
    /// Needed because several APIs report a total that already includes a part
    /// the canonical format keeps separate. A mapping that ignores that does not
    /// merely lose a field, it double counts the context window and reports a
    /// session that is twice as expensive as it really was.
    #[serde(default)]
    pub sub: Option<Vec<FieldSpec>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    pub path: String,
    pub table: BTreeMap<String, Value>,
    #[serde(default)]
    pub default: Option<Value>,
}

impl FieldSpec {
    pub fn const_str(s: &str) -> Self {
        FieldSpec {
            constant: Some(Value::String(s.to_string())),
            ..Default::default()
        }
    }

    pub fn path(p: &str) -> Self {
        FieldSpec {
            path: Some(p.to_string()),
            ..Default::default()
        }
    }

    pub fn eval(&self, root: &Value) -> Option<Value> {
        if let Some(p) = &self.path {
            return get(root, p).cloned().filter(|v| !v.is_null());
        }
        if let Some(c) = &self.constant {
            return Some(c.clone());
        }
        if let Some(list) = &self.first {
            for s in list {
                if let Some(v) = s.eval(root) {
                    return Some(v);
                }
            }
            return None;
        }
        if let Some(l) = &self.lookup {
            let key = get(root, &l.path).and_then(text_of);
            if let Some(k) = key {
                if let Some(v) = l.table.get(&k) {
                    return Some(v.clone());
                }
            }
            return l.default.clone();
        }
        if let Some(list) = &self.cat {
            let mut out = String::new();
            for s in list {
                if let Some(v) = s.eval(root) {
                    out.push_str(&text_of(&v).unwrap_or_default());
                }
            }
            return Some(Value::String(out));
        }
        if let Some(inner) = &self.parse_json {
            let raw = inner.eval(root)?;
            let s = text_of(&raw)?;
            return serde_json::from_str::<Value>(&s).ok();
        }
        if let Some(list) = &self.sub {
            let mut it = list.iter();
            let mut acc = it.next()?.eval_f64(root)?;
            for s in it {
                acc -= s.eval_f64(root).unwrap_or(0.0);
            }
            return Some(json!(acc.max(0.0)));
        }
        None
    }

    pub fn eval_text(&self, root: &Value) -> Option<String> {
        self.eval(root).and_then(|v| text_of(&v))
    }

    pub fn eval_u64(&self, root: &Value) -> Option<u64> {
        match self.eval(root)? {
            Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64)),
            Value::String(s) => s.trim().parse::<f64>().ok().map(|f| f.max(0.0) as u64),
            Value::Bool(b) => Some(b as u64),
            _ => None,
        }
    }

    pub fn eval_bool(&self, root: &Value) -> Option<bool> {
        match self.eval(root)? {
            Value::Bool(b) => Some(b),
            Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
                "true" | "yes" | "1" => Some(true),
                "false" | "no" | "0" => Some(false),
                _ => None,
            },
            Value::Number(n) => Some(n.as_f64().unwrap_or(0.0) != 0.0),
            _ => None,
        }
    }

    pub fn eval_f64(&self, root: &Value) -> Option<f64> {
        match self.eval(root)? {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        }
    }
}

/// Resolve a dotted path with optional `[n]` indices.
///
/// Supports `a.b`, `a[0].b`, `a.0.b` and a leading `$` (so JSONPath habits work).
/// A bare `.` or empty path means the root.
pub fn get<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let path = path.trim();
    if path.is_empty() || path == "." || path == "$" {
        return Some(root);
    }
    let path = path.strip_prefix("$.").unwrap_or(path);
    let path = path.strip_prefix('$').unwrap_or(path);
    let mut cur = root;
    for raw in path.split('.') {
        if raw.is_empty() {
            continue;
        }
        let (name, indices) = split_indices(raw);
        if !name.is_empty() {
            match cur {
                Value::Object(m) => cur = m.get(name)?,
                _ => return None,
            }
        }
        for idx in indices {
            match cur {
                Value::Array(a) => cur = a.get(idx)?,
                _ => return None,
            }
        }
    }
    Some(cur)
}

/// Split `items[2][3]` into `("items", [2, 3])`.
fn split_indices(seg: &str) -> (&str, Vec<usize>) {
    let mut name = seg;
    let mut idx = Vec::new();
    if let Some(open) = seg.find('[') {
        name = &seg[..open];
        let mut rest = &seg[open..];
        while let Some(close) = rest.find(']') {
            if let Ok(n) = rest[1..close].trim().parse::<usize>() {
                idx.push(n);
            }
            rest = &rest[close + 1..];
        }
    } else if !seg.is_empty() && seg.chars().all(|c| c.is_ascii_digit()) {
        // Pure-numeric segment: an index written as `a.0.b`.
        name = "";
        if let Ok(n) = seg.parse::<usize>() {
            idx.push(n);
        }
    }
    (name, idx)
}

/// Best-effort text view of a JSON value. Objects and arrays are serialised,
/// because that is more useful in a transcript than the word "object".
pub fn text_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Null => None,
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Array(a) => {
            let joined: Vec<String> = a.iter().filter_map(text_of).collect();
            Some(joined.join("
"))
        }
        Value::Object(o) => serde_json::to_string(o).ok(),
    }
}

/// Flatten a `content` value into a body string.
///
/// Tool results arrive as a string, as an array of `{type, text}` parts, or as a
/// single object. All three collapse to text here so downstream code can treat
/// a result as one thing.
fn flatten_content(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|it| match it {
                    Value::String(s) => Some(s.clone()),
                    Value::Object(_) => it
                        .get("text")
                        .and_then(|t| t.as_str().map(|x| x.to_string()))
                        .or_else(|| it.get("content").and_then(|c| flatten_content(c))),
                    _ => None,
                })
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("
"))
            }
        }
        Value::Object(_) => v
            .get("text")
            .and_then(|t| t.as_str().map(|x| x.to_string()))
            .or_else(|| serde_json::to_string(v).ok()),
        _ => text_of(v),
    }
}

/// Run every block rule that fires and collect the canonical blocks.
fn build_blocks(rules: &[BlockRule], rec: &Value) -> Option<Vec<Value>> {
    let mut out = Vec::new();
    for rule in rules {
        let hit = match &rule.when {
            Some(sel) => sel.test(rec),
            None => true,
        };
        if !hit {
            continue;
        }
        match &rule.each {
            Some(path) => {
                let items = match get(rec, path) {
                    Some(Value::Array(a)) => a.clone(),
                    Some(other) => vec![other.clone()],
                    None => continue,
                };
                for item in items {
                    // Show the element as the root, but keep the enclosing record
                    // reachable under `__parent` so a rule can graft fields across.
                    let root = merge_parent(&item, rec);
                    if let Some(b) = block(&rule.kind, &rule.fields, rule.flatten.as_deref(), &root) {
                        out.push(b);
                    }
                }
            }
            None => {
                if let Some(b) = block(&rule.kind, &rule.fields, rule.flatten.as_deref(), rec) {
                    out.push(b);
                }
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Expose the containing record to a per-element rule without clobbering the
/// element's own keys.
fn merge_parent(item: &Value, parent: &Value) -> Value {
    match item {
        Value::Object(map) => {
            let mut m = map.clone();
            m.insert("__parent".into(), parent.clone());
            Value::Object(m)
        }
        other => json!({ "value": other, "__parent": parent }),
    }
}

/// Materialise one block. A block with no fields left is dropped, which keeps
/// empty rules from littering the timeline with blank entries.
fn block(
    kind: &str,
    fields: &BTreeMap<String, FieldSpec>,
    flatten: Option<&str>,
    root: &Value,
) -> Option<Value> {
    let mut out = Map::new();
    out.insert("type".into(), Value::String(kind.to_string()));
    for (name, spec) in fields {
        if Some(name.as_str()) == flatten {
            continue;
        }
        if let Some(v) = spec.eval(root) {
            out.insert(name.clone(), v);
        }
    }
    if let Some(name) = flatten {
        if let Some(spec) = fields.get(name) {
            if let Some(raw) = spec.eval(root) {
                if let Some(text) = flatten_content(&raw) {
                    out.insert(name.to_string(), Value::String(text));
                }
            }
        }
    }

    // A field can legitimately point at an array of parts; the reader wants a
    // string there, so coerce instead of emitting a shape it will ignore.
    for key in ["text", "thinking"] {
        if let Some(v) = out.get(key) {
            if !v.is_string() {
                match flatten_content(v) {
                    Some(s) => {
                        out.insert(key.to_string(), Value::String(s));
                    }
                    None => {
                        out.remove(key);
                    }
                }
            }
        }
    }

    match kind {
        "text" | "thinking" => {
            // A block with no text is noise; a redacted thinking block is not.
            if !out.contains_key("text") && !out.contains_key("thinking") {
                return None;
            }
        }
        "tool_use" => {
            if !out.contains_key("name") {
                return None;
            }
            out.entry("input".to_string()).or_insert_with(|| json!({}));
        }
        "tool_result" => {
            if !out.contains_key("content") {
                out.insert("content".into(), Value::String(String::new()));
            }
        }
        _ => {}
    }
    Some(Value::Object(out))
}

// ---------------------------------------------------------------------------
// Emit specification
// ---------------------------------------------------------------------------

/// How one canonical record is spelled. Every field is a [`FieldSpec`] so that a
/// value can come from a path, a constant, a lookup table or a concatenation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Emit {
    /// The canonical `type` of the record produced. Required unless the rule
    /// passes records through untouched.
    #[serde(default, rename = "type")]
    pub kind: Option<FieldSpec>,
    #[serde(default)]
    pub timestamp: Option<FieldSpec>,
    #[serde(default)]
    pub session_id: Option<FieldSpec>,
    #[serde(default)]
    pub is_sidechain: Option<FieldSpec>,
    #[serde(default)]
    pub is_meta: Option<FieldSpec>,
    #[serde(default)]
    pub origin_kind: Option<FieldSpec>,
    /// Canonical `aiTitle`.
    #[serde(default)]
    pub title: Option<FieldSpec>,
    #[serde(default)]
    pub model: Option<FieldSpec>,
    #[serde(default)]
    pub usage: Option<UsageSpec>,
    /// Content block emitters, evaluated in order. Every rule that matches
    /// contributes; use `when` to stop a rule from firing.
    #[serde(default)]
    pub blocks: Vec<BlockRule>,
    #[serde(default)]
    pub cost: Option<CostSpec>,
    /// Extra constant fields merged into the record, for harness-specific
    /// metadata worth keeping but not worth modelling.
    #[serde(default)]
    pub extra: Option<Map<String, Value>>,
}

impl Default for Emit {
    fn default() -> Self {
        Self {
            kind: None,
            timestamp: None,
            session_id: None,
            is_sidechain: None,
            is_meta: None,
            origin_kind: None,
            title: None,
            model: None,
            usage: None,
            blocks: Vec::new(),
            cost: None,
            extra: None,
        }
    }
}

/// One content block emitter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRule {
    #[serde(default)]
    pub when: Option<Selector>,
    /// Path to an array; when present the rule runs once per element, with
    /// that element as the root. Without it the record itself is the root.
    #[serde(default)]
    pub each: Option<String>,
    /// Canonical block type: `text`, `thinking`, `tool_use`, `tool_result`.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub fields: BTreeMap<String, FieldSpec>,
    /// For `tool_result`: the canonical field holding the body, flattened
    /// from an array of `{text}` parts into a single string when present.
    #[serde(default)]
    pub flatten: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSpec {
    #[serde(default)]
    pub input: Option<FieldSpec>,
    #[serde(default)]
    pub output: Option<FieldSpec>,
    #[serde(default)]
    pub cache_read: Option<FieldSpec>,
    #[serde(default)]
    pub cache_creation: Option<FieldSpec>,
    #[serde(default)]
    pub thinking: Option<FieldSpec>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSpec {
    #[serde(default)]
    pub total_usd: Option<FieldSpec>,
    #[serde(default)]
    pub api_duration_ms: Option<FieldSpec>,
    #[serde(default)]
    pub tool_duration_ms: Option<FieldSpec>,
    #[serde(default)]
    pub total_duration_ms: Option<FieldSpec>,
    #[serde(default)]
    pub lines_added: Option<FieldSpec>,
    #[serde(default)]
    pub lines_removed: Option<FieldSpec>,
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/// Expand a profile's input into the flat list of candidate records.
///
/// For line-oriented sources this is the identity. For document sources it is
/// where the interesting records actually live, because a JSON export wraps
/// them: one file, one session, one array of messages.
fn expand(profile: &Profile, input: Vec<Value>) -> Vec<Value> {
    let flat = flatten_source(profile, input);
    match &profile.unwrap {
        Some(key) => flat.into_iter().map(|r| hoist(r, key)).collect(),
        None => flat,
    }
}

/// Split a profile's input into the flat list of candidate records.
fn flatten_source(profile: &Profile, input: Vec<Value>) -> Vec<Value> {
    match &profile.source {
        Source::Jsonl => input,
        Source::Doc { array } => {
            let mut out = Vec::new();
            for item in input {
                match get(&item, array).and_then(|v| v.as_array()) {
                    Some(items) => {
                        for e in items {
                            // Keep the container reachable under `__doc` so a
                            // mapping can still read session-level fields.
                            let mut wrapped = e.clone();
                            if let Value::Object(map) = &mut wrapped {
                                map.entry("__doc").or_insert(item.clone());
                            }
                            out.push(wrapped);
                        }
                    }
                    None => out.push(item),
                }
            }
            out
        }
    }
}

/// Merge a wrapped payload over the envelope that carries it.
fn hoist(rec: Value, key: &str) -> Value {
    let Value::Object(env) = &rec else { return rec };
    let Some(payload) = env.get(key).and_then(|v| v.as_object()) else {
        return rec;
    };
    let mut merged = env.clone();
    for (k, v) in payload {
        merged.insert(k.clone(), v.clone());
    }
    // Keep the original envelope reachable for anything the mapping
    // still wants from it.
    merged.insert("__envelope".to_string(), Value::Object(env.clone()));
    Value::Object(merged)
}

/// Run a profile over already-parsed input records.
pub fn convert(profile: &Profile, input: Vec<Value>) -> Vec<Value> {
    let mut out = Vec::new();
    for rec in expand(profile, input) {
        for rule in &profile.records {
            let hit = match &rule.when {
                Some(sel) => sel.test(&rec),
                None => true,
            };
            if !hit {
                continue;
            }
            if rule.passthrough {
                out.push(rec.clone());
                break;
            }
            if let Some(built) = emit(&rule.emit, &rec) {
                out.push(built);
                break; // first matching rule wins
            }
        }
    }
    out
}

/// Build one canonical record. Returns `None` when the rule demands a `type` the
/// input cannot supply, which is how an over-broad rule is made harmless.
fn emit(spec: &Emit, rec: &Value) -> Option<Value> {
    let kind = spec.kind.as_ref()?.eval_text(rec)?;
    let mut out = Map::new();
    out.insert("type".into(), Value::String(kind.clone()));

    let put = |key: &str, fs: &Option<FieldSpec>, out: &mut Map<String, Value>| {
        if let Some(fs) = fs {
            if let Some(v) = fs.eval(rec) {
                out.insert(key.to_string(), v);
            }
        }
    };
    put("timestamp", &spec.timestamp, &mut out);
    put("sessionId", &spec.session_id, &mut out);
    put("aiTitle", &spec.title, &mut out);

    if spec.is_sidechain.as_ref().and_then(|s| s.eval_bool(rec)) == Some(true) {
        out.insert("isSidechain".into(), Value::Bool(true));
    }
    if spec.is_meta.as_ref().and_then(|s| s.eval_bool(rec)) == Some(true) {
        out.insert("isMeta".into(), Value::Bool(true));
    }
    if let Some(origin) = spec.origin_kind.as_ref().and_then(|s| s.eval_text(rec)) {
        out.insert("origin".into(), json!({ "kind": origin }));
    }

    if kind == "cost-state" {
        if let Some(c) = &spec.cost {
            let mut m = Map::new();
            let num = |k: &str, fs: &Option<FieldSpec>, m: &mut Map<String, Value>| {
                if let Some(v) = fs.as_ref().and_then(|s| s.eval_f64(rec)) {
                    m.insert(k.to_string(), json!(v));
                }
            };
            num("totalCostUSD", &c.total_usd, &mut m);
            num("totalAPIDurationWithoutRetries", &c.api_duration_ms, &mut m);
            num("totalToolDuration", &c.tool_duration_ms, &mut m);
            num("totalDuration", &c.total_duration_ms, &mut m);
            num("totalLinesAdded", &c.lines_added, &mut m);
            num("totalLinesRemoved", &c.lines_removed, &mut m);
            out.extend(m);
        }
        return Some(Value::Object(out));
    }

    if let Some(extra) = &spec.extra {
        for (k, v) in extra {
            out.insert(k.clone(), v.clone());
        }
    }

    // Everything that is not pure metadata carries a message.
    let mut message = Map::new();
    if let Some(model) = spec.model.as_ref().and_then(|s| s.eval_text(rec)) {
        message.insert("model".into(), Value::String(model));
    }
    if let Some(blocks) = build_blocks(&spec.blocks, rec) {
        message.insert("content".into(), Value::Array(blocks));
    }
    if let Some(u) = &spec.usage {
        let mut usage = Map::new();
        let num = |k: &str, fs: &Option<FieldSpec>, m: &mut Map<String, Value>| {
            if let Some(v) = fs.as_ref().and_then(|s| s.eval_u64(rec)) {
                m.insert(k.to_string(), json!(v));
            }
        };
        num("input_tokens", &u.input, &mut usage);
        num("output_tokens", &u.output, &mut usage);
        num("cache_read_input_tokens", &u.cache_read, &mut usage);
        num("cache_creation_input_tokens", &u.cache_creation, &mut usage);
        if let Some(th) = u.thinking.as_ref().and_then(|s| s.eval_u64(rec)) {
            usage.insert("output_tokens_details".into(), json!({ "thinking_tokens": th }));
        }
        if !usage.is_empty() {
            message.insert("usage".into(), Value::Object(usage));
        }
    }

    if !message.is_empty() {
        out.insert("message".into(), Value::Object(message));
    }
    Some(Value::Object(out))
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/// Where user profiles live. An adapter written for a one-off format is dropped
/// here as a single JSON file and picked up on the next scan.
pub fn profiles_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("tracematter")
        .join("profiles")
}

fn parse(text: &str, origin: &str) -> Option<Profile> {
    match serde_json::from_str::<Profile>(text) {
        Ok(p) => Some(p),
        Err(e) => {
            eprintln!("profile {origin}: {e}");
            None
        }
    }
}

pub fn builtins() -> Vec<Profile> {
    BUILTIN
        .iter()
        .filter_map(|(id, text)| parse(text, id))
        .collect()
}

/// Every profile the app knows about. A user profile replaces a built-in with
/// the same id, which is how someone fixes a built-in mapping without forking.
pub fn all() -> Vec<Profile> {
    let mut out = builtins();
    let dir = profiles_dir();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Some(p) = parse(&text, &path.display().to_string()) else {
                continue;
            };
            match out.iter_mut().find(|x| x.id == p.id) {
                Some(slot) => *slot = p,
                None => out.push(p),
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn find(id: &str) -> Option<Profile> {
    all().into_iter().find(|p| p.id == id)
}

/// Score every profile against a sample of a file we do not recognise, best
/// first. Used only to *suggest* an adapter: applying one silently would be
/// worse than asking, because a wrong mapping produces a plausible looking
/// session with quietly wrong numbers.
pub fn detect(sample: &[Value]) -> Vec<(Profile, f64)> {
    if sample.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(Profile, f64)> = Vec::new();
    for p in all() {
        let Some(sel) = &p.matches else {
            continue;
        };
        let hits = sample.iter().filter(|r| sel.test(r)).count();
        if hits == 0 {
            continue;
        }
        // Confidence is coverage: matching every sampled record is a much
        // stronger claim than matching one line in a hundred.
        scored.push((p, hits as f64 / sample.len() as f64));
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
}

/// Read a transcript through a profile.
///
/// Line-oriented sources parse one value per line. Document sources parse the
/// whole file, and fall back to line-oriented parsing when that fails, because
/// a fair number of "documents" are really JSONL with one very long line.
pub fn read_with(path: &Path, profile: &Profile) -> Result<(Vec<Value>, u64)> {
    match &profile.source {
        Source::Jsonl => {
            let (raw, bad) = crate::transcript::read_records(path)?;
            Ok((convert(profile, raw), bad))
        }
        Source::Doc { .. } => {
            let text = std::fs::read_to_string(path)
                .with_context(|| format!("read {}", path.display()))?;
            match serde_json::from_str::<Value>(&text) {
                Ok(v) => Ok((convert(profile, vec![v]), 0)),
                Err(_) => {
                    let (raw, bad) = crate::transcript::read_records(path)?;
                    Ok((convert(profile, raw), bad))
                }
            }
        }
    }
}

/// Read a sample of a file without committing to a profile: the first few
/// parseable lines, which is all detection needs.
pub fn sample(path: &Path, n: usize) -> Vec<Value> {
    match crate::transcript::read_records(path) {
        Ok((records, _)) => records.into_iter().take(n).collect(),
        Err(_) => Vec::new(),
    }
}

/// The record types the canonical format defines. A file whose records already
/// speak this vocabulary needs no adapter at all, and saying so is cheaper and
/// more reliable than scoring it against every profile.
const CANONICAL: &[&str] = &["assistant", "user", "system", "ai-title", "cost-state"];

pub fn is_canonical(records: &[Value]) -> bool {
    if records.is_empty() {
        return false;
    }
    records.iter().any(|r| {
        r.get("type")
            .and_then(|t| t.as_str())
            .map(|t| CANONICAL.contains(&t))
            .unwrap_or(false)
    })
}

/// Read a transcript, choosing an adapter when one is needed.
///
/// A forced profile wins. Otherwise a file that already speaks the canonical
/// vocabulary is read directly, and anything else is scored against the known
/// profiles. Detection is deliberately conservative: below the confidence
/// threshold the file is read as-is rather than through a mapping that merely
/// looks plausible.
pub fn read_auto(path: &Path, forced: Option<&str>) -> Result<(Vec<Value>, u64)> {
    if let Some(id) = forced {
        let id = id.trim();
        if !id.is_empty() && id != "auto" {
            let p = find(id).with_context(|| format!("unknown profile: {id}"))?;
            return read_with(path, &p);
        }
    }
    let probe = sample(path, 24);
    if probe.is_empty() || is_canonical(&probe) {
        return crate::transcript::read_records(path);
    }
    match detect(&probe).first() {
        Some((p, score)) if *score >= 0.5 && p.id != "claude-code" => read_with(path, p),
        _ => crate::transcript::read_records(path),
    }
}

/// Profiles as the UI sees them: id, name, description, and where each came from.
pub fn catalog() -> Vec<Value> {
    all()
        .into_iter()
        .map(|p| {
            let builtin = BUILTIN.iter().any(|(id, _)| *id == p.id);
            let overridden =
                builtin && profiles_dir().join(format!("{}.json", p.id)).exists();
            json!({
                "id": p.id,
                "name": p.name,
                "description": p.description,
                "rules": p.records.len(),
                "builtin": builtin,
                "override": overridden,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
//
// The fixtures under `adapters/fixtures/` back the built-in profiles. The Claude
// Code one is written from a real session; the rest are written from each
// format's specification, because those harnesses are not installed on this
// machine. They are small and hand-checkable on purpose: a mapping error should
// surface as a wrong number in an assertion rather than as a plausible-looking
// session in the UI.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn builtin(id: &str) -> Profile {
        builtins()
            .into_iter()
            .find(|p| p.id == id)
            .unwrap_or_else(|| panic!("no built-in profile named {id}"))
    }

    /// Parse a JSONL fixture the way the reader would.
    fn lines(text: &str) -> Vec<Value> {
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_str::<Value>(l).expect("fixture line is not JSON"))
            .collect()
    }

    fn kinds(records: &[Value]) -> Vec<String> {
        records
            .iter()
            .map(|r| r.get("type").and_then(|t| t.as_str()).unwrap_or("?").to_string())
            .collect()
    }

    fn count_kind(records: &[Value], want: &str) -> usize {
        kinds(records).iter().filter(|k| *k == want).count()
    }

    fn blocks(rec: &Value) -> Vec<Value> {
        rec.get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default()
    }

    fn tool_ids(records: &[Value], want: &str) -> Vec<String> {
        records
            .iter()
            .flat_map(blocks)
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some(want))
            .filter_map(|b| {
                let key = if want == "tool_use" { "id" } else { "tool_use_id" };
                b.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
            })
            .collect()
    }

    fn usage(rec: &Value, key: &str) -> Option<u64> {
        rec.get("message")
            .and_then(|m| m.get("usage"))
            .and_then(|u| u.get(key))
            .and_then(|v| v.as_u64())
    }

    fn thinking_tokens(rec: &Value) -> Option<u64> {
        rec.get("message")
            .and_then(|m| m.get("usage"))
            .and_then(|u| u.get("output_tokens_details"))
            .and_then(|d| d.get("thinking_tokens"))
            .and_then(|v| v.as_u64())
    }

    fn has_type(r: &Value, want: &str) -> bool {
        r.get("type").and_then(|t| t.as_str()) == Some(want)
    }

    fn first_block(records: &[Value], want: &str) -> Value {
        records
            .iter()
            .flat_map(|r| blocks(r))
            .find(|b| b.get("type").and_then(|t| t.as_str()) == Some(want))
            .unwrap_or_else(|| panic!("no {want} block in any record"))
    }

    fn count_blocks(records: &[Value], want: &str) -> usize {
        records
            .iter()
            .flat_map(blocks)
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some(want))
            .count()
    }

    #[test]
    fn every_builtin_parses_and_declares_a_detector() {
        let all = builtins();
        let mut ids: Vec<String> = all.iter().map(|p| p.id.clone()).collect();
        ids.sort();
        assert_eq!(
            ids,
            ["claude-code", "codex", "openai-messages", "openai-tool-calls"],
            "the built-in set changed"
        );
        for p in &all {
            assert!(!p.records.is_empty(), "{} has no rules", p.id);
            assert!(p.matches.is_some(), "{} can never be detected", p.id);
        }
    }

    #[test]
    fn claude_code_passes_records_through_untouched() {
        let raw = lines(include_str!("../../adapters/fixtures/claude-code.jsonl"));
        let out = convert(&builtin("claude-code"), raw.clone());
        assert_eq!(out.len(), raw.len(), "the identity mapping dropped records");
        for (i, (a, b)) in raw.iter().zip(out.iter()).enumerate() {
            // The identity mapping must not add, drop or rewrite a single field.
            assert_eq!(a, b, "record {i} was modified");
        }
    }

    #[test]
    fn codex_maps_events_tools_and_tokens() {
        let raw = lines(include_str!("../../adapters/fixtures/codex-session.jsonl"));
        let out = convert(&builtin("codex"), raw);

        assert_eq!(out.len(), 11, "one record per event; got {:?}", kinds(&out));
        assert_eq!(count_kind(&out, "system"), 2, "session_meta + turn_context");
        assert_eq!(count_kind(&out, "user"), 3, "one prompt and two tool outputs");
        assert_eq!(count_kind(&out, "assistant"), 6, "2 reasoning + 2 calls + 1 answer + 1 token count");

        for (i, r) in out.iter().enumerate() {
            assert!(r.get("timestamp").is_some(), "record {i} lost its timestamp");
        }

        assert_eq!(
            out[0].get("sessionId").and_then(|v| v.as_str()),
            Some("4d1c0f6a-88b2-4a1e-9d33-2f7c5b0e6a91"),
            "session_meta should carry the session id"
        );

        assert_eq!(tool_ids(&out, "tool_use"), ["call_01", "call_02"]);
        assert_eq!(tool_ids(&out, "tool_result"), ["call_01", "call_02"]);

        // `input_text` parts are objects, not strings. A mapping that forgets to
        // flatten them yields a text block the reader ignores.
        let prompt = out
            .iter()
            .find(|r| has_type(r, "user") && !blocks(r).is_empty())
            .expect("the user prompt is missing");
        let prompt_blocks = blocks(prompt);
        let text = prompt_blocks[0]
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert!(
            text.starts_with("The nightly settlement job"),
            "prompt text was not flattened: {text:?}"
        );

        assert_eq!(count_blocks(&out, "thinking"), 2, "two reasoning items");

        // token_count reports an inclusive input total. Subtracting the cached
        // part is the entire reason the `sub` operator exists.
        let tok = out.last().unwrap();
        assert_eq!(usage(tok, "input_tokens"), Some(2410 - 1920), "uncached input");
        assert_eq!(usage(tok, "cache_read_input_tokens"), Some(1920));
        assert_eq!(usage(tok, "output_tokens"), Some(148));
        assert_eq!(thinking_tokens(tok), Some(64));
    }

    #[test]
    fn openai_messages_expands_arrays_and_parses_arguments() {
        let doc: Value =
            serde_json::from_str(include_str!("../../adapters/fixtures/openai-messages.json"))
                .expect("fixture is not JSON");
        let out = convert(&builtin("openai-messages"), vec![doc]);

        assert_eq!(out.len(), 10, "one record per message; got {:?}", kinds(&out));
        assert_eq!(count_kind(&out, "system"), 1);
        assert_eq!(count_kind(&out, "user"), 5, "two human turns and three tool outputs");
        assert_eq!(count_kind(&out, "assistant"), 4);

        // Tool arguments arrive as a JSON string and must come back as an object.
        let call = first_block(&out, "tool_use");
        assert_eq!(call.get("name").and_then(|v| v.as_str()), Some("get_order"));
        assert_eq!(
            call.get("input")
                .and_then(|i| i.get("order_id"))
                .and_then(|v| v.as_str()),
            Some("A-99213"),
            "arguments were not parsed: {:?}",
            call.get("input")
        );

        // A message whose content is null still has to yield its tool call.
        // Pick the record by what it carries, not by being the first one with a
        // single block: a plain text answer also has exactly one block.
        let calls_only = out
            .iter()
            .filter(|r| has_type(r, "assistant"))
            .find(|r| {
                let b = blocks(r);
                b.len() == 1 && b[0].get("type").and_then(|t| t.as_str()) == Some("tool_use")
            })
            .expect("expected an assistant record carrying only a tool call");
        assert_eq!(
            blocks(calls_only)[0].get("type").and_then(|t| t.as_str()),
            Some("tool_use")
        );

        // Cached prompt tokens are a subset of prompt_tokens, so the uncached
        // count is the difference rather than the raw total.
        let first_answer = out.iter().find(|r| has_type(r, "assistant")).unwrap();
        assert_eq!(usage(first_answer, "input_tokens"), Some(412 - 256));
        assert_eq!(usage(first_answer, "cache_read_input_tokens"), Some(256));
        assert_eq!(usage(first_answer, "output_tokens"), Some(31));
        assert_eq!(thinking_tokens(first_answer), None, "no reasoning detail on this one");

        // Failures survive as errors instead of being flattened into output.
        let errored = out
            .iter()
            .flat_map(blocks)
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
            .filter(|b| b.get("is_error").and_then(|v| v.as_bool()) == Some(true))
            .count();
        assert_eq!(errored, 1, "the offline-partition result is an error");
    }

    #[test]
    fn openai_tool_calls_handles_wrapped_and_bare_items() {
        let raw = lines(include_str!("../../adapters/fixtures/openai-tool-calls.jsonl"));
        let out = convert(&builtin("openai-tool-calls"), raw);

        assert_eq!(out.len(), 8, "six items and two usage lines; got {:?}", kinds(&out));
        assert_eq!(
            count_kind(&out, "assistant"),
            6,
            "two reasoning items, one call, one answer, two usage lines"
        );
        assert_eq!(
            count_kind(&out, "user"),
            2,
            "the prompt and the single tool output"
        );

        // The envelope carries its payload under `item`, so the mapping has to
        // find the same fields there as it does on a bare item.
        assert_eq!(tool_ids(&out, "tool_use"), ["call_x1"]);
        assert_eq!(tool_ids(&out, "tool_result"), ["call_x1"]);
        let call = first_block(&out, "tool_use");
        assert_eq!(call.get("name").and_then(|v| v.as_str()), Some("query_table"));
        assert_eq!(
            call.get("input")
                .and_then(|i| i.get("table"))
                .and_then(|v| v.as_str()),
            Some("invoice_lines")
        );

        // An array of summary parts becomes one string, not an array.
        let thought = first_block(&out, "thinking");
        assert!(
            thought.get("thinking").and_then(|v| v.as_str()).is_some(),
            "reasoning summary was not flattened: {:?}",
            thought.get("thinking")
        );

        // Both usage lines describe the same response and must decode alike.
        let with_usage: Vec<&Value> = out
            .iter()
            .filter(|r| usage(r, "output_tokens").is_some())
            .collect();
        assert_eq!(with_usage.len(), 2, "one bare usage line and one response.done");
        for r in with_usage {
            assert_eq!(usage(r, "input_tokens"), Some(3180 - 2432));
            assert_eq!(usage(r, "cache_read_input_tokens"), Some(2432));
            assert_eq!(usage(r, "output_tokens"), Some(264));
            assert_eq!(thinking_tokens(r), Some(96));
        }
    }

    #[test]
    fn detection_identifies_each_fixture() {
        let codex = lines(include_str!("../../adapters/fixtures/codex-session.jsonl"));
        assert!(!is_canonical(&codex), "codex events are not canonical records");
        let best = detect(&codex);
        assert_eq!(
            best[0].0.id,
            "codex",
            "detected {:?}",
            best.iter().map(|(p, s)| (&p.id, s)).collect::<Vec<_>>()
        );
        assert!(best[0].1 > 0.9, "codex should cover nearly every record, got {}", best[0].1);

        let tc = lines(include_str!("../../adapters/fixtures/openai-tool-calls.jsonl"));
        assert!(!is_canonical(&tc));
        assert_eq!(detect(&tc)[0].0.id, "openai-tool-calls");

        let cc = lines(include_str!("../../adapters/fixtures/claude-code.jsonl"));
        assert!(is_canonical(&cc), "a native transcript must need no adapter");
    }

    #[test]
    fn a_profile_that_matches_nothing_is_harmless() {
        // An over-broad rule with no derivable `type` must be skipped rather
        // than emitting a record the reader cannot classify.
        let p: Profile = serde_json::from_str(
            r#"{
                "id": "nothing",
                "name": "Nothing",
                "records": [{ "type": { "path": "does.not.exist" } }]
            }"#,
        )
        .expect("profile did not parse");
        assert!(p.matches.is_none(), "no detector was declared");
        let out = convert(&p, vec![json!({"a": 1})]);
        assert!(out.is_empty(), "expected no output, got {out:?}");
    }

    /// Dump every adapted fixture so the Python validator can cross-check it.
    ///
    /// The adapter and `tools/validate_trace.py` were written separately, so
    /// having one accept what the other produces is real evidence rather than a
    /// tautology. Ignored by default because it writes to disk.
    #[test]
    #[ignore = "writes files; run with --ignored after changing a profile"]
    fn dump_adapted_fixtures_for_validation() {
        let dir = std::path::Path::new("target/adapted");
        std::fs::create_dir_all(dir).expect("could not create target/adapted");

        let doc: Value =
            serde_json::from_str(include_str!("../../adapters/fixtures/openai-messages.json"))
                .expect("fixture is not JSON");

        let cases: Vec<(&str, Vec<Value>)> = vec![
            ("claude-code", lines(include_str!("../../adapters/fixtures/claude-code.jsonl"))),
            ("codex", lines(include_str!("../../adapters/fixtures/codex-session.jsonl"))),
            ("openai-messages", vec![doc]),
            (
                "openai-tool-calls",
                lines(include_str!("../../adapters/fixtures/openai-tool-calls.jsonl")),
            ),
        ];

        for (id, input) in cases {
            let out = convert(&builtin(id), input);
            assert!(!out.is_empty(), "{id} adapted to nothing");
            let body: String = out
                .iter()
                .map(|r| serde_json::to_string(r).expect("not serialisable"))
                .collect::<Vec<_>>()
                .join("
");
            let path = dir.join(format!("{id}.jsonl"));
            std::fs::write(&path, body + "
").expect("could not write");
            println!("{} -> {} records", path.display(), out.len());
        }
    }
}
