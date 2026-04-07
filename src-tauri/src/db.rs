use crate::models::{
    ChatMessage, ChatSession, FileContent, ParsedSchemaObjectRecord, ParsedSchemaPayload,
    SqlFileRecord, Workspace, WorkspaceSchemaStats,
};
use rusqlite::{params, Connection};
use rusqlite::OptionalExtension;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute("PRAGMA foreign_keys = ON", [])?;
    migrate(&conn)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            workspace_id INTEGER,
            details TEXT,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
        )",
        [],
    )?;

    Ok(conn)
}

pub fn log_audit_event(
    conn: &Connection,
    event_type: &str,
    workspace_id: Option<i64>,
    details: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO audit_logs (timestamp, event_type, workspace_id, details)
         VALUES (strftime('%s','now') * 1000, ?, ?, ?)",
        params![event_type, workspace_id, details],
    )?;
    Ok(())
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS workspaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            root_path TEXT NOT NULL UNIQUE,
            dialect TEXT NOT NULL DEFAULT 'postgresql',
            ollama_model TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sql_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            relative_path TEXT NOT NULL,
            mtime_ms INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL,
            UNIQUE(workspace_id, relative_path)
        );

        CREATE TABLE IF NOT EXISTS parsed_tables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            sql_file_id INTEGER REFERENCES sql_files(id) ON DELETE SET NULL,
            name TEXT NOT NULL,
            file_path TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS parsed_columns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id INTEGER NOT NULL REFERENCES parsed_tables(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            col_type TEXT NOT NULL,
            nullable INTEGER NOT NULL DEFAULT 0,
            is_pk INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS parsed_fks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id INTEGER NOT NULL REFERENCES parsed_tables(id) ON DELETE CASCADE,
            columns_json TEXT NOT NULL,
            ref_table TEXT NOT NULL,
            ref_columns_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS parsed_indexes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id INTEGER NOT NULL REFERENCES parsed_tables(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            columns_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            title TEXT NOT NULL DEFAULT 'Chat',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sql_files_workspace ON sql_files(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_parsed_tables_workspace ON parsed_tables(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace ON chat_sessions(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);

        CREATE TABLE IF NOT EXISTS parsed_schema_objects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            target_table TEXT,
            columns_json TEXT NOT NULL,
            preview_sql TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_parsed_schema_objects_workspace ON parsed_schema_objects(workspace_id);

        CREATE TABLE IF NOT EXISTS schema_index_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            source_kind TEXT NOT NULL,
            source_ref TEXT NOT NULL,
            chunk_text TEXT NOT NULL,
            embedding BLOB,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_schema_index_chunks_workspace ON schema_index_chunks(workspace_id);
        "#,
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct SchemaIndexChunk {
    #[allow(dead_code)]
    pub id: i64,
    pub source_kind: String,
    pub source_ref: String,
    pub chunk_text: String,
    pub embedding: Option<Vec<f32>>,
}

fn f32_slice_to_blob(v: &[f32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(v.len() * 4);
    for x in v {
        b.extend_from_slice(&x.to_le_bytes());
    }
    b
}

pub fn blob_to_f32_vec(blob: Option<Vec<u8>>) -> Option<Vec<f32>> {
    let b = blob?;
    if b.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(b.len() / 4);
    for chunk in b.chunks_exact(4) {
        out.push(f32::from_le_bytes(
            chunk.try_into().ok()?,
        ));
    }
    Some(out)
}

pub fn clear_schema_index_chunks(conn: &Connection, workspace_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM schema_index_chunks WHERE workspace_id = ?1",
        params![workspace_id],
    )?;
    Ok(())
}

pub fn insert_schema_index_chunk(
    conn: &Connection,
    workspace_id: i64,
    source_kind: &str,
    source_ref: &str,
    chunk_text: &str,
    embedding: Option<&[f32]>,
) -> rusqlite::Result<i64> {
    let now = now_ms();
    let blob = embedding.map(f32_slice_to_blob);
    conn.execute(
        r#"INSERT INTO schema_index_chunks (workspace_id, source_kind, source_ref, chunk_text, embedding, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
        params![
            workspace_id,
            source_kind,
            source_ref,
            chunk_text,
            blob,
            now,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_schema_index_chunks(
    conn: &Connection,
    workspace_id: i64,
) -> rusqlite::Result<Vec<SchemaIndexChunk>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_kind, source_ref, chunk_text, embedding FROM schema_index_chunks WHERE workspace_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map(params![workspace_id], |r| {
        let emb_blob: Option<Vec<u8>> = r.get(4)?;
        Ok(SchemaIndexChunk {
            id: r.get(0)?,
            source_kind: r.get(1)?,
            source_ref: r.get(2)?,
            chunk_text: r.get(3)?,
            embedding: blob_to_f32_vec(emb_blob),
        })
    })?;
    rows.collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn create_workspace(conn: &Connection, name: &str, root_path: &str) -> rusqlite::Result<Workspace> {
    let created_at = now_ms();
    conn.execute(
        "INSERT INTO workspaces (name, root_path, dialect, ollama_model, created_at) VALUES (?1, ?2, 'postgresql', NULL, ?3)",
        params![name, root_path, created_at],
    )?;
    let id = conn.last_insert_rowid();
    let _ = log_audit_event(conn, "WORKSPACE_CREATE", Some(id), Some(root_path));
    get_workspace(conn, id).map(|w| w.expect("inserted"))
}

pub fn list_workspaces(conn: &Connection) -> rusqlite::Result<Vec<Workspace>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, root_path, dialect, ollama_model, created_at FROM workspaces ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Workspace {
            id: r.get(0)?,
            name: r.get(1)?,
            root_path: r.get(2)?,
            dialect: r.get(3)?,
            ollama_model: r.get(4)?,
            created_at: r.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn get_workspace(conn: &Connection, id: i64) -> rusqlite::Result<Option<Workspace>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, root_path, dialect, ollama_model, created_at FROM workspaces WHERE id = ?1",
    )?;
    stmt.query_row(params![id], |r| {
        Ok(Workspace {
            id: r.get(0)?,
            name: r.get(1)?,
            root_path: r.get(2)?,
            dialect: r.get(3)?,
            ollama_model: r.get(4)?,
            created_at: r.get(5)?,
        })
    })
    .optional()
}

pub fn update_workspace_dialect(conn: &Connection, id: i64, dialect: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE workspaces SET dialect = ?1 WHERE id = ?2",
        params![dialect, id],
    )?;
    Ok(())
}

pub fn update_workspace_model(conn: &Connection, id: i64, model: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE workspaces SET ollama_model = ?1 WHERE id = ?2",
        params![model, id],
    )?;
    Ok(())
}

pub fn update_workspace_name(conn: &Connection, id: i64, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE workspaces SET name = ?1 WHERE id = ?2",
        params![name, id],
    )?;
    Ok(())
}

pub fn update_workspace_root_path(conn: &Connection, id: i64, root_path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE workspaces SET root_path = ?1 WHERE id = ?2",
        params![root_path, id],
    )?;
    Ok(())
}

pub fn delete_workspace(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
    Ok(())
}

fn is_sql_or_ddl_file(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "sql" || e == "ddl"
        })
        .unwrap_or(false)
}

