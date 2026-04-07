use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: i64,
    pub name: String,
    pub root_path: String,
    pub dialect: String,
    pub ollama_model: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileRecord {
    pub id: i64,
    pub workspace_id: i64,
    pub relative_path: String,
    pub mtime_ms: i64,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub relative_path: String,
    pub content: String,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedColumnPayload {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default, rename = "isPk")]
    pub is_pk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFkPayload {
    pub columns: Vec<String>,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedIndexPayload {
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTablePayload {
    pub name: String,
    pub file_path: String,
    pub columns: Vec<ParsedColumnPayload>,
    #[serde(default)]
    pub foreign_keys: Vec<ParsedFkPayload>,
    #[serde(default)]
    pub indexes: Vec<ParsedIndexPayload>,
}

/// Standalone CREATE INDEX / FUNCTION / VIEW / … for diagram & context (not shown in schema tree).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSchemaObjectPayload {
    pub kind: String,
    pub name: String,
    pub file_path: String,
    #[serde(default)]
    pub target_table: Option<String>,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub preview_sql: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSchemaPayload {
    pub tables: Vec<ParsedTablePayload>,
    #[serde(default)]
    pub schema_objects: Vec<ParsedSchemaObjectPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSchemaObjectRecord {
    pub id: i64,
    pub workspace_id: i64,
    pub kind: String,
    pub name: String,
    pub file_path: String,
    pub target_table: Option<String>,
    pub columns: Vec<String>,
    pub preview_sql: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSchemaStats {
    pub sql_file_count: i64,
    pub table_count: i64,
    pub standalone_index_count: i64,
    pub function_count: i64,
    pub view_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: i64,
    pub workspace_id: i64,
    pub title: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: i64,
    pub session_id: i64,
    pub role: String,
    pub content: String,
    pub created_at: i64,
}
