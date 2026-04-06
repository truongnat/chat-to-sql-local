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

function dataTypeString(dt: DataType, parser: Parser): string {
  try {
    return parser.exprToSQL(dt).trim();
  } catch {
    return JSON.stringify(dt);
  }
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
      const cd = def as CreateColumnDefinition;
      const colName = columnRefName(cd.column);
      const typeStr = dataTypeString(cd.definition, parser);
      const opt = cd as { nullable?: { value?: string }; null?: string };
      const nullable = !(
        opt.null === "not null" || opt.nullable?.value === "not null"
      );
      columns.push({
        name: colName,
        type: typeStr,
        nullable,
        isPk: false,
      });
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
        const refDef = fk.reference_definition as
          | {
              table?: { table?: string };
              columns?: { column?: string }[];
            }
          | undefined;
        const refTable = refDef?.table?.table ?? "";
        const refCols = (refDef?.columns ?? []).map((r) =>
          columnRefName(r as never),
        );
        if (cols.length && refTable) {
          foreignKeys.push({
            columns: cols,
            referencedTable: refTable,
            referencedColumns: refCols,
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

export function buildSchemaFromFiles(
  files: { relativePath: string; content: string }[],
  dialect: Dialect,
): ParsedSchemaPayload {
  const parser = new Parser();
  const byName = new Map<string, ParsedTable>();
  const schemaObjects: ParsedSchemaObject[] = [];

  for (const f of files) {
    const { tables, objects } = parseFileContent(
      f.content,
      f.relativePath,
      dialect,
      parser,
    );
    for (const t of tables) {
      byName.set(t.name.toLowerCase(), t);
    }
    schemaObjects.push(...objects);
  }

  return { tables: [...byName.values()], schemaObjects };
}
