//! Model gateway client.
//!
//! Talks to any OpenAI-compatible `/chat/completions` endpoint. The interesting
//! part is structured output: we want one JSON object per row with exactly the
//! fields the rubric declares, because free-form text is not a dataset.
//!
//! Gateways vary in how much of the structured-output spec they implement, so
//! the client negotiates downward and remembers which mode worked:
//!
//! 1. `json_schema` — strict schema enforcement by the server (best)
//! 2. `json_object` — server guarantees valid JSON, schema goes in the prompt
//! 3. `none` — plain completion, we extract the first JSON object ourselves

use crate::config::GatewayConfig;
use crate::model::{FieldKind, LabelField, LabelSchema};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How the server was asked to constrain its output. Ordered best-to-worst; the
/// client only ever negotiates downward within a process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    JsonSchema = 0,
    JsonObject = 1,
    None = 2,
}

impl Mode {
    fn from_u8(v: u8) -> Self {
        match v {
            0 => Mode::JsonSchema,
            1 => Mode::JsonObject,
            _ => Mode::None,
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            Mode::JsonSchema => "json_schema",
            Mode::JsonObject => "json_object",
            Mode::None => "text",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Completion {
    pub values: BTreeMap<String, Value>,
    pub model: String,
    pub latency_ms: f64,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub raw: String,
}

pub struct Gateway {
    http: reqwest::Client,
    cfg: GatewayConfig,
    /// Shared across clones so one failed negotiation benefits every worker.
    mode: Arc<AtomicU8>,
}

impl Gateway {
    pub fn new(cfg: GatewayConfig) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(cfg.timeout_secs.max(5)))
            .user_agent(concat!("tracematter/", env!("CARGO_PKG_VERSION")))
            .build()
            .context("build http client")?;
        Ok(Self {
            http,
            cfg,
            mode: Arc::new(AtomicU8::new(Mode::JsonSchema as u8)),
        })
    }

    pub fn config(&self) -> &GatewayConfig {
        &self.cfg
    }

    pub fn mode(&self) -> Mode {
        Mode::from_u8(self.mode.load(Ordering::Relaxed))
    }

    /// Endpoint URL, tolerating base URLs with or without a trailing `/v1`.
    fn endpoint(&self) -> String {
        let base = self.cfg.base_url.trim_end_matches('/');
        if base.ends_with("/chat/completions") {
            base.to_string()
        } else {
            format!("{base}/chat/completions")
        }
    }

    /// Translate a rubric into a JSON Schema the server can enforce.
    pub fn json_schema(schema: &LabelSchema) -> Value {
        let mut props = Map::new();
        let mut required = Vec::new();
        for f in &schema.fields {
            props.insert(f.name.clone(), field_schema(f));
            if f.required {
                required.push(Value::String(f.name.clone()));
            }
        }
        json!({
            "type": "object",
            "properties": Value::Object(props),
            "required": required,
            "additionalProperties": false,
        })
    }

    /// Human-readable field list, used when the server cannot enforce a schema.
    fn schema_hint(schema: &LabelSchema) -> String {
        let mut lines = vec!["Reply with a single JSON object containing exactly these keys:".to_string()];
        for f in &schema.fields {
            let kind = match f.kind {
                FieldKind::Enum => format!("one of {}", f.options.join(" | ")),
                FieldKind::Int => format!("integer in [{}, {}]", f.min.unwrap_or(0.0), f.max.unwrap_or(9.0)),
                FieldKind::Float => format!("number in [{}, {}]", f.min.unwrap_or(0.0), f.max.unwrap_or(1.0)),
                FieldKind::Bool => "boolean".to_string(),
                FieldKind::Text => "string".to_string(),
            };
            lines.push(format!("- \"{}\": {} — {}", f.name, kind, f.description));
        }
        lines.push("Output JSON only. No prose, no markdown fences.".to_string());
        lines.join("\n")
    }

    /// Run one structured completion with retries and schema negotiation.
    pub async fn complete(&self, schema: &LabelSchema, prompt: &str) -> Result<Completion> {
        let attempts = self.cfg.max_retries.max(1) + 1;
        let mut last_err: Option<anyhow::Error> = None;

        for attempt in 0..attempts {
            let mode = Mode::from_u8(self.mode.load(Ordering::Relaxed));
            match self.attempt(schema, prompt, mode).await {
                Ok(c) => return Ok(c),
                Err(e) => {
                    // A rejected response_format is a capability problem, not a
                    // transient one: step the whole process down a mode.
                    if let Some(next) = downgrade(&e, mode) {
                        self.mode.store(next as u8, Ordering::Relaxed);
                        last_err = Some(e);
                        continue;
                    }
                    last_err = Some(e);
                    if attempt + 1 < attempts {
                        let backoff = Duration::from_millis(400 * (1 << attempt.min(4)));
                        tokio::time::sleep(backoff).await;
                    }
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("completion failed")))
    }

    async fn attempt(&self, schema: &LabelSchema, prompt: &str, mode: Mode) -> Result<Completion> {
        let mut body = json!({
            "model": self.cfg.model,
            "messages": [
                { "role": "system", "content": system_prompt(schema, mode) },
                { "role": "user", "content": prompt },
            ],
            "temperature": self.cfg.temperature,
            "max_tokens": self.cfg.max_tokens,
        });

        match mode {
            Mode::JsonSchema => {
                body["response_format"] = json!({
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema.id,
                        "strict": true,
                        "schema": Self::json_schema(schema),
                    }
                });
            }
            Mode::JsonObject => {
                body["response_format"] = json!({ "type": "json_object" });
            }
            Mode::None => {}
        }

        let started = Instant::now();
        let mut req = self
            .http
            .post(self.endpoint())
            .json(&body)
            .header("content-type", "application/json");
        if !self.cfg.api_key.is_empty() {
            req = req.bearer_auth(&self.cfg.api_key);
        }
        for (k, v) in &self.cfg.extra_headers {
            req = req.header(k.as_str(), v.as_str());
        }

        let resp = req.send().await.map_err(|e| classify_transport(e, &self.cfg.base_url))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            // 4xx bodies usually explain that response_format is unsupported.
            if status.as_u16() == 400 || status.as_u16() == 404 || status.as_u16() == 422 {
                bail!("HTTP {status}: {}", truncate(&text, 400));
            }
            if status.as_u16() == 429 || status.as_u16() >= 500 {
                bail!("retryable HTTP {status}: {}", truncate(&text, 200));
            }
            bail!("HTTP {status}: {}", truncate(&text, 400));
        }

        let parsed: Value = serde_json::from_str(&text).context("gateway returned non-JSON body")?;
        let latency_ms = started.elapsed().as_secs_f64() * 1000.0;

        let choice = parsed
            .get("choices")
            .and_then(|c| c.get(0))
            .ok_or_else(|| anyhow!("response has no choices: {}", truncate(&text, 300)))?;
        let content = choice
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .or_else(|| choice.get("text").and_then(|c| c.as_str()))
            .ok_or_else(|| anyhow!("response has no message content"))?
            .to_string();

        let usage = parsed.get("usage").cloned().unwrap_or(Value::Null);
        let values = parse_values(&content, &schema.fields)?;

        Ok(Completion {
            values,
            model: parsed
                .get("model")
                .and_then(|m| m.as_str())
                .unwrap_or(&self.cfg.model)
                .to_string(),
            latency_ms,
            prompt_tokens: usage.get("prompt_tokens").and_then(|x| x.as_u64()),
            completion_tokens: usage.get("completion_tokens").and_then(|x| x.as_u64()),
            raw: content,
        })
    }

