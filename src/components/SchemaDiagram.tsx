import { cn } from "@/lib/utils";
import type { LoadedTable } from "../lib/api";
import { SchemaErDiagram } from "./SchemaErDiagram";

export function SchemaDiagram({
  tables,
  fullViewport = false,
}: {
  tables: LoadedTable[];
  /** Use full window below header (React Flow + Dagre ERD). */
  fullViewport?: boolean;
}) {
  if (tables.length === 0) {
    return (
      <p className="px-2 text-sm text-slate-500">
        No tables to diagram. Parse your SQL file and rescan.
      </p>
    );
  }

  const fkCount = tables.reduce((n, t) => n + t.foreignKeys.length, 0);

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-2",
        fullViewport && "h-full min-h-0 flex-1 px-4 py-3",
        !fullViewport && "space-y-2",
      )}
    >
      <p
        className={cn(
          "shrink-0 text-slate-500",
          fullViewport ? "px-1 text-xs" : "px-2 text-[11px] leading-relaxed",
        )}
      >
        ER diagram shows full column types and{" "}
        <code className="text-cyan-400">REFERENCES</code> on each FK column.
        Arrows run from the{" "}
        <span className="text-cyan-400">referenced</span> table to the{" "}
        <span className="text-cyan-400">child</span> (where the FK lives). Declare
        links with column <code className="text-cyan-400">REFERENCES</code> or{" "}
        <code className="text-cyan-400">CONSTRAINT … FOREIGN KEY</code>, then
        rescan.
        {fkCount === 0 ? (
          <>
            {" "}
            <span className="text-amber-200/90">
              No foreign keys parsed yet — add REFERENCES / FOREIGN KEY in SQL
              and rescan.
            </span>
          </>
        ) : null}
      </p>
      <SchemaErDiagram
        tables={tables}
        className={cn(fullViewport && "min-h-0 flex-1")}
      />
    </div>
  );
}
