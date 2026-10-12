//! Model providers.
//!
//! Two things live here. A small table of starting points — a base URL, a
//! default model, where to get a key — and the live model listing that turns a
//! running gateway into a picker.
//!
//! A preset writes three fields and then gets out of the way. Nothing is
//! load-bearing: any endpoint that speaks the OpenAI chat-completions shape
//! works, preset or not, which is why "Custom" is a first-class entry rather
//! than a fallback. The table exists to save typing and to answer the question
//! a new user actually has, which is "what do I put in these boxes".

use crate::config::GatewayConfig;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub id: String,
    pub label: String,
    /// Empty for the custom entry, which is a blank form by design.
    pub base_url: String,
    pub default_model: String,
    /// Suggestions for the model picker, most useful first.
    pub models: Vec<String>,
    /// Where a human goes to mint a key. `None` when the endpoint is local.
    pub key_url: Option<String>,
    /// Whether a key is normally expected. Local servers usually ignore one.
    pub needs_key: bool,
    /// True for endpoints that normally run on this machine.
    pub local: bool,
    /// One line shown under the preset chips.
    pub note: String,
}

struct Row {
    id: &'static str,
    label: &'static str,
    base_url: &'static str,
    default_model: &'static str,
    models: &'static [&'static str],
    key_url: Option<&'static str>,
    local: bool,
    note: &'static str,
}

/// The table. Order matters: the first row is what a fresh install starts on.
const TABLE: &[Row] = &[
    Row {
        id: "deepseek",
        label: "DeepSeek",
        base_url: "https://api.deepseek.com/v1",
        default_model: "deepseek-flash",
        models: &[
            "deepseek-flash",
            "deepseek-v4-flash",
            "deepseek-chat",
            "deepseek-reasoner",
        ],
        key_url: Some("https://platform.deepseek.com/api_keys"),
        local: false,
        note: "Reasoning models emit nothing at all until they finish thinking, so keep max tokens generous.",
    },
    Row {
        id: "openai",
        label: "OpenAI",
        base_url: "https://api.openai.com/v1",
        default_model: "gpt-4o-mini",
        models: &["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1", "o4-mini"],
        key_url: Some("https://platform.openai.com/api-keys"),
        local: false,
        note: "Small models are usually enough: labelling is a classification task, not a writing one.",
    },
    Row {
        id: "openrouter",
        label: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        default_model: "deepseek/deepseek-chat",
        models: &[
            "deepseek/deepseek-chat",
            "qwen/qwen-2.5-72b-instruct",
            "google/gemini-2.0-flash-001",
            "openai/gpt-4o-mini",
        ],
        key_url: Some("https://openrouter.ai/keys"),
        local: false,
        note: "One key, many vendors. Model ids are namespaced as vendor/model.",
    },
    Row {
        id: "ollama",
        label: "Ollama",
        base_url: "http://localhost:11434/v1",
        default_model: "qwen3:8b",
        models: &["qwen3:8b", "qwen3:14b", "llama3.2", "mistral"],
        key_url: None,
        local: true,
        note: "Runs on this machine. Pull a model first with: ollama pull qwen3:8b",
    },
    Row {
        id: "vllm",
        label: "vLLM / llama.cpp",
        base_url: "http://localhost:8000/v1",
        default_model: "local-model",
        models: &["local-model"],
        key_url: None,
        local: true,
        note: "Any local server exposing the OpenAI chat-completions route. The model id is whatever it reports.",
    },
    Row {
        id: "custom",
        label: "Custom",
        base_url: "",
        default_model: "",
        models: &[],
        key_url: None,
        local: false,
        note: "A team router, a proxy, a gateway with its own auth headers. Point it at base URL and go.",
    },
];

/// The preset table, in presentation order.
pub fn presets() -> Vec<ProviderPreset> {
    TABLE
        .iter()
        .map(|r| ProviderPreset {
            id: r.id.to_string(),
            label: r.label.to_string(),
            base_url: r.base_url.to_string(),
            default_model: r.default_model.to_string(),
            models: r.models.iter().map(|m| m.to_string()).collect(),
            key_url: r.key_url.map(|s| s.to_string()),
            needs_key: r.key_url.is_some(),
            local: r.local,
            note: r.note.to_string(),
        })
        .collect()
}

/// Look up one preset by id.
pub fn find(id: &str) -> Option<ProviderPreset> {
    presets().into_iter().find(|p| p.id == id)
}

/// The model id a fresh install should start on.
pub fn default_model() -> String {
    TABLE
        .first()
        .map(|r| r.default_model.to_string())
        .unwrap_or_default()
}

