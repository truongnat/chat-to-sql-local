import type { LoadedTable } from "./api";

/** Normalize SQL type / identifier spacing for display. */
export function normalizedTypeSql(sqlType: string): string {
  return sqlType.replace(/\s+/g, " ").trim();
}

/** True for empty DB/parser output or useless legacy `exprToSQL` like `"()"`. */
export function isUnusableTypeDisplay(sqlType: string): boolean {
  const t = normalizedTypeSql(sqlType);
  if (!t) return true;
  if (t === "()" || t === "( )") return true;
  return /^\(\s*\)$/.test(t);
}

/**
 * Type string for UI, or `null` to omit the type line (tree / diagram).
 */
export function columnTypeForDisplay(sqlType: string): string | null {
  if (isUnusableTypeDisplay(sqlType)) return null;
  return normalizedTypeSql(sqlType);
}

export function stripSchemaFromName(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).trim() : name.trim();
}

export function stripSqlQuotes(name: string): string {
  return name.replace(/^["`]+|["`]+$/g, "").trim();
}

/** Case-insensitive key for matching FK referenced names to parsed tables. */
export function tableMatchKey(name: string): string {
  return stripSqlQuotes(stripSchemaFromName(name)).toLowerCase();
}

/** Human label for a referenced table (drop schema prefix for readability). */
export function displayTableName(name: string): string {
  return stripSqlQuotes(stripSchemaFromName(name));
}

/**
 * REFERENCES / FOREIGN KEY line for a column (first FK that includes this column).
 */
export function referenceLineForColumn(
  table: LoadedTable,
  columnName: string,
): string | null {
  const fk = table.foreignKeys.find((f) => f.columns.includes(columnName));
  if (!fk) return null;
  const refT = displayTableName(fk.referencedTable);
  const refC = fk.referencedColumns.join(", ");
  if (fk.columns.length === 1) {
    return `REFERENCES ${refT}(${refC})`;
  }
  return `FK (${fk.columns.join(", ")}) → ${refT}(${refC})`;
}
