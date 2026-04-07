//! Lexical + Ollama embedding index over parsed schema (per workspace).
use crate::db::{self, SchemaIndexChunk};
use crate::models::FileContent;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Emitter;

const OLLAMA_BASES: &[&str] = &[
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://[::1]:11434",
];

/// Default embedding model (Ollama). User can `ollama pull nomic-embed-text`.
const DEFAULT_EMBED_MODEL: &str = "nomic-embed-text";

const MAX_CHARS_PER_FILE_CHUNK: usize = 2000;
const MAX_FILE_CHUNKS_PER_FILE: usize = 6;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaIndexProgress {
    pub workspace_id: i64,
    pub phase: String,
    pub current: i64,
    pub total: i64,
    pub message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaIndexError {
    pub workspace_id: i64,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSearchHit {
    pub chunk_text: String,
    pub source_kind: String,
    pub source_ref: String,
    pub score: f64,
}

fn parse_embedding_value(v: &Value) -> Option<Vec<f32>> {
    let arr = v
        .get("embedding")
        .and_then(|e| e.as_array())
        .or_else(|| {
            v.get("embeddings")
                .and_then(|e| e.as_array())
                .and_then(|a| a.first())
                .and_then(|x| x.as_array())
        })?;
    let mut out = Vec::with_capacity(arr.len());
    for x in arr {
        let f = x.as_f64()?;
        out.push(f as f32);
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

fn ollama_embed(prompt: &str, model: &str) -> Result<Vec<f32>, String> {
    let mut last_err = String::from("could not reach Ollama for embeddings");
    let attempts: [(&str, Value); 2] = [
        (
            "/api/embed",
            serde_json::json!({ "model": model, "input": prompt }),
        ),
        (
            "/api/embeddings",
            serde_json::json!({ "model": model, "prompt": prompt }),
        ),
    ];
    for base in OLLAMA_BASES {
        for (path, body) in &attempts {
            let url = format!("{}{}", base, path);
            let payload = body.to_string();
            match ureq::post(&url)
                .timeout(Duration::from_secs(120))
                .set("Content-Type", "application/json")
                .send_string(&payload)
            {
                Ok(resp) => {
                    let status = resp.status();
                    if !(200..300).contains(&status) {
                        last_err = format!("{url} → HTTP {status}");
                        continue;
                    }
                    let text = match resp.into_string() {
                        Ok(t) => t,
                        Err(e) => {
                            last_err = e.to_string();
                            continue;
                        }
                    };
                    let v: Value = match serde_json::from_str(&text) {
                        Ok(x) => x,
                        Err(e) => {
                            last_err = e.to_string();
                            continue;
                        }
                    };
                    if let Some(out) = parse_embedding_value(&v) {
                        return Ok(out);
                    }
                    last_err = "missing embedding in response".into();
                }
                Err(e) => last_err = format!("{url}: {e}"),
            }
        }
    }
    Err(last_err)
}

fn cosine_sim(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let d = na.sqrt() * nb.sqrt();
    if d == 0.0 {
        return 0.0;
    }
    dot / d
}

fn tokenize(s: &str) -> HashSet<String> {
    let ascii = s.to_lowercase();
    ascii
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|w| w.len() >= 2)
        .map(String::from)
        .collect()
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f32 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f32;
    let union = a.union(b).count() as f32;
    if union == 0.0 {
        return 0.0;
    }
    inter / union
}

fn table_chunk_text(t: &db::LoadedTable) -> String {
    let mut lines = vec![
        format!("Table {} (from {}):", t.name, t.file_path),
    ];
    for c in &t.columns {
        let nn = if c.nullable { "NULL" } else { "NOT NULL" };
        let pk = if c.is_pk { " PRIMARY KEY" } else { "" };
        lines.push(format!(
            "  - {}: {} {}{}",
            c.name, c.r#type, nn, pk
        ));
    }
    for fk in &t.foreign_keys {
        lines.push(format!(
            "  FK ({}) -> {}({})",
            fk.columns.join(", "),
            fk.referenced_table,
            fk.referenced_columns.join(", ")
        ));
    }
    for ix in &t.indexes {
        lines.push(format!("  INDEX {} ({})", ix.name, ix.columns.join(", ")));
    }
    lines.join("\n")
}

fn chunk_file(rel: &str, content: &str) -> Vec<String> {
    let t = content.trim();
    if t.is_empty() {
        return vec![];
    }
    if t.len() <= MAX_CHARS_PER_FILE_CHUNK {
        return vec![format!("SQL file {}:\n{}", rel, t)];
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut n = 0usize;
    while start < t.len() && n < MAX_FILE_CHUNKS_PER_FILE {
        let end = (start + MAX_CHARS_PER_FILE_CHUNK).min(t.len());
        let slice = &t[start..end];
        out.push(format!("SQL file {} (part {}):\n{}", rel, n + 1, slice));
        start = end.saturating_sub(200);
        if start >= t.len() {
            break;
        }
        n += 1;
    }
    out
}

/// Rebuild index: table chunks + file chunks, embeddings when Ollama is up.
pub fn rebuild_workspace_index_blocking(app: &AppHandle, db_path: &Path, workspace_id: i64) {
    let emit = |p: SchemaIndexProgress| {
        let _ = app.emit("schema-index-progress", &p);
    };

    emit(SchemaIndexProgress {
        workspace_id,
        phase: "start".into(),
        current: 0,
        total: 0,
        message: Some("Building schema index…".into()),
    });

    let conn = match Connection::open(db_path) {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit(
                "schema-index-error",
                &SchemaIndexError {
                    workspace_id,
                    message: format!("db open for index: {e}"),
                },
            );
            return;
        }
    };

    if let Err(e) = db::clear_schema_index_chunks(&conn, workspace_id) {
        let _ = app.emit(
            "schema-index-error",
            &SchemaIndexError {
                workspace_id,
                message: format!("clear chunks: {e}"),
            },
        );
        return;
    }

    let tables = match db::load_parsed_schema(&conn, workspace_id) {
        Ok(t) => t,
        Err(e) => {
            let _ = app.emit(
                "schema-index-error",
                &SchemaIndexError {
                    workspace_id,
                    message: format!("load schema: {e}"),
                },
            );
            return;
        }
    };

    let files: Vec<FileContent> = match db::rescan_workspace_files(&conn, workspace_id) {
        Ok(f) => f,
        Err(e) => {
            let _ = app.emit(
                "schema-index-error",
                &SchemaIndexError {
                    workspace_id,
                    message: format!("rescan files: {e}"),
                },
            );
            return;
        }
    };

    let mut work: Vec<(String, String, String)> = Vec::new();
    for t in &tables {
        work.push((
            "table".into(),
            t.name.clone(),
            table_chunk_text(t),
        ));
    }
    for f in &files {
        for (i, chunk) in chunk_file(&f.relative_path, &f.content).into_iter().enumerate() {
            work.push((
                "file".into(),
                format!("{}#{}", f.relative_path, i),
                chunk,
            ));
        }
    }

    let total = work.len() as i64;
    emit(SchemaIndexProgress {
        workspace_id,
        phase: "embedding".into(),
        current: 0,
        total,
        message: Some(format!(
            "Indexing {} chunks (embeddings via Ollama if available)…",
            total
        )),
    });

    let mut embed_ok = 0i64;
    for (i, (kind, ref_, text)) in work.iter().enumerate() {
        let emb = ollama_embed(text, DEFAULT_EMBED_MODEL).ok();
        if emb.is_some() {
            embed_ok += 1;
        }
        if let Err(e) = db::insert_schema_index_chunk(
            &conn,
            workspace_id,
            kind,
            ref_,
            text,
            emb.as_deref(),
        ) {
            let _ = app.emit(
                "schema-index-error",
                &SchemaIndexError {
                    workspace_id,
                    message: format!("insert chunk: {e}"),
                },
            );
            return;
        }
        emit(SchemaIndexProgress {
            workspace_id,
            phase: "embedding".into(),
            current: (i + 1) as i64,
            total,
            message: Some(format!(
                "Indexed {}/{} ({} with vectors)",
                i + 1,
                total,
                embed_ok
            )),
        });
    }

    emit(SchemaIndexProgress {
        workspace_id,
        phase: "done".into(),
        current: total,
        total,
        message: Some(format!(
            "Index ready: {} chunks, {} with embeddings (model {}).",
            total,
            embed_ok,
            DEFAULT_EMBED_MODEL
        )),
    });
}

pub fn search_schema_chunks(
    conn: &Connection,
    workspace_id: i64,
    query: &str,
    top_k: usize,
) -> Result<Vec<SchemaSearchHit>, String> {
    let chunks = db::list_schema_index_chunks(conn, workspace_id).map_err(|e| e.to_string())?;
    if chunks.is_empty() {
        return Ok(vec![]);
    }

    let q_tokens = tokenize(query);
    let q_emb = ollama_embed(query, DEFAULT_EMBED_MODEL).ok();

    let mut scored: Vec<(f32, SchemaIndexChunk)> = chunks
        .into_iter()
        .map(|c| {
            let lex = jaccard(&q_tokens, &tokenize(&c.chunk_text));
            let vec_s = match (&q_emb, &c.embedding) {
                (Some(qv), Some(cv)) if qv.len() == cv.len() => cosine_sim(qv, cv).max(0.0),
                _ => 0.0,
            };
            let combined = if vec_s > 0.01 {
                0.75 * vec_s + 0.25 * lex
            } else {
                lex
            };
            (combined, c)
        })
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    Ok(scored
        .into_iter()
        .take(top_k)
        .map(|(score, c)| SchemaSearchHit {
            chunk_text: c.chunk_text,
            source_kind: c.source_kind,
            source_ref: c.source_ref,
            score: score as f64,
        })
        .collect())
}