/// Skip heavy / non-SQL subtrees when scanning a folder workspace.
fn should_skip_subdir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | "target"
            | "dist"
            | ".venv"
            | "__pycache__"
            | ".next"
            | "build"
    )
}

fn rel_path_from_root(root: &Path, file: &Path) -> String {
    file.strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
}

/// All `.sql` / `.ddl` files under `root_dir`, depth-first stack walk, sorted by relative path.
fn collect_sql_ddl_under(root_dir: &Path) -> Result<Vec<PathBuf>, Box<dyn std::error::Error + Send + Sync>> {
    let mut found = Vec::new();
    let mut stack = vec![root_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in read.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if should_skip_subdir(name) {
                        continue;
                    }
                }
                stack.push(path);
            } else if ft.is_file() && is_sql_or_ddl_file(&path) {
                found.push(path);
            }
        }
    }
    found.sort_by(|a, b| rel_path_from_root(root_dir, a).cmp(&rel_path_from_root(root_dir, b)));
    Ok(found)
}

/// Load one `.sql` / `.ddl` file, **or** every `.sql` / `.ddl` under a directory (e.g. `db/migrations/`).
/// `workspaces.root_path` is the absolute file or folder path. Files are merged in **lexicographic
/// order of relative path** (`001_…` before `002_…` when zero-padded). Same table name in a later file
/// overwrites earlier definitions in the in-memory merge (`buildSchemaFromFiles`).
pub fn rescan_workspace_files(
    conn: &Connection,
    workspace_id: i64,
) -> Result<Vec<FileContent>, Box<dyn std::error::Error + Send + Sync>> {
    let ws = get_workspace(conn, workspace_id)?
        .ok_or_else(|| format!("workspace {} not found", workspace_id))?;
    let root = Path::new(&ws.root_path);
    if !root.exists() {
        return Err(format!("path does not exist: {}", ws.root_path).into());
    }

    let _ = log_audit_event(conn, "WORKSPACE_RESCAN_START", Some(workspace_id), None);

    let indexed: Vec<(String, PathBuf)> = if root.is_dir() {
        let paths = collect_sql_ddl_under(root)?;
        if paths.is_empty() {
            return Err(format!(
                "no .sql or .ddl files found under directory: {}",
                ws.root_path
            )
            .into());
        }
        paths
            .into_iter()
            .map(|p| (rel_path_from_root(root, &p), p))
            .collect()
    } else if root.is_file() {
        if !is_sql_or_ddl_file(root) {
            let ext = root
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            return Err(format!("only .sql and .ddl files are supported (got .{ext})").into());
        }
        let rel_str = root
            .file_name()
            .map(|n| n.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| "schema.sql".into());
        vec![(rel_str, root.to_path_buf())]
    } else {
        return Err(format!("not a file or directory: {}", ws.root_path).into());
    };

    let mut out: Vec<FileContent> = Vec::with_capacity(indexed.len());
    let mut seen_rel: HashSet<String> = HashSet::new();
    let max_size = 10 * 1024 * 1024; // 10MB

    for (rel_str, full_path) in &indexed {
        seen_rel.insert(rel_str.clone());
        let meta = std::fs::metadata(full_path)?;
        let size_bytes = meta.len() as i64;

        if size_bytes > max_size {
            let _ = log_audit_event(
                conn,
                "FILE_SKIPPED_TOO_LARGE",
                Some(workspace_id),
                Some(&rel_str),
            );
            continue;
        }

        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        conn.execute(
            r#"INSERT INTO sql_files (workspace_id, relative_path, mtime_ms, size_bytes)
               VALUES (?1, ?2, ?3, ?4)
               ON CONFLICT(workspace_id, relative_path) DO UPDATE SET
                 mtime_ms = excluded.mtime_ms,
                 size_bytes = excluded.size_bytes"#,
            params![workspace_id, rel_str, mtime_ms, size_bytes],
        )?;

        let content = std::fs::read_to_string(full_path).unwrap_or_else(|_| {
            String::from_utf8_lossy(&std::fs::read(full_path).unwrap_or_default()).into_owned()
        });

        out.push(FileContent {
            relative_path: rel_str.clone(),
            content,
            mtime_ms,
        });
    }

    let existing: Vec<String> = {
        let mut stmt = conn.prepare("SELECT relative_path FROM sql_files WHERE workspace_id = ?1")?;
        let rows = stmt.query_map(params![workspace_id], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for p in existing {
        if !seen_rel.contains(&p) {
            conn.execute(
                "DELETE FROM sql_files WHERE workspace_id = ?1 AND relative_path = ?2",
                params![workspace_id, p],
            )?;
        }
    }

    let _ = log_audit_event(conn, "WORKSPACE_RESCAN_END", Some(workspace_id), None);

    Ok(out)
}

pub fn save_parsed_schema(
    conn: &Connection,
    workspace_id: i64,
    schema: &ParsedSchemaPayload,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "DELETE FROM parsed_tables WHERE workspace_id = ?1",
        params![workspace_id],
    )?;
    tx.execute(
        "DELETE FROM parsed_schema_objects WHERE workspace_id = ?1",
        params![workspace_id],
    )?;

    for obj in &schema.schema_objects {
        let cols = serde_json::to_string(&obj.columns).unwrap_or_else(|_| "[]".into());
        tx.execute(
            r#"INSERT INTO parsed_schema_objects (workspace_id, kind, name, file_path, target_table, columns_json, preview_sql)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
            params![
                workspace_id,
                obj.kind,
                obj.name,
                obj.file_path,
                obj.target_table,
                cols,
                obj.preview_sql,
            ],
        )?;
    }

    for table in &schema.tables {
        let sql_file_id: Option<i64> = tx
            .query_row(
                "SELECT id FROM sql_files WHERE workspace_id = ?1 AND relative_path = ?2",
                params![workspace_id, table.file_path],
                |r| r.get(0),
            )
            .optional()?;

        tx.execute(
            "INSERT INTO parsed_tables (workspace_id, sql_file_id, name, file_path) VALUES (?1, ?2, ?3, ?4)",
            params![workspace_id, sql_file_id, table.name, table.file_path],
        )?;
        let table_id = tx.last_insert_rowid();

        for col in &table.columns {
            tx.execute(
                "INSERT INTO parsed_columns (table_id, name, col_type, nullable, is_pk) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    table_id,
                    col.name,
                    col.r#type,
                    if col.nullable { 1i32 } else { 0 },
                    if col.is_pk { 1i32 } else { 0 },
                ],
            )?;
        }

        for fk in &table.foreign_keys {
            let cols = serde_json::to_string(&fk.columns).unwrap_or_else(|_| "[]".into());
            let ref_cols = serde_json::to_string(&fk.referenced_columns).unwrap_or_else(|_| "[]".into());
            tx.execute(
                "INSERT INTO parsed_fks (table_id, columns_json, ref_table, ref_columns_json) VALUES (?1, ?2, ?3, ?4)",
                params![table_id, cols, fk.referenced_table, ref_cols],
            )?;
        }

        for idx in &table.indexes {
            let cols = serde_json::to_string(&idx.columns).unwrap_or_else(|_| "[]".into());
            tx.execute(
                "INSERT INTO parsed_indexes (table_id, name, columns_json) VALUES (?1, ?2, ?3)",
                params![table_id, idx.name, cols],
            )?;
        }
    }

    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedTable {
    pub name: String,
    pub file_path: String,
    pub columns: Vec<LoadedColumn>,
    pub foreign_keys: Vec<LoadedFk>,
    pub indexes: Vec<LoadedIndex>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub nullable: bool,
    #[serde(rename = "isPk")]
    pub is_pk: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedFk {
    pub columns: Vec<String>,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedIndex {
    pub name: String,
    pub columns: Vec<String>,
}

pub fn load_parsed_schema(conn: &Connection, workspace_id: i64) -> rusqlite::Result<Vec<LoadedTable>> {
    let mut stmt_tables = conn.prepare(
        "SELECT id, name, file_path FROM parsed_tables WHERE workspace_id = ?1 ORDER BY name",
    )?;
    let table_rows = stmt_tables.query_map(params![workspace_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;

    let mut tables: Vec<LoadedTable> = Vec::new();
    for tr in table_rows {
        let (tid, name, file_path) = tr?;
        let mut cols_stmt = conn.prepare(
            "SELECT name, col_type, nullable, is_pk FROM parsed_columns WHERE table_id = ?1 ORDER BY id",
        )?;
        let columns: Vec<LoadedColumn> = cols_stmt
            .query_map(params![tid], |r| {
                Ok(LoadedColumn {
                    name: r.get(0)?,
                    r#type: r.get(1)?,
                    nullable: r.get::<_, i32>(2)? != 0,
                    is_pk: r.get::<_, i32>(3)? != 0,
                })
            })?
            .filter_map(|c| c.ok())
            .collect();

        let mut fk_stmt = conn.prepare(
            "SELECT columns_json, ref_table, ref_columns_json FROM parsed_fks WHERE table_id = ?1",
        )?;
        let foreign_keys: Vec<LoadedFk> = fk_stmt
            .query_map(params![tid], |r| {
                let cj: String = r.get(0)?;
                let rj: String = r.get(2)?;
                Ok(LoadedFk {
                    columns: serde_json::from_str(&cj).unwrap_or_default(),
                    referenced_table: r.get(1)?,
                    referenced_columns: serde_json::from_str(&rj).unwrap_or_default(),
                })
            })?
            .filter_map(|c| c.ok())
            .collect();

        let mut ix_stmt = conn.prepare("SELECT name, columns_json FROM parsed_indexes WHERE table_id = ?1")?;
        let indexes: Vec<LoadedIndex> = ix_stmt
            .query_map(params![tid], |r| {
                let cj: String = r.get(1)?;
                Ok(LoadedIndex {
                    name: r.get(0)?,
                    columns: serde_json::from_str(&cj).unwrap_or_default(),
                })
            })?
            .filter_map(|c| c.ok())
            .collect();

        tables.push(LoadedTable {
            name,
            file_path,
            columns,
            foreign_keys,
            indexes,
        });
    }

    Ok(tables)
}

pub fn list_sql_file_records(conn: &Connection, workspace_id: i64) -> rusqlite::Result<Vec<SqlFileRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, relative_path, mtime_ms, size_bytes FROM sql_files WHERE workspace_id = ?1 ORDER BY relative_path",
    )?;
    let rows = stmt.query_map(params![workspace_id], |r| {
        Ok(SqlFileRecord {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            relative_path: r.get(2)?,
            mtime_ms: r.get(3)?,
            size_bytes: r.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn create_chat_session(conn: &Connection, workspace_id: i64, title: &str) -> rusqlite::Result<ChatSession> {
    let created_at = now_ms();
    conn.execute(
        "INSERT INTO chat_sessions (workspace_id, title, created_at) VALUES (?1, ?2, ?3)",
        params![workspace_id, title, created_at],
    )?;
    let id = conn.last_insert_rowid();
    Ok(ChatSession {
        id,
        workspace_id,
        title: title.to_string(),
        created_at,
    })
}

pub fn list_chat_sessions(conn: &Connection, workspace_id: i64) -> rusqlite::Result<Vec<ChatSession>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, title, created_at FROM chat_sessions WHERE workspace_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![workspace_id], |r| {
        Ok(ChatSession {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            title: r.get(2)?,
            created_at: r.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn update_chat_session_title(conn: &Connection, session_id: i64, title: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE chat_sessions SET title = ?1 WHERE id = ?2",
        params![title, session_id],
    )?;
    Ok(())
}

pub fn delete_chat_session_for_workspace(
    conn: &Connection,
    workspace_id: i64,
    session_id: i64,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "DELETE FROM chat_sessions WHERE id = ?1 AND workspace_id = ?2",
        params![session_id, workspace_id],
    )?;
    Ok(n > 0)
}

pub fn append_chat_message(
    conn: &Connection,
    session_id: i64,
    role: &str,
    content: &str,
) -> rusqlite::Result<ChatMessage> {
    let created_at = now_ms();
    conn.execute(
        "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![session_id, role, content, created_at],
    )?;
    let id = conn.last_insert_rowid();

    if role == "user" {
        let ws_id: Option<i64> = conn
            .query_row(
                "SELECT workspace_id FROM chat_sessions WHERE id = ?",
                params![session_id],
                |r| r.get(0),
            )
            .optional()?;
        let _ = log_audit_event(conn, "CHAT_MESSAGE", ws_id, Some("User sent message"));
    }

    Ok(ChatMessage {
        id,
        session_id,
        role: role.to_string(),
        content: content.to_string(),
        created_at,
    })
}

pub fn list_chat_messages(conn: &Connection, session_id: i64) -> rusqlite::Result<Vec<ChatMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, role, content, created_at FROM chat_messages WHERE session_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![session_id], |r| {
        Ok(ChatMessage {
            id: r.get(0)?,
            session_id: r.get(1)?,
            role: r.get(2)?,
            content: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn load_parsed_schema_objects(
    conn: &Connection,
    workspace_id: i64,
) -> rusqlite::Result<Vec<ParsedSchemaObjectRecord>> {
    let mut stmt = conn.prepare(
        r#"SELECT id, workspace_id, kind, name, file_path, target_table, columns_json, preview_sql
           FROM parsed_schema_objects WHERE workspace_id = ?1 ORDER BY kind, name, file_path"#,
    )?;
    let rows = stmt.query_map(params![workspace_id], |r| {
        let cj: String = r.get(6)?;
        Ok(ParsedSchemaObjectRecord {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            kind: r.get(2)?,
            name: r.get(3)?,
            file_path: r.get(4)?,
            target_table: r.get(5)?,
            columns: serde_json::from_str(&cj).unwrap_or_default(),
            preview_sql: r.get(7)?,
        })
    })?;
    rows.collect()
}

pub fn get_workspace_schema_stats(
    conn: &Connection,
    workspace_id: i64,
) -> rusqlite::Result<WorkspaceSchemaStats> {
    let sql_file_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sql_files WHERE workspace_id = ?1",
        params![workspace_id],
        |r| r.get(0),
    )?;
    let table_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM parsed_tables WHERE workspace_id = ?1",
        params![workspace_id],
        |r| r.get(0),
    )?;
    let standalone_index_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM parsed_schema_objects WHERE workspace_id = ?1 AND kind = 'index'",
        params![workspace_id],
        |r| r.get(0),
    )?;
    let function_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM parsed_schema_objects WHERE workspace_id = ?1 AND kind = 'function'",
        params![workspace_id],
        |r| r.get(0),
    )?;
    let view_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM parsed_schema_objects WHERE workspace_id = ?1 AND kind = 'view'",
        params![workspace_id],
        |r| r.get(0),
    )?;
    Ok(WorkspaceSchemaStats {
        sql_file_count,
        table_count,
        standalone_index_count,
        function_count,
        view_count,
    })
}
