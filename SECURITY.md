# Security Policy

## 🔒 Local-Only Guarantee
Chat-to-SQL is designed to run entirely on your local machine. We guarantee that:
1. **No Cloud AI**: All inference is performed by your local Ollama instance.
2. **Network Isolation**: The application's Content Security Policy (CSP) blocks all outbound traffic except for `localhost:11434` (Ollama IPC).
3. **No Telemetry**: We do not collect analytics, crash reports, or usage data.
4. **Data Persistence**: Your database schema, chat history, and settings are stored in a local SQLite database (`chat-to-sql.db`).

## 🛡️ Reporting a Vulnerability
If you discover a security vulnerability, please report it via GitHub Issues or contact the maintainers directly. Given the local-only nature, please focus on:
- Unexpected network egress.
- Potential for local privilege escalation.
- Sandbox escapes.

## ✅ Security Hardening in MVP 1
- **Ollama Binding**: Enforced `OLLAMA_HOST=127.0.0.1`.
- **Verified Models**: Whitelist of tested and safe models.
- **Audit Logs**: Transparent logging of system events.
- **File Sanitization**: Restricted access to `.sql` and `.ddl` files with a 10MB size limit.