    /// Cheap reachability probe used by the settings screen.
    pub async fn probe(&self) -> Result<(bool, String)> {
        let body = json!({
            "model": self.cfg.model,
            "messages": [{ "role": "user", "content": "Reply with the single word: ok" }],
            "max_tokens": 16,
            "temperature": 0,
        });
        let mut req = self.http.post(self.endpoint()).json(&body);
        if !self.cfg.api_key.is_empty() {
            req = req.bearer_auth(&self.cfg.api_key);
        }
        for (k, v) in &self.cfg.extra_headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let resp = req.send().await.map_err(|e| classify_transport(e, &self.cfg.base_url))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status.is_success() {
            Ok((true, format!("reachable · mode={} · model={}", self.mode().label(), self.cfg.model)))
        } else {
            Ok((false, format!("HTTP {status}: {}", truncate(&text, 300))))
        }
    }
}

fn system_prompt(schema: &LabelSchema, mode: Mode) -> String {
    match mode {
        // When the server enforces the schema, the grammar is already handled.
        Mode::JsonSchema => schema.instructions.clone(),
        _ => format!("{}\n\n{}", schema.instructions, Gateway::schema_hint(schema)),
    }
}

/// Decide whether an error means "this gateway cannot do that" and, if so, what
/// to try next.
fn downgrade(err: &anyhow::Error, mode: Mode) -> Option<Mode> {
    let msg = format!("{err:#}").to_lowercase();
    let capability = msg.contains("response_format")
        || msg.contains("json_schema")
        || msg.contains("json_object")
        || msg.contains("structured")
        || msg.contains("unsupported")
        || msg.contains("not supported")
        || msg.contains("unknown field")
        || msg.contains("invalid_request_error");
    if !capability {
        return None;
    }
    match mode {
        Mode::JsonSchema => Some(Mode::JsonObject),
        Mode::JsonObject => Some(Mode::None),
        Mode::None => None,
    }
}

fn classify_transport(err: reqwest::Error, base: &str) -> anyhow::Error {
    if err.is_timeout() {
        anyhow!("timed out talking to {base}")
    } else if err.is_connect() {
        anyhow!("cannot reach {base} — check the base URL, and that the key is set if the gateway needs one")
    } else {
        anyhow!(err).context(format!("request to {base} failed"))
    }
}

