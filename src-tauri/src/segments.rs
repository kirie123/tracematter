//! Turn segmentation and digest construction.
//!
//! A *turn* is everything the agent did between two human messages. Turns — not
//! whole sessions — are the unit we send to a model, because the quality of an
//! agent's work is only meaningful relative to one request.
//!
//! The digest is deliberately lossy, and it says so in-band. See [`clip`] for
//! why that matters more than it looks.

use crate::model::*;
use crate::transcript::is_edit_tool;

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestOptions {
    pub max_user_head: usize,
    pub max_user_tail: usize,
    pub max_asst_head: usize,
    pub max_asst_tail: usize,
    pub max_tools: usize,
    pub max_files: usize,
}

impl Default for DigestOptions {
    fn default() -> Self {
        Self {
            max_user_head: 500,
            max_user_tail: 120,
            max_asst_head: 420,
            max_asst_tail: 320,
            max_tools: 24,
            max_files: 12,
        }
    }
}

/// Keep the head *and* the tail of a long text, marking the cut explicitly.
///
/// Truncating only the tail is a subtle trap: the reader (or the model) sees a
/// sentence that stops mid-thought and concludes "the agent left the job
/// unfinished". Keeping the tail as well, plus a marker that names the pipeline
/// as the culprit, removes that bias at the source.
pub fn clip(text: &str, head: usize, tail: usize) -> String {
    let t = text.trim();
    let n = t.chars().count();
    if n <= head + tail + 40 {
        return t.to_string();
    }
    let head_s: String = t.chars().take(head).collect();
    let tail_s: String = t.chars().skip(n - tail).collect();
    format!(
        "{head_s}\n[... {} chars omitted by the digest pipeline -- NOT a sign of an unfinished job ...]\n{tail_s}",
        n - head - tail
    )
}

