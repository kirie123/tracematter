//! Parquet: a schema, and a paged read.
//!
//! Only the record layer is used here — `SerializedFileReader` and the row
//! accessor — so a paged read needs no arrow arrays and the values arrive as
//! plain Rust scalars. That keeps the dependency to the part that reads bytes
//! rather than the part that computes over columns, which is all a viewer needs.
//!
//! Paging is the point. The GRPO completions are 500 files of ~64,000 rows
//! carrying full prompts and completions; materialising them would be hundreds
//! of megabytes. Every call here takes a window and clips long strings, and a
//! single cell can be fetched in full afterwards.

use anyhow::{anyhow, Context, Result};
use parquet::file::reader::{FileReader, SerializedFileReader};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs::File;
use std::path::Path;

/// Characters of a string cell that travel by default.
const CELL_CHARS: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// The parquet physical/logical type, as a readable word.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParquetPage {
    pub path: String,
    pub columns: Vec<ColumnInfo>,
    pub total_rows: u64,
    /// Row groups in the file. A page never straddles more than it must.
    pub row_groups: usize,
    pub offset: u64,
    /// Rows in this page, already clipped.
    pub rows: Vec<Map<String, Value>>,
    /// Column names whose values were shortened for this page.
    pub clipped: Vec<String>,
}

fn kind_of(t: parquet::basic::Type) -> String {
    use parquet::basic::Type::*;
    match t {
        BOOLEAN => "bool",
        INT32 => "int32",
        INT64 => "int64",
        INT96 => "timestamp96",
        FLOAT => "float",
        DOUBLE => "double",
        BYTE_ARRAY => "string",
        FIXED_LEN_BYTE_ARRAY => "bytes",
    }
    .to_string()
}

/// Read the footer: columns and row count. Cheap — a few KB — so this is safe
/// to call on every file in a folder to build an index.
pub fn schema(path: &Path) -> Result<(Vec<ColumnInfo>, u64, usize)> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = SerializedFileReader::new(file)
        .with_context(|| format!("{} is not a readable parquet file", path.display()))?;
    let meta = reader.metadata();
    let fmd = meta.file_metadata();
    let schema = fmd.schema_descr();
    let cols = (0..schema.num_columns())
        .map(|i| {
            let c = schema.column(i);
            ColumnInfo { name: c.name().to_string(), kind: kind_of(c.physical_type()) }
        })
        .collect();
    Ok((cols, fmd.num_rows() as u64, meta.num_row_groups()))
}

/// One value out of a parquet row, as JSON. Long strings are cut, and the
/// caller is told which columns that happened to.
fn value_of(
    row: &parquet::record::Row,
    i: usize,
    clipped: &mut Vec<String>,
    names: &[String],
    clip: bool,
) -> Value {
    use parquet::record::Field;
    match row.get_column_iter().nth(i).map(|(_, f)| f) {
        None | Some(Field::Null) => Value::Null,
        Some(Field::Bool(b)) => Value::Bool(*b),
        Some(Field::Byte(v)) => (*v).into(),
        Some(Field::Short(v)) => (*v).into(),
        Some(Field::Int(v)) => (*v).into(),
        Some(Field::Long(v)) => (*v).into(),
        Some(Field::UByte(v)) => (*v).into(),
        Some(Field::UShort(v)) => (*v).into(),
        Some(Field::UInt(v)) => (*v).into(),
        Some(Field::ULong(v)) => (*v).into(),
        Some(Field::Float16(v)) => serde_json::json!(f32::from(*v)),
        Some(Field::Float(v)) => serde_json::json!(*v as f64),
        Some(Field::Double(v)) => serde_json::json!(*v),
        Some(Field::Str(s)) => {
            if clip && s.chars().count() > CELL_CHARS {
                let name = names.get(i).cloned().unwrap_or_default();
                if !clipped.contains(&name) {
                    clipped.push(name);
                }
                Value::String(s.chars().take(CELL_CHARS).collect::<String>() + "…")
            } else {
                Value::String(s.clone())
            }
        }
        Some(Field::Bytes(b)) => {
            let s = String::from_utf8_lossy(b.data());
            if clip && s.chars().count() > CELL_CHARS {
                let name = names.get(i).cloned().unwrap_or_default();
                if !clipped.contains(&name) {
                    clipped.push(name);
                }
                Value::String(s.chars().take(CELL_CHARS).collect::<String>() + "…")
            } else {
                Value::String(s.to_string())
            }
        }
        // A nested group is rendered through its Debug form: honest, and rare
        // in the datasets this viewer is aimed at.
        Some(other) => Value::String(format!("{other:?}")),
    }
}

