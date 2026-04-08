# Changelog

All notable changes to Chat-to-SQL will be documented in this file.

## [0.1.0] - 2026-04-07
### 🚀 Added (MVP Release)
- **Local-only AI Chat**: Integration with Ollama for 100% offline schema understanding.
- **SQL Parsing**: Support for `.sql` and `.ddl` (PostgreSQL, MySQL, SQLite) using `node-sql-parser`.
- **ER Diagram**: Dynamic visualization of tables and foreign key relationships with React Flow.
- **RAG for Schemas**: Intelligent context injection for large schemas (50+ tables).
- **Workspace Support**: Open individual SQL files or entire folders recursively.

### 🔒 Security & Stability
- **Ollama Isolation**: Enforced `OLLAMA_HOST=127.0.0.1` and `OLLAMA_ORIGINS`.
- **Network Lockdown**: Strict Content Security Policy (CSP) blocking external egress.
- **File Sandbox**: Restricts workspace to `.sql`/`.ddl` files with a 10MB limit.
- **Audit Logs**: Backend implementation of local system event logging.
- **Error Recovery**: Improved Ollama chat stream resilience and timeouts.
- **Verified Models**: Whitelist of suggestible and tested local models.

### 🔧 Fixed
- Initial stability improvements for high-volume table parsing.
- UI responsiveness for complex ER diagrams.
