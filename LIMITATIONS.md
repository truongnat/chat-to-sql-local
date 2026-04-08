# Limitations and Technical Specifications

Chat-to-SQL (v0.1.0 MVP) is designed for local schema understanding and assisted querying. Please note the following constraints:

## 📐 SQL Parsing Support
- **`CREATE TABLE` focus**: The current parser (`node-sql-parser`) is primarily optimized for standard `CREATE TABLE` and `CREATE INDEX` syntax.
- **`ALTER TABLE` Support**: Complex schema migrations with multiple `ALTER TABLE` operations may result in incomplete visualizations until those changes are manually consolidated into `CREATE` statements.
- **Dialect Variants**: While it supports PostgreSQL, MySQL, and SQLite, vendor-specific extensions (e.g., T-SQL procedures, specialized data types) may have limited parsing accuracy.

## 💾 Resource Constraints
- **File Size Limit**: Individual `.sql` or `.ddl` files are capped at **10MB** to maintain frontend performance and responsiveness.
- **Hardware Dependency**: Inference speed and chat responsiveness depend on your local CPU/GPU and available RAM (8GB+ recommended for 7B/8B models).
- **SQLite Single-File**: The database is stored in a single `.db` file in the application's local data folder.

## 🤖 AI Models (Ollama)
- **Model Whitelist**: Only verified models (Llama 3.1, Phi-3, Mistral, CodeLlama, Qwen 2.5) are suggested by the UI to ensure a high-quality experience. Manual pulls for other models are possible but not officially supported for RAG accuracy in MVP.
- **Local Inference**: Performance and memory usage are managed entirely by your local Ollama instance.

## 📊 Visualizations (ER Diagram)
- **Automatic Layout**: The ER diagram uses a standard `dagre` layout. Large schemas (50+ tables) may require significant zooming and panning.
- **Dynamic Context**: For schemas with 50+ tables, the AI receives only relevant tables and their immediate foreign key neighbors to fit within the model's context window.

## 🔒 Security
- **Encrypted Storage**: Coming in v1.1. Current SQLite storage is not encrypted at rest.
- **Audit Logs**: Current logs are stored in the local SQLite database and are not yet exposed via a UI view.
