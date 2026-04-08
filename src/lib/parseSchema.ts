import { Parser } from "node-sql-parser";
import type {
  AST,
  Create,
  CreateColumnDefinition,
  CreateConstraintForeign,
  CreateDefinition,
  CreateIndexDefinition,
  DataType,
  TableColumnAst,
} from "node-sql-parser";
import type {
  Dialect,
  ParsedSchemaObject,
  ParsedSchemaPayload,
  ParsedTable,
} from "./api";

const DB_MAP: Record<Dialect, string> = {
  postgresql: "Postgresql",
  mysql: "MySQL",
  sqlite: "Sqlite",
  transactsql: "TransactSQL",
  bigquery: "BigQuery",
};

function astArray(ast: TableColumnAst): AST[] {
  const a = ast.ast;
  return Array.isArray(a) ? a : [a];
}

function truncateSql(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** Split file into statements when a single parse fails (e.g. multiple CREATE …;). */
function splitSqlStatements(sql: string): string[] {
  const t = sql.trim();
  if (!t) return [];
  const parts = t.split(/;\s*(?=(?:\/\*|--|\s*(?:CREATE|ALTER|DROP|WITH)\b))/gi);
  const out = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.endsWith(";") ? p.slice(0, -1).trim() : p))
    .filter(Boolean);
  return out.length ? out : [t];
}

function tableNameFromCreate(c: Create): string | null {
  const tbl = c.table;
  if (!tbl) return null;
  if (Array.isArray(tbl)) {
    const first = tbl[0];
    return first?.table ?? null;
  }
  return tbl.table;
}

function indexNameFromCreate(c: Create): string {
  const ix = c.index;
  if (typeof ix === "string") return ix;
  if (ix && typeof ix === "object" && "name" in ix) {
    return String((ix as { name: string }).name);
  }
  return "";
}

function columnRefName(col: unknown): string {
  if (!col || typeof col !== "object") return "?";
  const o = col as Record<string, unknown>;
  const c = o.column;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && "expr" in c) {
    const e = (c as { expr?: { value?: string; column?: string } }).expr;
    if (e && typeof e === "object") {
      if ("value" in e && typeof e.value === "string") return e.value;
      if ("column" in e && typeof e.column === "string") return e.column;
    }
  }
  if (o.type === "expr" && o.expr && typeof o.expr === "object") {
    return columnRefName(o.expr);
  }
  return "?";
}

/** True when exprToSQL produced nothing useful (common for PG/MySQL `dataType` AST). */
function isUnusableTypeSql(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (t === "()" || t === "( )") return true;
  return /^\(\s*\)$/.test(t);
}

/**
 * Build type text from node-sql-parser column `definition` when it uses `{ dataType, length, suffix, … }`
 * (PostgreSQL, MySQL) — `exprToSQL` often returns "" or "()".
 */
function dataTypeFromDataTypeAst(def: Record<string, unknown>): string {
  const raw = def.dataType;
  if (typeof raw !== "string") return "";

  const suffixRaw = def.suffix;
  const suffixParts = Array.isArray(suffixRaw)
    ? suffixRaw.map(String).filter(Boolean)
    : [];

  let out = raw.trim();
  if (suffixParts.length) out = `${out} ${suffixParts.join(" ")}`;

  if (def.parentheses) {
    const len = def.length;
    const scale = def.scale;
    if (len !== undefined && len !== null) {
      out +=
        scale !== undefined && scale !== null
          ? `(${len}, ${scale})`
          : `(${len})`;
    }
  }

  const arr = def.array as { dimension?: number } | undefined;
  if (arr && typeof arr.dimension === "number" && arr.dimension > 0) {
    if (!out.includes("[]")) {
      out += "[]".repeat(arr.dimension);
    }
  }

  return out.replace(/\s+/g, " ").trim();
}