fn field_schema(f: &LabelField) -> Value {
    match f.kind {
        FieldKind::Enum => {
            let mut v = json!({ "type": "string", "enum": f.options, "description": f.description });
            if let Some(min) = f.min {
                v["minimum"] = json!(min);
            }
            v
        }
        FieldKind::Int => json!({
            "type": "integer",
            "minimum": f.min.unwrap_or(i64::MIN as f64),
            "maximum": f.max.unwrap_or(i64::MAX as f64),
            "description": f.description,
        }),
        FieldKind::Float => json!({
            "type": "number",
            "minimum": f.min.unwrap_or(0.0),
            "maximum": f.max.unwrap_or(1.0),
            "description": f.description,
        }),
        FieldKind::Bool => json!({ "type": "boolean", "description": f.description }),
        FieldKind::Text => json!({ "type": "string", "description": f.description }),
    }
}

/// Pull the first JSON object out of a model reply, tolerating prose, markdown
/// fences and trailing commentary. Then coerce every declared field into the
/// shape the rubric promised, so downstream code never has to guess.
pub fn parse_values(raw: &str, fields: &[LabelField]) -> Result<BTreeMap<String, Value>> {
    let obj = extract_object(raw).ok_or_else(|| anyhow!("no JSON object in reply: {}", truncate(raw, 300)))?;
    let mut out = BTreeMap::new();
    for f in fields {
        let v = obj.get(&f.name).cloned().unwrap_or(Value::Null);
        out.insert(f.name.clone(), coerce(&v, f));
    }
    Ok(out)
}

fn extract_object(raw: &str) -> Option<Map<String, Value>> {
    let trimmed = raw.trim();
    let unfenced = strip_fences(trimmed);
    if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(unfenced) {
        return Some(m);
    }
    // Fall back to scanning for the outermost balanced braces.
    let bytes = unfenced.as_bytes();
    let start = unfenced.find('{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    let slice = &unfenced[start..=i];
                    if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(slice) {
                        return Some(m);
                    }
                    return None;
                }
            }
            _ => {}
        }
    }
    None
}

fn strip_fences(s: &str) -> &str {
    let t = s.trim();
    if !t.starts_with("```") {
        return t;
    }
    let after = match t.find('\n') {
        Some(i) => &t[i + 1..],
        None => return t,
    };
    match after.rfind("```") {
        Some(i) => after[..i].trim(),
        None => after.trim(),
    }
}

/// Force a value into the declared field type. Models drift; datasets must not.
fn coerce(v: &Value, f: &LabelField) -> Value {
    match f.kind {
        FieldKind::Bool => match v {
            Value::Bool(b) => Value::Bool(*b),
            Value::String(s) => Value::Bool(matches!(
                s.trim().to_lowercase().as_str(),
                "true" | "yes" | "y" | "1"
            )),
            Value::Number(n) => Value::Bool(n.as_f64().unwrap_or(0.0) != 0.0),
            _ => Value::Bool(false),
        },
        FieldKind::Int => {
            let n = match v {
                Value::Number(n) => n.as_f64().unwrap_or(0.0),
                Value::String(s) => s.trim().parse::<f64>().unwrap_or(0.0),
                Value::Bool(b) => {
                    if *b {
                        1.0
                    } else {
                        0.0
                    }
                }
                _ => 0.0,
            };
            let lo = f.min.unwrap_or(i64::MIN as f64);
            let hi = f.max.unwrap_or(i64::MAX as f64);
            Value::from(n.round().clamp(lo, hi) as i64)
        }
        FieldKind::Float => {
            let n = match v {
                Value::Number(n) => n.as_f64().unwrap_or(0.0),
                Value::String(s) => s.trim().parse::<f64>().unwrap_or(0.0),
                Value::Bool(b) => {
                    if *b {
                        1.0
                    } else {
                        0.0
                    }
                }
                _ => 0.0,
            };
            let lo = f.min.unwrap_or(f64::NEG_INFINITY);
            let hi = f.max.unwrap_or(f64::INFINITY);
            Value::from(n.clamp(lo, hi))
        }
        FieldKind::Enum => {
            let s = match v {
                Value::String(s) => s.trim().to_string(),
                other => other.to_string(),
            };
            if f.options.iter().any(|o| o.eq_ignore_ascii_case(&s)) {
                Value::String(
                    f.options
                        .iter()
                        .find(|o| o.eq_ignore_ascii_case(&s))
                        .cloned()
                        .unwrap_or(s),
                )
            } else {
                // Keep the raw answer rather than snapping to a neighbour: a
                // value outside the enum is information, not noise.
                let suffix = if s.is_empty() { "(empty)".to_string() } else { truncate(&s, 60) };
                Value::String(format!("{suffix} (off-enum)"))
            }
        }
        FieldKind::Text => match v {
            Value::String(s) => Value::String(s.trim().to_string()),
            Value::Null => Value::String(String::new()),
            other => Value::String(other.to_string()),
        },
    }
}

pub fn truncate(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        t.to_string()
    } else {
        t.chars().take(n).collect::<String>() + "…"
    }
}