/// Extract model ids from a `/models` response.
///
/// Every vendor shapes this differently — `{"data":[{"id":…}]}` is the spec,
/// but bare arrays and `{"models":[{"name":…}]}` are both in the wild, and a
/// few servers answer with an object keyed by model name. Accept all four and
/// let the caller show what came back.
pub fn parse_models(body: &str) -> Result<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(body).context("model list is not JSON")?;

    let mut out: Vec<String> = Vec::new();
    let mut take = |x: &serde_json::Value| {
        if let Some(s) = x.as_str() {
            out.push(s.to_string());
        } else if let Some(s) = x.get("id").and_then(|i| i.as_str()) {
            out.push(s.to_string());
        } else if let Some(s) = x.get("name").and_then(|i| i.as_str()) {
            out.push(s.to_string());
        } else if let Some(s) = x.get("model").and_then(|i| i.as_str()) {
            out.push(s.to_string());
        }
    };

    match &v {
        serde_json::Value::Array(items) => items.iter().for_each(&mut take),
        serde_json::Value::Object(map) => {
            if let Some(list) = map.get("data").or_else(|| map.get("models")).and_then(|d| d.as_array())
            {
                list.iter().for_each(&mut take);
            } else if let Some(list) = map.get("data").and_then(|d| d.as_array()) {
                list.iter().for_each(&mut take);
            } else {
                // Keyed by model name: `{"models": {"a": {...}}}` or a plain map.
                for key in map.keys() {
                    out.push(key.clone());
                }
            }
        }
        _ => bail!("unrecognised model list shape"),
    }

    out.retain(|s| !s.trim().is_empty());
    out.sort();
    out.dedup();
    Ok(out)
}

fn models_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/models") {
        base.to_string()
    } else {
        format!("{base}/models")
    }
}

/// Ask the gateway which models it serves.
///
/// Best effort by design: this is a convenience for the picker, so a server
/// that does not implement `/models` should cost the user nothing more than a
/// line of text.
pub async fn list_models(cfg: &GatewayConfig) -> Result<Vec<String>> {
    if cfg.base_url.trim().is_empty() {
        bail!("no base URL yet");
    }
    let url = models_url(&cfg.base_url);
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.timeout_secs.clamp(5, 60)))
        .user_agent(concat!("tracematter/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("build http client")?;

    let mut req = http.get(&url);
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }
    for (k, v) in &cfg.extra_headers {
        req = req.header(k.as_str(), v.as_str());
    }

    let resp = req.send().await.with_context(|| format!("cannot reach {url}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("HTTP {status}: {}", crate::gateway::truncate(&text, 200));
    }
    parse_models(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_consistent() {
        let ps = presets();
        assert!(ps.len() >= 5, "expected a few presets");
        assert_eq!(ps[0].id, "deepseek", "first preset is the fresh-install default");
        let mut seen = std::collections::HashSet::new();
        for p in &ps {
            assert!(!p.id.is_empty() && !p.label.is_empty(), "{:?}", p.id);
            assert!(seen.insert(p.id.clone()), "duplicate preset id {}", p.id);
            if p.id == "custom" {
                continue;
            }
            assert!(p.base_url.starts_with("http"), "{} needs a base URL", p.id);
            assert!(!p.default_model.is_empty(), "{} needs a default model", p.id);
            assert!(
                p.models.contains(&p.default_model),
                "{}: default model {} missing from the suggestion list",
                p.id,
                p.default_model
            );
        }
        assert_eq!(default_model(), "deepseek-flash");
        assert!(find("deepseek").is_some());
        assert!(find("nope").is_none());
    }

    #[test]
    fn parses_the_shapes_in_the_wild() {
        let spec = r#"{"object":"list","data":[{"id":"b","object":"model"},{"id":"a"}]}"#;
        assert_eq!(parse_models(spec).unwrap(), vec!["a", "b"], "sorted, spec shape");

        let bare = r#"[{"id":"z"},{"name":"y"}]"#;
        assert_eq!(parse_models(bare).unwrap(), vec!["y", "z"], "bare array");

        let named = r#"{"models":[{"name":"m1"},{"model":"m2"}]}"#;
        assert_eq!(parse_models(named).unwrap(), vec!["m1", "m2"], "name/model keys");

        let keyed = r#"{"alpha":{},"beta":{}}"#;
        assert_eq!(parse_models(keyed).unwrap(), vec!["alpha", "beta"], "keyed map");

        let dupes = r#"{"data":[{"id":"a"},{"id":"a"},"a",""]}"#;
        assert_eq!(parse_models(dupes).unwrap(), vec!["a"], "deduped, blanks dropped");

        assert!(parse_models("not json").is_err());
    }

    #[test]
    fn models_url_tolerates_both_styles() {
        assert_eq!(models_url("https://x/v1"), "https://x/v1/models");
        assert_eq!(models_url("https://x/v1/"), "https://x/v1/models");
        assert_eq!(models_url("https://x/v1/models"), "https://x/v1/models");
    }
}