fn base_name(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

/// A user record is a *human turn boundary* only if a person actually typed it.
/// Tool results, command wrappers and peer messages all arrive as `user` records
/// and must not split the timeline.
pub fn is_human_turn(step: &Step) -> bool {
    if step.role != Role::User {
        return false;
    }
    if step.is_sidechain {
        return false;
    }
    if !step.tool_results.is_empty() {
        return false;
    }
    match step.note.as_deref() {
        Some("meta") | Some("peer") | Some("task") | Some("observation") => return false,
        _ => {}
    }
    let text = match step.text.as_deref() {
        Some(t) => t.trim(),
        None => return false,
    };
    if text.is_empty() {
        return false;
    }
    // Harness-injected wrappers start with a tag, e.g. `<command-name>`.
    !text.starts_with('<')
}

/// Split a timeline into turns and build a digest for each.
pub fn segment_turns(summary: &SessionSummary, steps: &[Step], opts: DigestOptions) -> Vec<TurnSegment> {
    let sid8: String = summary.id.chars().take(8).collect();
    let mut turns: Vec<TurnSegment> = Vec::new();
    let mut cur: Option<TurnSegment> = None;

    for step in steps {
        if is_human_turn(step) {
            if let Some(t) = cur.take() {
                if t.n_tools > 0 || t.n_asst_chars > 0 {
                    turns.push(t);
                }
            }
            cur = Some(TurnSegment {
                id: String::new(),
                session: summary.id.clone(),
                index: turns.len() + 1,
                start_step: step.index,
                end_step: step.index,
                title: summary.title.clone(),
                user_request: step.text.clone().unwrap_or_default(),
                digest: String::new(),
                n_tools: 0,
                n_errors: 0,
                n_interrupts: 0,
                n_thinking: 0,
                n_asst_chars: 0,
                tools_used: Default::default(),
                files_touched: Vec::new(),
                first_ts: step.ts.clone(),
                duration_sec: None,
            });
            continue;
        }

        let t = match cur.as_mut() {
            Some(t) => t,
            None => continue,
        };
        t.end_step = step.index;

        if step.role == Role::Assistant {
            if let Some(th) = step.thinking.as_ref() {
                if !th.is_empty() {
                    t.n_thinking += 1;
                }
            }
            if let Some(txt) = step.text.as_ref() {
                t.n_asst_chars += txt.chars().count();
            }
            for call in &step.tool_calls {
                t.n_tools += 1;
                *t.tools_used.entry(call.name.clone()).or_insert(0) += 1;
                if is_edit_tool(&call.name) {
                    if let Some(p) = crate::transcript::tool_path(&call.name, &call.args) {
                        if !t.files_touched.contains(&p) {
                            t.files_touched.push(p);
                        }
                    }
                }
            }
        }
        for res in &step.tool_results {
            if res.is_error {
                t.n_errors += 1;
            }
        }
        if let Some(txt) = step.text.as_ref() {
            if txt.contains("[Request interrupted") {
                t.n_interrupts += 1;
            }
        }
    }
    if let Some(t) = cur.take() {
        if t.n_tools > 0 || t.n_asst_chars > 0 {
            turns.push(t);
        }
    }

    // Second pass: everything that needs the finished span.
    let by_step: std::collections::BTreeMap<usize, &Step> =
        steps.iter().map(|s| (s.index, s)).collect();
    for (i, t) in turns.iter_mut().enumerate() {
        t.index = i + 1;
        t.id = format!("{sid8}-t{}", i + 1);
        t.digest = build_digest(summary, t, &by_step, opts);
        let end_ts = by_step.get(&t.end_step).and_then(|s| s.ts.clone());
        t.duration_sec = crate::transcript::duration_between(&t.first_ts, &end_ts);
        t.files_touched.sort();
        t.files_touched.dedup();
        if t.files_touched.len() > opts.max_files {
            t.files_touched.truncate(opts.max_files);
        }
    }
    turns
}

fn build_digest(
    summary: &SessionSummary,
    t: &TurnSegment,
    by_step: &std::collections::BTreeMap<usize, &Step>,
    opts: DigestOptions,
) -> String {
    let mut briefs: Vec<String> = Vec::new();
    let mut asst: Vec<String> = Vec::new();

    for idx in t.start_step..=t.end_step {
        let step = match by_step.get(&idx) {
            Some(s) => *s,
            None => continue,
        };
        if step.role != Role::Assistant {
            continue;
        }
        for call in &step.tool_calls {
            briefs.push(call.brief.clone());
        }
        if let Some(txt) = step.text.as_ref() {
            let txt = txt.trim();
            if !txt.is_empty() {
                asst.push(txt.to_string());
            }
        }
    }

    let shown = briefs.len().min(opts.max_tools);
    let mut tool_lines = briefs
        .iter()
        .take(shown)
        .map(|b| format!("  - {b}"))
        .collect::<Vec<_>>()
        .join("\n");
    if briefs.len() > shown {
        tool_lines.push_str(&format!("\n  - ... (+{} more)", briefs.len() - shown));
    }
    if tool_lines.is_empty() {
        tool_lines = "  (none)".to_string();
    }

    let title = t.title.clone().unwrap_or_default();
    let sid8: String = summary.id.chars().take(8).collect();
    let tools_ranked = top_tools(t);

    format!(
        "[session {sid8} | turn {}] title={title:?}\n\
         USER REQUEST:\n{}\n\n\
         AGENT TOOL CALLS ({} total, {} errored, {} interrupt(s), {} thinking blocks){}\n{}\n\n\
         AGENT FINAL TEXT:\n{}",
        t.index,
        clip(&t.user_request, opts.max_user_head, opts.max_user_tail),
        briefs.len(),
        t.n_errors,
        t.n_interrupts,
        t.n_thinking,
        tools_ranked,
        tool_lines,
        clip(&asst.join("\n"), opts.max_asst_head, opts.max_asst_tail),
    )
}

fn top_tools(t: &TurnSegment) -> String {
    if t.tools_used.is_empty() {
        return String::new();
    }
    let mut v: Vec<(&String, &usize)> = t.tools_used.iter().collect();
    v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    let parts: Vec<String> = v.iter().take(6).map(|(k, n)| format!("{k}×{n}")).collect();
    format!(" [{}]", parts.join(", "))
}