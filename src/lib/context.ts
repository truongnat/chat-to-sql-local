import type { Dialect, LoadedTable } from "./api";

const TABLE_THRESHOLD = 50;

function tokenizeQuestion(q: string): Set<string> {
  const words = q
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return new Set(words);
}

/** Tables whose name appears in the question, plus 1-hop FK neighbors. */
export function selectRelevantTables(
  tables: LoadedTable[],
  userMessage: string,
): LoadedTable[] {
  if (tables.length <= TABLE_THRESHOLD) return tables;

  const tokens = tokenizeQuestion(userMessage);
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const picked = new Set<string>();

  for (const t of tables) {
    const lower = t.name.toLowerCase();
    if (tokens.has(lower)) picked.add(t.name);
    for (const c of t.columns) {
      if (tokens.has(c.name.toLowerCase())) picked.add(t.name);
    }
  }

  if (picked.size === 0) {
    return tables.slice(0, TABLE_THRESHOLD);
  }

  const expand = new Set(picked);
  for (const name of picked) {
    const tbl = byName.get(name.toLowerCase());
    if (!tbl) continue;
    for (const fk of tbl.foreignKeys) {
      const ref = byName.get(fk.referencedTable.toLowerCase());
      if (ref) expand.add(ref.name);
    }
  }
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      if (picked.has(fk.referencedTable)) expand.add(t.name);
    }
  }

  const list = tables.filter((t) => expand.has(t.name));
  return list.length ? list : tables.slice(0, TABLE_THRESHOLD);
}

function formatTable(t: LoadedTable): string {
  const lines: string[] = [];
  lines.push(`Table ${t.name} (from ${t.filePath}):`);
  for (const c of t.columns) {
    const nn = c.nullable ? "NULL" : "NOT NULL";
    const pk = c.isPk ? " PRIMARY KEY" : "";
    lines.push(`  - ${c.name}: ${c.type} ${nn}${pk}`);
  }
  for (const fk of t.foreignKeys) {
    lines.push(
      `  FK (${fk.columns.join(", ")}) -> ${fk.referencedTable}(${fk.referencedColumns.join(", ")})`,
    );
  }
  for (const ix of t.indexes) {
    lines.push(`  INDEX ${ix.name} (${ix.columns.join(", ")})`);
  }
  return lines.join("\n");
}

export function buildSystemPrompt(
  tables: LoadedTable[],
  dialect: Dialect,
): string {
  const dialectHint =
    dialect === "postgresql"
      ? "PostgreSQL"
      : dialect === "mysql"
        ? "MySQL"
        : dialect === "sqlite"
          ? "SQLite"
          : dialect === "transactsql"
            ? "T-SQL / SQL Server"
            : "BigQuery";

  const body = tables.map((t) => formatTable(t)).join("\n\n");
  return `You are an expert ${dialectHint} SQL assistant. The user has the following schema (offline, local DDL):

${body}

Rules:
- Generate only valid ${dialectHint} SQL unless the user asks for explanation.
- When the user wants a query, respond with a single SQL statement inside a markdown code block: \`\`\`sql ... \`\`\`
- Prefer explicit column lists over SELECT * when reasonable.
- Respect foreign key relationships when joining.`;
}

export function extractSqlBlock(text: string): string | null {
  const m = text.match(/```sql\s*([\s\S]*?)```/i);
  if (m) return m[1].trim();
  const m2 = text.match(/```\s*([\s\S]*?)```/);
  if (m2 && /^\s*(select|with|insert|update|delete|create)\b/i.test(m2[1]))
    return m2[1].trim();
  return null;
}
