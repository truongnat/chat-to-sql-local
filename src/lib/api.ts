import { invoke } from "@tauri-apps/api/core";

export type Dialect =
  | "postgresql"
  | "mysql"
  | "sqlite"
  | "transactsql"
  | "bigquery";

export interface Workspace {
  id: number;
  name: string;
  /** Absolute path: one `.sql` / `.ddl` file, or a directory scanned recursively for those files. */
  rootPath: string;
  dialect: string;
  ollamaModel: string | null;
  createdAt: number;
}

export interface FileContent {
  relativePath: string;
  content: string;
  mtimeMs: number;
}

export interface ParsedColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPk: boolean;
}

export interface ParsedFk {
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface ParsedIndex {
  name: string;
  columns: string[];
}

/** camelCase for Tauri / serde */
export interface ParsedTable {
  name: string;
  filePath: string;
  columns: ParsedColumn[];
  foreignKeys: ParsedFk[];
  indexes: ParsedIndex[];
}

export interface ParsedSchemaObject {
  kind: "index" | "function" | "view";
  name: string;
  filePath: string;
  targetTable?: string | null;
  columns: string[];
  previewSql: string;
}

export interface ParsedSchemaPayload {
  tables: ParsedTable[];
  /** Standalone INDEX / FUNCTION / VIEW — stored for diagram; not shown in schema tree. */
  schemaObjects?: ParsedSchemaObject[];
}

export interface ParsedSchemaObjectRecord {
  id: number;
  workspaceId: number;
  kind: string;
  name: string;
  filePath: string;
  targetTable: string | null;
  columns: string[];
  previewSql: string;
}

export interface WorkspaceSchemaStats {
  sqlFileCount: number;
  tableCount: number;
  standaloneIndexCount: number;
  functionCount: number;
  viewCount: number;
}

export interface SqlFileRecord {
  id: number;
  workspaceId: number;
  relativePath: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface ChatSession {
  id: number;
  workspaceId: number;
  title: string;
  createdAt: number;
}

export interface ChatMessage {
  id: number;
  sessionId: number;
  role: string;
  content: string;
  createdAt: number;
}

export interface VerifiedModel {
  name: string;
  displayName: string;
  description: string;
  parameterSize: string;
  checksum: string;
}

export interface VerificationResult {
  models: {
    name: string;
    digest: string;
    verified: boolean;
    reason: string;
    details: any;
  }[];
}

export interface AuditLog {
  id: number;
  timestamp: number;
  eventType: string;
  workspaceId: number | null;
  metadata: string | null;
}

export function getAuditLogs(): Promise<AuditLog[]> {
  return invoke("get_audit_logs");
}

export function exportAuditLogs(): Promise<string> {
  return invoke("export_audit_logs");
}

export function getVerifiedModels(): Promise<VerifiedModel[]> {
  return invoke("get_verified_models");
}

export function verifyOllamaModels(): Promise<VerificationResult> {
  return invoke("verify_ollama_models");
}

export function createWorkspace(
  name: string,
  rootPath: string,
): Promise<Workspace> {
  return invoke("create_workspace", { name, rootPath });
}

export function listWorkspaces(): Promise<Workspace[]> {
  return invoke("list_workspaces");
}

/** Platform-specific attempt to launch Ollama (app or `ollama serve`). */
export function tryStartOllama(): Promise<string> {
  return invoke("try_start_ollama");
}

/** Download official Ollama installer into app data (emits `ollama-download-*` events). */
export function startOllamaInstallerDownload(): Promise<void> {
  return invoke("start_ollama_installer_download");
}

export function ollamaInstallerExists(): Promise<boolean> {
  return invoke("ollama_installer_exists");
}

/** Run the downloaded installer (DMG→copy/open, Setup.exe, or install.sh). */
export function installOllamaFromDownload(): Promise<string> {
  return invoke("install_ollama_from_download");
}

export function getWorkspace(id: number): Promise<Workspace | null> {
  return invoke("get_workspace", { id });
}

export function updateWorkspaceDialect(
  id: number,
  dialect: string,
): Promise<void> {
  return invoke("update_workspace_dialect", { id, dialect });
}

export function updateWorkspaceModel(
  id: number,
  model: string | null,
): Promise<void> {
  return invoke("update_workspace_model", { id, model });
}

/** Update display name and/or SQL file path (restarts file watcher when path changes). */
export function updateWorkspace(
  id: number,
  opts: { name?: string; rootPath?: string },
): Promise<void> {
  return invoke("update_workspace", {
    id,
    name: opts.name,
    rootPath: opts.rootPath,
  });
}

export function deleteWorkspace(id: number): Promise<void> {
  return invoke("delete_workspace", { id });
}

export function rescanWorkspace(id: number): Promise<FileContent[]> {
  return invoke("rescan_workspace", { id });
}

export function saveParsedSchema(
  workspaceId: number,
  schema: ParsedSchemaPayload,
): Promise<void> {
  return invoke("save_parsed_schema", { workspaceId, schema });
}

export function loadParsedSchemaObjects(
  workspaceId: number,
): Promise<ParsedSchemaObjectRecord[]> {
  return invoke("load_parsed_schema_objects", { workspaceId });
}

export function getWorkspaceSchemaStats(
  workspaceId: number,
): Promise<WorkspaceSchemaStats> {
  return invoke("get_workspace_schema_stats", { workspaceId });
}

export interface LoadedTable {
  name: string;
  filePath: string;
  columns: ParsedColumn[];
  foreignKeys: ParsedFk[];
  indexes: ParsedIndex[];
}

export function loadParsedSchema(workspaceId: number): Promise<LoadedTable[]> {
  return invoke("load_parsed_schema", { workspaceId });
}

export function listSqlFiles(workspaceId: number): Promise<SqlFileRecord[]> {
  return invoke("list_sql_files", { workspaceId });
}

export function createChatSession(
  workspaceId: number,
  title: string,
): Promise<ChatSession> {
  return invoke("create_chat_session", { workspaceId, title });
}

export function listChatSessions(workspaceId: number): Promise<ChatSession[]> {
  return invoke("list_chat_sessions", { workspaceId });
}

export function updateChatSessionTitle(
  sessionId: number,
  title: string,
): Promise<void> {
  return invoke("update_chat_session_title", { sessionId, title });
}

export function deleteChatSession(
  workspaceId: number,
  sessionId: number,
): Promise<void> {
  return invoke("delete_chat_session", { workspaceId, sessionId });
}

export function appendChatMessage(
  sessionId: number,
  role: string,
  content: string,
): Promise<ChatMessage> {
  return invoke("append_chat_message", {
    sessionId,
    role,
    content,
  });
}

export function listChatMessages(sessionId: number): Promise<ChatMessage[]> {
  return invoke("list_chat_messages", { sessionId });
}

export interface SchemaSearchHit {
  chunkText: string;
  sourceKind: string;
  sourceRef: string;
  score: number;
}

export function rebuildSchemaVectorIndex(workspaceId: number): Promise<void> {
  return invoke("rebuild_schema_vector_index", { workspaceId });
}

export function searchSchemaForChat(
  workspaceId: number,
  query: string,
  topK?: number,
): Promise<SchemaSearchHit[]> {
  return invoke("search_schema_for_chat", {
    workspaceId,
    query,
    topK: topK ?? 8,
  });
}