function dataTypeString(dt: DataType, parser: Parser): string {
  try {
    const fromParser = parser.exprToSQL(dt).trim();
    if (!isUnusableTypeSql(fromParser)) return fromParser;
  } catch {
    // fall through
  }
  if (dt && typeof dt === "object") {
    const manual = dataTypeFromDataTypeAst(dt as Record<string, unknown>);
    if (manual) return manual;
  }
  try {
    return JSON.stringify(dt);
  } catch {
    return "";
  }
}

/**
 * REFERENCES target from a column definition or from CONSTRAINT FOREIGN KEY.
 * Parser shape: `table: [{ db, table }]` and `definition` = referenced column list.
 */
function referenceTargetFromDefinition(ref: unknown): {
  table: string;
  columns: string[];
} | null {
  if (!ref || typeof ref !== "object") return null;
  const r = ref as Record<string, unknown>;
  const tableRaw = r.table;
  let refTable = "";
  if (Array.isArray(tableRaw) && tableRaw.length > 0) {
    const first = tableRaw[0] as { table?: string } | undefined;
    refTable = String(first?.table ?? "");
  } else if (
    tableRaw &&
    typeof tableRaw === "object" &&
    !Array.isArray(tableRaw) &&
    "table" in (tableRaw as object)
  ) {
    refTable = String((tableRaw as { table?: string }).table ?? "");
  }
  const def = r.definition;
  const refCols: string[] = Array.isArray(def)
    ? def.map((x) => columnRefName(x))
    : [];
  if (!refTable) return null;
  const cols = refCols.filter((c) => c && c !== "?");
  return { table: refTable, columns: cols };
}

