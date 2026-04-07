import type { Dialect, LoadedTable, SchemaSearchHit } from "./api";

export function formatRetrievalForPrompt(hits: SchemaSearchHit[]): string {
  if (hits.length === 0) return "";
  return hits
    .map(
      (h, i) =>
        `### Snippet ${i + 1} (${h.sourceKind}: ${h.sourceRef}, score ${h.score.toFixed(3)})\n${h.chunkText}`,
    )
    .join("\n\n");
}

const TABLE_THRESHOLD = 50;

/** Tokens for matching table/column names (ASCII + Latin letters after NFD strip — helps Vietnamese input). */
function tokenizeQuestion(q: string): Set<string> {
  const ascii = q
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  const words = ascii
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return new Set(words);
}

function typeLooksStringish(type: string): boolean {
  return /\b(CHAR|TEXT|VARCHAR|NVARCHAR|NCHAR|CLOB|JSON|JSONB|UUID|DATE|TIME)\b/i.test(
    type,
  );
}

function typeLooksNumericOrBool(type: string): boolean {
  return /\b(INT|INTEGER|BIGINT|SMALLINT|SERIAL|BIGSERIAL|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|BOOL|BOOLEAN|BIT)\b/i.test(
    type,
  );
}

function fkEdgesWithinSubset(tables: LoadedTable[]): string[] {
  const inSubset = new Set(tables.map((t) => t.name.toLowerCase()));
  const lines: string[] = [];
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      if (!inSubset.has(fk.referencedTable.toLowerCase())) continue;
      const lhs = `${t.name}.${fk.columns.join(", ")}`;
      const rhs = `${fk.referencedTable}.${fk.referencedColumns.join(", ")}`;
      lines.push(`\`${lhs} → ${rhs}\``);
    }
  }
  return lines;
}

function schemaMentionsFromTokens(
  tables: LoadedTable[],
  tokens: Set<string>,
): string[] {
  const hits: string[] = [];
  for (const t of tables) {
    const tLower = t.name.toLowerCase();
    const tUnderscore = tLower.replace(/\s+/g, "_");
    if (tokens.has(tLower) || tokens.has(tUnderscore)) {
      hits.push(`table \`${t.name}\``);
    }
    for (const c of t.columns) {
      const cLower = c.name.toLowerCase();
      if (tokens.has(cLower)) hits.push(`\`${t.name}.${c.name}\``);
    }
  }
  return hits;
}

function summarizeTypedColumns(tables: LoadedTable[]): {
  stringy: string[];
  idish: string[];
} {
  const stringy: string[] = [];
  const idish: string[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      const ref = `\`${t.name}.${c.name}\` (${c.type})`;
      if (typeLooksStringish(c.type)) stringy.push(ref);
      else if (
        typeLooksNumericOrBool(c.type) ||
        /(^|_)id$/i.test(c.name) ||
        /^id$/i.test(c.name)
      ) {
        idish.push(ref);
      }
    }
  }
  return { stringy, idish };
}

