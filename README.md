# Chat-to-SQL (sql-chat)

Desktop app (Tauri + React) for chatting with a **local SQL schema**: workspace root is either **one** `.sql` / `.ddl` file (e.g. DBeaver export) or a **folder** of scripts (e.g. `db/migrations/`). Parsed `CREATE TABLE` metadata, optional **Ollama** chat, and an **ER diagram** from declared foreign keys.

## Features

- **Workspace** — Pick a **file** or a **folder**. Folders are scanned recursively for `.sql` / `.ddl` (skips `node_modules`, `.git`, `target`, `dist`, etc.). Files are merged in **lexicographic order of relative path** so names like `001_…`, `002_…` apply in sequence; the **last** `CREATE TABLE` for a given table name wins. Dialect: PostgreSQL, MySQL, SQLite, T-SQL, BigQuery (parser mode).
- **Schema browser (full screen)** — **Tables** tab lists every column with **full data type** text, PK / NOT NULL, and a **REFERENCES / FK** line when the parser found a link (`REFERENCES` on a column or `FOREIGN KEY … REFERENCES`).
- **ER diagram** — **Diagram** tab: React Flow + Dagre layout. Each table is a card with **complete types** (word-wrapped), PK/FK icons, and an inline **REFERENCES …** line on FK columns. **Cyan edges** connect referenced parent → child; edge labels show `local_col → ref_col`. Self-references use a bezier loop when parent and child are the same table.
- **Chat** — Multiple sessions per workspace, titles from the first user message, model picker next to Send, schema-aware system prompt + optional vector index (Ollama embeddings) for retrieval.
- **Rescan** — Reload from disk (all indexed files under the root); re-parse and rebuild the vector index when configured. After upgrading the app, run **Rescan** once so column types stored in the local DB match the current parser (older snapshots could show empty or `()` types until you do).

## Folder migrations vs single export

- **Single file** — Full snapshot from a tool is simplest: everything is visible to the parser in one pass.
- **Folder** — The app does **not** execute migrations; it only **reads** SQL and extracts `CREATE` (and related) statements. Incremental files that mostly use **`ALTER TABLE`** without repeating full `CREATE TABLE` definitions may produce an **incomplete** diagram until those changes appear as `CREATE` in some file (or you add a generated snapshot). Prefer zero-padded numeric prefixes (`001_`, `010_`) so lexicographic order matches apply order.

## Requirements

- **Rust** (for Tauri)
- **Node** / **npm** (or **bun** per `package.json`)
- **Ollama** on `127.0.0.1:11434` for chat and (optionally) embeddings (`nomic-embed-text` or similar for the schema index)

## SQL: foreign keys on the diagram

The UI only shows relationships that the **parser** extracts:

1. **Column-level** — e.g. `user_id uuid REFERENCES users(id)` or `REFERENCES public.users(id)`.
2. **Table-level** — `CONSTRAINT fk_name FOREIGN KEY (a, b) REFERENCES other(x, y)`.

Identifiers are normalized (quotes/backticks stripped; schema prefixes like `public.users` match a table named `users`). If a `REFERENCES` target table is **not** among the parsed tables in the file, **no edge** is drawn (the referenced object is outside the loaded schema).

After changing SQL, use **Rescan** so the tree and diagram update.

## Scripts

```bash
npm install
npm run dev          # Vite frontend only
npm run tauri dev    # Desktop app
npm run build        # Frontend production build
npm run tauri build  # Desktop release
```

## Project layout (short)

| Path | Role |
|------|------|
| `src/App.tsx` | Workspaces, schema full-screen panel, vector index banner |
| `src/components/ChatPanel.tsx` | Ollama, sessions, send, RAG |
| `src/components/SchemaErDiagram.tsx` | ER graph (React Flow) |
| `src/components/SchemaTree.tsx` | Table/column list + REFERENCES lines |
| `src/lib/parseSchema.ts` | `node-sql-parser` → tables, columns, FKs |
| `src/lib/schemaDisplay.ts` | Shared type normalization + FK display strings |
| `src-tauri/` | SQLite DB, file watcher, vector index, IPC |

## License

See repository license if present; default template terms may apply.