/** Strip SQL quotes / backticks from identifiers (FK target names). */
function cleanIdent(name: string): string {
  return name.replace(/^["`]+|["`]+$/g, "").trim();
}

function tableFromCreate(
  create: Create,
  filePath: string,
  parser: Parser,
): ParsedTable | null {
  const name = tableNameFromCreate(create);
  if (!name) return null;

  const primaryKeyCols = new Set<string>();
  const defs = create.create_definitions ?? [];
  const columns: ParsedTable["columns"] = [];
  const foreignKeys: ParsedTable["foreignKeys"] = [];
  const indexes: ParsedTable["indexes"] = [];

  for (const def of defs as CreateDefinition[]) {
    if (def.resource === "column") {
      const cd = def as CreateColumnDefinition & {
        primary_key?: string;
        reference_definition?: unknown;
      };
      const colName = columnRefName(cd.column);
      const typeStr = dataTypeString(cd.definition, parser);
      const opt = cd as { nullable?: { value?: string }; null?: string };
      const nullable = !(
        opt.null === "not null" || opt.nullable?.value === "not null"
      );
      const inlinePk =
        cd.primary_key === "primary key" || cd.primary_key === "key";
      if (inlinePk && colName && colName !== "?") {
        primaryKeyCols.add(colName);
      }
      columns.push({
        name: colName,
        type: typeStr,
        nullable,
        isPk: false,
      });

      let colRef: unknown = cd.reference_definition;
      if (
        colRef &&
        typeof colRef === "object" &&
        "reference_definition" in colRef
      ) {
        colRef = (colRef as { reference_definition: unknown })
          .reference_definition as unknown;
      }
      const refTarget = referenceTargetFromDefinition(colRef);
      if (refTarget && colName && colName !== "?") {
        const refCols =
          refTarget.columns.length > 0 ? refTarget.columns : ["id"];
        foreignKeys.push({
          columns: [colName],
          referencedTable: cleanIdent(refTarget.table),
          referencedColumns: refCols.map(cleanIdent),
        });
      }
    } else if (def.resource === "constraint") {
      const ct = (def as { constraint_type?: string }).constraint_type;
      if (ct === "primary key") {
        const d = (def as { definition?: { column?: string }[] }).definition;
        if (d)
          for (const ref of d) {
            primaryKeyCols.add(columnRefName(ref as never));
          }
      } else if (ct === "FOREIGN KEY") {
        const fk = def as CreateConstraintForeign;
        const cols = (fk.definition ?? []).map((r) => columnRefName(r));
        const refTarget = referenceTargetFromDefinition(fk.reference_definition);
        if (cols.length && refTarget?.table) {
          const refCols =
            refTarget.columns.length > 0 ? refTarget.columns : ["id"];
          foreignKeys.push({
            columns: cols.map(cleanIdent),
            referencedTable: cleanIdent(refTarget.table),
            referencedColumns: refCols.map(cleanIdent),
          });
        }
      }
    } else if (def.resource === "index") {
      const ix = def as CreateIndexDefinition;
      const ixName = ix.index ?? "";
      const parts = (ix.definition ?? []).map((r) => columnRefName(r));
      if (parts.length) {
        indexes.push({ name: ixName || "index", columns: parts });
      }
    }
  }

  for (const col of columns) {
    if (primaryKeyCols.has(col.name)) col.isPk = true;
  }

  return {
    name,
    filePath,
    columns,
    foreignKeys,
    indexes,
  };
}

function tryParseAst(
  sql: string,
  dialect: Dialect,
  parser: Parser,
): AST[] | null {
  const db = DB_MAP[dialect] ?? "Postgresql";
  try {
    const ast = parser.parse(sql, { database: db });
    return astArray(ast);
  } catch {
    return null;
  }
}

function previewCreate(
  node: Create,
  dialect: Dialect,
  parser: Parser,
): string {
  const db = DB_MAP[dialect] ?? "Postgresql";
  try {
    return truncateSql(parser.sqlify(node, { database: db }), 2000);
  } catch {
    return "";
  }
}

function processCreateNode(
  node: Create,
  filePath: string,
  dialect: Dialect,
  parser: Parser,
): { table?: ParsedTable; objects: ParsedSchemaObject[] } {
  const objects: ParsedSchemaObject[] = [];
  const kw = node.keyword;

  if (kw === "table") {
    const t = tableFromCreate(node, filePath, parser);
    return { table: t ?? undefined, objects };
  }

  if (kw === "index") {
    const name = indexNameFromCreate(node) || "index";
    const targetTable = tableNameFromCreate(node) ?? undefined;
    const cols = (node.index_columns ?? []).map((col) =>
      columnRefName(col as never),
    );
    objects.push({
      kind: "index",
      name,
      filePath,
      targetTable: targetTable ?? null,
      columns: cols,
      previewSql: previewCreate(node, dialect, parser),
    });
    return { objects };
  }

  if (kw === "function") {
    let name = "function";
    const prev = previewCreate(node, dialect, parser);
    const m = prev.match(/FUNCTION\s+([a-zA-Z0-9_."]+)/i);
    if (m) name = m[1].replace(/"/g, "");
    objects.push({
      kind: "function",
      name,
      filePath,
      targetTable: null,
      columns: [],
      previewSql: prev,
    });
    return { objects };
  }

  if (kw === "view") {
    const name = tableNameFromCreate(node) || "view";
    objects.push({
      kind: "view",
      name,
      filePath,
      targetTable: null,
      columns: [],
      previewSql: previewCreate(node, dialect, parser),
    });
    return { objects };
  }

  return { objects };
}

function processAstNodes(
  nodes: AST[],
  filePath: string,
  dialect: Dialect,
  parser: Parser,
): { tables: ParsedTable[]; objects: ParsedSchemaObject[] } {
  const tables: ParsedTable[] = [];
  const objects: ParsedSchemaObject[] = [];

  for (const node of nodes) {
    if (node.type !== "create") continue;
    const { table, objects: obs } = processCreateNode(
      node as Create,
      filePath,
      dialect,
      parser,
    );
    if (table) tables.push(table);
    objects.push(...obs);
  }

  return { tables, objects };
}

function parseFileContent(
  content: string,
  filePath: string,
  dialect: Dialect,
  parser: Parser,
): { tables: ParsedTable[]; objects: ParsedSchemaObject[] } {
  let nodes = tryParseAst(content, dialect, parser);
  if (nodes && nodes.length > 0) {
    return processAstNodes(nodes, filePath, dialect, parser);
  }

  const tables: ParsedTable[] = [];
  const objects: ParsedSchemaObject[] = [];
  for (const stmt of splitSqlStatements(content)) {
    nodes = tryParseAst(stmt, dialect, parser);
    if (!nodes?.length) continue;
    const chunk = processAstNodes(nodes, filePath, dialect, parser);
    tables.push(...chunk.tables);
    objects.push(...chunk.objects);
  }
  return { tables, objects };
}

function processAlterNode(
  node: any,
  tablesByName: Map<string, ParsedTable>,
  parser: Parser,
): void {
  if (node.type !== "alter" || !node.table) return;
  const tableName = (Array.isArray(node.table) ? node.table[0].table : node.table.table).toLowerCase();
  const table = tablesByName.get(tableName);
  if (!table) return;

  const exprs = Array.isArray(node.expr) ? node.expr : [node.expr];
  for (const expr of exprs) {
    if (expr.action === "add" && expr.resource === "constraint" && expr.create_definitions) {
      for (const def of expr.create_definitions) {
        if (def.constraint_type === "FOREIGN KEY") {
          const cols = (def.definition ?? []).map((r: any) => columnRefName(r));
          const refTarget = referenceTargetFromDefinition(def.reference_definition);
          if (cols.length && refTarget?.table) {
            const refCols = refTarget.columns.length > 0 ? refTarget.columns : ["id"];
            table.foreignKeys.push({
              columns: cols.map(cleanIdent),
              referencedTable: cleanIdent(refTarget.table),
              referencedColumns: refCols.map(cleanIdent),
            });
          }
        }
      }
    }
  }
}

export function buildSchemaFromFiles(
  files: { relativePath: string; content: string }[],
  dialect: Dialect,
): ParsedSchemaPayload {
  const parser = new Parser();
  // Sort files lexicographically by relative path to ensure consistent merge order
  const sortedFiles = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  
  const byName = new Map<string, ParsedTable>();
  const schemaObjects: ParsedSchemaObject[] = [];

  for (const f of sortedFiles) {
    let nodes = tryParseAst(f.content, dialect, parser);
    if (!nodes || nodes.length === 0) {
      const stmts = splitSqlStatements(f.content);
      nodes = [];
      for (const s of stmts) {
        const parsed = tryParseAst(s, dialect, parser);
        if (parsed) nodes.push(...parsed);
      }
    }

    if (!nodes) continue;

    for (const node of nodes) {
      if (node.type === "create") {
        const { table, objects } = processCreateNode(
          node as Create,
          f.relativePath,
          dialect,
          parser,
        );
        if (table) {
          const lowerName = table.name.toLowerCase();
          if (byName.has(lowerName)) {
            console.warn(`[SchemaMerge] Table "${table.name}" from ${f.relativePath} is overwriting previous definition.`);
          }
          byName.set(lowerName, table);
        }
        schemaObjects.push(...objects);
      } else if (node.type === "alter") {
        processAlterNode(node, byName, parser);
      }
    }
  }

  return { tables: [...byName.values()], schemaObjects };
}

export function buildSchemaFromFilesAsync(
  files: { relativePath: string; content: string }[],
  dialect: Dialect,
): Promise<ParsedSchemaPayload> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parseSchema.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e) => {
      if (e.data.type === "success") {
        resolve(e.data.result);
      } else {
        reject(new Error(e.data.error));
      }
      worker.terminate();
    };
    worker.onerror = (err) => {
      reject(err);
      worker.terminate();
    };
    worker.postMessage({ files, dialect });
  });
}