/** Per-request hints derived from the actual subset + user wording (not hardcoded to one SQL pattern). */
function buildDynamicHints(tables: LoadedTable[], userQuestion: string): string {
  const lines: string[] = [];
  const tokens = tokenizeQuestion(userQuestion);
  const n = tables.length;
  const names = tables.map((t) => `\`${t.name}\``).join(", ");

  lines.push(
    `- **Tables in this prompt (${n}):** ${names || "(none)"}. Use no other tables.`,
  );

  if (n === 1) {
    lines.push(
      "- **Subset:** Only one table is included — default to a **single-table** query. If the user clearly needs another entity, say the schema excerpt does not include it.",
    );
  }

  const fks = fkEdgesWithinSubset(tables);
  if (fks.length > 0) {
    lines.push(
      `- **Declared JOIN paths inside this excerpt:** ${fks.join("; ")}. JOIN only on these column pairs (or self-evident same-column keys), not on guessed semantics.`,
    );
  } else if (n > 1) {
    lines.push(
      "- **FK gap:** No foreign key is declared **between these tables** in this excerpt. Do not fabricate joins; use separate filters, `EXISTS`, or explain that a relationship is not documented here.",
    );
  }

  const mentions = schemaMentionsFromTokens(tables, tokens);
  if (mentions.length > 0) {
    lines.push(
      `- **Overlap with question wording:** ${mentions.join(", ")} — prioritize these when they match the user’s intent.`,
    );
  }

  const { stringy, idish } = summarizeTypedColumns(tables);
  if (stringy.length > 0) {
    lines.push(
      `- **Likely string / date-like columns (quote literals):** ${stringy.slice(0, 24).join(", ")}${stringy.length > 24 ? ", …" : ""}.`,
    );
  }
  if (idish.length > 0) {
    lines.push(
      `- **Likely numeric / id-like columns:** ${idish.slice(0, 24).join(", ")}${idish.length > 24 ? ", …" : ""}.`,
    );
  }
  lines.push(
    "- **Type safety:** Do not `JOIN` or compare a string/email column to an `*_id` / numeric key unless that exact pair appears in **Declared JOIN paths** above.",
  );

  return lines.join("\n");
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
  userQuestion: string,
  retrievalBlock?: string,
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

  const paramHint =
    dialect === "postgresql"
      ? "You may use positional parameters $1, $2, … for literals if you explain them."
      : dialect === "mysql"
        ? "You may use ? placeholders for literals if you explain them."
        : dialect === "sqlite"
          ? "You may use ? placeholders for literals if you explain them."
          : "Use the dialect’s standard parameter style if you explain placeholders.";

  const body = tables.map((t) => formatTable(t)).join("\n\n");
  const q = userQuestion.trim() || "(no question text)";
  const dynamic = buildDynamicHints(tables, userQuestion);
  const rag = retrievalBlock?.trim() ?? "";

  return `You are an expert ${dialectHint} SQL assistant. The schema below is the ONLY source of truth (parsed from local DDL). It may be incomplete.

${body}

## Dynamic hints (this request — generated from the schema subset + question)
${dynamic}
${
  rag
    ? `## Retrieved schema snippets (lexical + vector index over this workspace)
These excerpts ranked highest for the user’s message. Use them to focus on the right tables/columns; they must stay **consistent** with the full schema above (no contradictions).

${rag}

`
    : ""
}

## Current user request
Answer **this** directly. Do not drift to unrelated features, tables, or hypothetical workflows:
"""
${q}
"""

## Schema discipline (mandatory)
- Use **only** tables and columns that appear above. Never invent tables, columns, constraints, or relationships.
- Respect **Dynamic hints** for this turn: they reflect which tables are in context and which joins are actually documented.
- Prefer the **simplest** query that satisfies the request; add tables/joins only when needed and supported by the schema or the dynamic FK list.
- Avoid \`= (SELECT …)\` when the subquery can return multiple rows; use \`IN (...)\`, \`EXISTS\`, or a provably single-row subquery.

## Explanation and SQL must match
- Keep prose short and aligned with the SQL: same tables, same filters, same literals.
- Any concrete value you mention in text (email, id, name, date) must appear in the SQL—or as a named/positional parameter with a one-line note.
- You may answer in the same language as the user’s question.

## Literals and types (mandatory — unquoted strings break execution)
- Follow the **column types** in the schema: \`varchar\`, \`text\`, \`char\`, \`uuid\`, dates/timestamps, and free-text fields (e.g. email, name, slug) require **single-quoted** string literals in ${dialectHint}.
- **Wrong:** \`WHERE u.email = user@example.com\` — the parser treats \`user\`, \`example\`, \`com\` as identifiers, not one string.
- **Right:** \`WHERE u.email = 'user@example.com'\`
- **Numeric** columns (\`int\`, \`bigint\`, \`serial\`, \`decimal\`, etc.): use unquoted numbers, e.g. \`WHERE id = 42\`.
- **Inside strings:** escape a single quote by doubling: \`'O''Brien'\`.
- If you use parameters instead of literals, say what value binds to each placeholder; otherwise every string/date value in the SQL must be visibly quoted.
${dialect === "transactsql" ? "- For Unicode text columns, prefer **N'string'** when the column is \`nvarchar\`/\`nchar\`.\n" : ""}

## SQL output
- Unless the user only wants explanation, include **one** ${dialectHint} statement in a markdown fence: \`\`\`sql ... \`\`\`
- Prefer explicit column lists instead of SELECT * when it stays readable.
- ${paramHint}

If the schema is insufficient for the request, say so in one or two sentences and give the minimal query you *can* justify—or ask what is missing. Do not hallucinate complex multi-table logic.`;
}

/** First \`\`\`sql\`\`\` or generic fenced block whose body looks like SQL (same rules as extract). */
function firstSqlFenceSpan(text: string): {
  start: number;
  end: number;
  inner: string;
} | null {
  const r1 = /```sql\s*([\s\S]*?)```/i;
  const m1 = r1.exec(text);
  if (m1 && m1.index !== undefined) {
    return {
      start: m1.index,
      end: m1.index + m1[0].length,
      inner: m1[1].trim(),
    };
  }
  const r2 = /```\s*([\s\S]*?)```/;
  const m2 = r2.exec(text);
  if (
    m2 &&
    m2.index !== undefined &&
    /^\s*(select|with|insert|update|delete|create)\b/i.test(m2[1])
  ) {
    return {
      start: m2.index,
      end: m2.index + m2[0].length,
      inner: m2[1].trim(),
    };
  }
  return null;
}

export function extractSqlBlock(text: string): string | null {
  return firstSqlFenceSpan(text)?.inner ?? null;
}

/** Remove the first SQL markdown fence so we do not show the same SQL twice (body + SyntaxHighlighter). */
export function stripFirstSqlCodeBlock(text: string): string {
  const span = firstSqlFenceSpan(text);
  if (!span) return text;
  return (text.slice(0, span.start) + text.slice(span.end))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