/// A window of rows. Row groups are skipped whole, so a page deep into a large
/// file does not decode everything before it.
pub fn page(path: &Path, offset: u64, limit: usize) -> Result<ParquetPage> {
    let (columns, total, row_groups) = schema(path)?;
    let names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();

    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = SerializedFileReader::new(file)
        .with_context(|| format!("{} is not a readable parquet file", path.display()))?;

    let lim = limit.clamp(1, 2000);
    let mut rows = Vec::with_capacity(lim);
    let mut clipped: Vec<String> = Vec::new();
    let mut before = 0u64;

    for rg in 0..row_groups {
        if rows.len() >= lim {
            break;
        }
        let group = reader.get_row_group(rg)?;
        let n = group.metadata().num_rows() as u64;
        // This whole group sits before the window: skip it without decoding.
        if before + n <= offset {
            before += n;
            continue;
        }
        let skip = offset.saturating_sub(before);
        for (i, item) in group.get_row_iter(None)?.enumerate() {
            if (i as u64) < skip {
                continue;
            }
            let row = item?;
            let mut obj = Map::new();
            for c in 0..names.len() {
                let v = value_of(&row, c, &mut clipped, &names, true);
                obj.insert(names[c].clone(), v);
            }
            rows.push(obj);
            if rows.len() >= lim {
                break;
            }
        }
        before += n;
    }

    if rows.is_empty() && total > 0 && offset >= total {
        return Err(anyhow!(
            "offset {offset} is past the end of {} ({total} rows)",
            path.display()
        ));
    }

    Ok(ParquetPage {
        path: path.to_string_lossy().to_string(),
        columns,
        total_rows: total,
        row_groups,
        offset,
        rows,
        clipped,
    })
}

/// One cell in full, for when the paged view clipped it.
pub fn cell(path: &Path, row: u64, column: &str) -> Result<Value> {
    let (columns, total, row_groups) = schema(path)?;
    if row >= total {
        return Err(anyhow!("row {row} is past the end of the file ({total} rows)"));
    }
    let idx = columns
        .iter()
        .position(|c| c.name == column)
        .ok_or_else(|| anyhow!("no column named `{column}`"))?;
    let names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();

    let file = File::open(path)?;
    let reader = SerializedFileReader::new(file)?;
    let mut before = 0u64;
    for rg in 0..row_groups {
        let group = reader.get_row_group(rg)?;
        let n = group.metadata().num_rows() as u64;
        if before + n <= row {
            before += n;
            continue;
        }
        let want = (row - before) as usize;
        for (i, item) in group.get_row_iter(None)?.enumerate() {
            if i == want {
                let r = item?;
                // No clipping here: this call exists to return what the page
                // deliberately left out.
                let mut discard = Vec::new();
                return Ok(value_of(&r, idx, &mut discard, &names, false));
            }
        }
        before += n;
    }
    Err(anyhow!("row {row} not found"))
}

/// A folder's parquet files as one logical table: total rows, and which file
/// and row a global offset lands on.
pub fn dataset_index(dir: &Path) -> Result<(u64, Vec<(String, u64)>)> {
    let mut files: Vec<(String, u64)> = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .with_context(|| format!("read {}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "parquet").unwrap_or(false))
        .collect();
    entries.sort();
    let mut total = 0u64;
    for p in entries {
        if let Ok((_, n, _)) = schema(&p) {
            total += n;
            files.push((p.to_string_lossy().to_string(), n));
        }
    }
    Ok((total, files))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real GRPO file, if this machine still has it.
    fn real_file() -> Option<std::path::PathBuf> {
        let p = std::path::PathBuf::from(
            "F:/llm_runs/reasoning_lab/grpo_v1/completions/completions_00001.parquet",
        );
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }

    #[test]
    fn the_schema_names_the_columns_this_data_actually_has() {
        let Some(p) = real_file() else { return };
        let (cols, total, groups) = schema(&p).unwrap();
        let names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"prompt"), "columns were {names:?}");
        assert!(names.contains(&"completion"), "columns were {names:?}");
        assert!(names.contains(&"reward_correct"), "columns were {names:?}");
        assert!(total > 0 && groups > 0);
    }

    #[test]
    fn a_page_is_bounded_and_clips_long_cells() {
        let Some(p) = real_file() else { return };
        let pg = page(&p, 0, 5).unwrap();
        assert_eq!(pg.rows.len(), 5);
        assert!(!pg.clipped.is_empty(), "2100-token completions must be clipped");
        // The clip is marked, so the UI can offer the full value.
        let comp = pg.rows[0]
            .get("completion")
            .and_then(|v| v.as_str())
            .expect("a completion string");
        assert!(comp.chars().count() <= CELL_CHARS + 1);
        assert!(comp.ends_with('…'));
    }

    #[test]
    fn an_offset_deep_in_the_file_lands_on_the_right_row() {
        let Some(p) = real_file() else { return };
        let first = page(&p, 0, 1).unwrap();
        let far = page(&p, 100, 1).unwrap();
        assert_eq!(far.offset, 100);
        assert_eq!(far.rows.len(), 1);
        // Different rows at different offsets, or the paging is a no-op.
        let a = first.rows[0].get("prompt");
        let b = far.rows[0].get("prompt");
        assert!(a != b || first.total_rows < 101);
    }

    #[test]
    fn a_cell_can_be_fetched_in_full_after_being_clipped() {
        let Some(p) = real_file() else { return };
        let pg = page(&p, 0, 1).unwrap();
        let clipped_len = pg.rows[0]["completion"].as_str().unwrap().chars().count();
        let full = cell(&p, 0, "completion").unwrap();
        let full_len = full.as_str().unwrap().chars().count();
        assert!(
            full_len > clipped_len,
            "the full cell ({full_len}) should be longer than the clipped one ({clipped_len})"
        );
    }

    #[test]
    fn an_offset_past_the_end_is_an_error_not_a_silent_empty_page() {
        let Some(p) = real_file() else { return };
        let (_, total, _) = schema(&p).unwrap();
        assert!(page(&p, total + 5, 10).is_err());
    }
}
