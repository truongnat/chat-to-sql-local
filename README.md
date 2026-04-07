# Chat-to-SQL (MVP)

An intelligent, **Local-only** SQL Assistant that helps you understand and query your database schema without your data ever leaving your machine.

## 🛡️ Security Guarantees (Privacy First)

This application is built with a "Zero-Trust" approach to cloud privacy:
- **100% Local Processing**: All AI inference is done via [Ollama](https://ollama.com/) on your own hardware.
- **No External Calls**: The app's Content Security Policy (CSP) blocks all outbound network traffic except for `localhost:11434`.
- **Verified Models Only**: Only approved and tested models (Llama 3.1, Phi-3, etc.) are suggested to ensure stability and safety.
- **Audit Logs**: All major system events (workspace creation, chat initiation) are logged locally in a transparent SQLite database for your own audit.

## 🚀 Getting Started

### Prerequisites
1. **Install Ollama**: Download and install from [ollama.com](https://ollama.com/).
2. **Start Ollama**: Ensure Ollama is running (`ollama serve`). The app will attempt to start it automatically on launch.

### Installation
- **Windows**: Run the `.msi` installer.
- **macOS**: Drag the `.app` to your Applications folder from the `.dmg`.
- **Linux**: Use the `.AppImage` or install the `.deb` package.

## ✨ Features
- **SQL/DDL Parsing**: Support for PostgreSQL, MySQL, and SQLite `CREATE TABLE` statements.
- **ER Diagram**: Automatically visualize your schema and foreign key relationships.
- **Schema Context**: Intelligent RAG (Retrieval-Augmented Generation) that sends only relevant table definitions to the AI.
- **Local Persistence**: All workspaces and chat histories are stored in a local SQLite database.

## ⚠️ Limitations & Technical Specs
- **File Limit**: Individual `.sql` or `.ddl` files are limited to **10MB** to ensure performance.
- **Dialect Support**: Primarily optimized for `CREATE TABLE` syntax. Complex `ALTER TABLE` or vendor-specific extensions might have limited parsing support in MVP.
- **Hardware**: AI performance depends on your local CPU/GPU (8GB+ RAM recommended for 7B/8B models).

## 🛠️ Troubleshooting
- **Ollama unreachable**: Ensure no firewall is blocking port `11434` and `OLLAMA_HOST` is set to `127.0.0.1`.
- **Parsing errors**: If a table doesn't appear in the diagram, check for syntax errors in your SQL file. The app logs skipped files in the local audit trail.

---
Built with **Tauri v2**, **React**, and **Rust**. Locked for Privacy.
