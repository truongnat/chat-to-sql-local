import { useState } from "react";
import type { LoadedTable, WorkspaceSchemaStats } from "../lib/api";
import {
  columnTypeForDisplay,
  referenceLineForColumn,
} from "../lib/schemaDisplay";

export function SchemaTree({
  tables,
  stats,
}: {
  tables: LoadedTable[];
  stats: WorkspaceSchemaStats | null;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  return (
    <div className="space-y-2">
      {stats && (
        <p className="px-2 text-[11px] leading-relaxed text-slate-500">
          <span className="text-slate-400">{stats.sqlFileCount}</span> SQL file
          {stats.sqlFileCount === 1 ? "" : "s"} ·{" "}
          <span className="text-cyan-400/90">{stats.tableCount}</span> tables ·{" "}
          <span className="text-slate-400">{stats.standaloneIndexCount}</span>{" "}
          indexes · <span className="text-slate-400">{stats.functionCount}</span>{" "}
          functions · <span className="text-slate-400">{stats.viewCount}</span>{" "}
          views
          <span className="block pt-0.5 text-slate-600">
            Use the Diagram tab for an ER view of foreign keys.
          </span>
        </p>
      )}
      {!tables.length ? (
        <p className="text-sm text-slate-500 px-2">
          No tables parsed yet. Put <code className="text-cyan-400">CREATE TABLE</code>{" "}
          in your workspace <code className="text-cyan-400">.sql</code> /{" "}
          <code className="text-cyan-400">.ddl</code> file, then Rescan.
        </p>
      ) : (
    <ul className="space-y-0.5 text-sm">
      {tables.map((t) => {
        const isOpen = open[t.name] ?? true;
        return (
          <li key={t.name}>
            <button
              type="button"
              className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-slate-200 hover:bg-slate-800/80"
              onClick={() =>
                setOpen((o) => ({ ...o, [t.name]: !isOpen }))
              }
            >
              <span className="text-slate-500">{isOpen ? "▼" : "▶"}</span>
              <span className="font-medium text-cyan-300">{t.name}</span>
              <span className="truncate text-xs text-slate-500">
                {t.filePath}
              </span>
            </button>
            {isOpen && (
              <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-slate-700 pl-2">
                {t.columns.map((c) => {
                  const refLine = referenceLineForColumn(t, c.name);
                  const typeShown = columnTypeForDisplay(c.type);
                  return (
                    <li
                      key={`${t.name}.${c.name}`}
                      className="space-y-0.5 border-b border-slate-800/50 py-1.5 font-mono text-xs text-slate-400 last:border-b-0"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="font-medium text-slate-200">
                          {c.name}
                        </span>
                        {typeShown ? (
                          <span className="min-w-0 break-all text-amber-200/90">
                            {typeShown}
                          </span>
                        ) : null}
                        {c.isPk && (
                          <span className="text-[10px] uppercase text-violet-400">
                            pk
                          </span>
                        )}
                        {!c.nullable && (
                          <span className="text-[10px] text-slate-500">
                            not null
                          </span>
                        )}
                      </div>
                      {refLine ? (
                        <div className="break-words pl-0 text-[10px] leading-snug text-violet-300/90">
                          {refLine}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
      )}
    </div>
  );
}
