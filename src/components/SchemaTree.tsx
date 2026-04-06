import { useState } from "react";
import type { LoadedTable, WorkspaceSchemaStats } from "../lib/api";

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
          <span className="text-slate-400">{stats.sqlFileCount}</span> file
          {stats.sqlFileCount === 1 ? "" : "s"} scanned (recursive) ·{" "}
          <span className="text-cyan-400/90">{stats.tableCount}</span> tables ·{" "}
          <span className="text-slate-400">{stats.standaloneIndexCount}</span>{" "}
          indexes · <span className="text-slate-400">{stats.functionCount}</span>{" "}
          functions · <span className="text-slate-400">{stats.viewCount}</span>{" "}
          views
          <span className="block pt-0.5 text-slate-600">
            Tree shows tables only; indexes/functions/views are kept for the
            diagram.
          </span>
        </p>
      )}
      {!tables.length ? (
        <p className="text-sm text-slate-500 px-2">
          No tables parsed yet. Add <code className="text-cyan-400">.sql</code>{" "}
          / <code className="text-cyan-400">.ddl</code> anywhere under the
          folder (subfolders included) with{" "}
          <code className="text-cyan-400">CREATE TABLE</code>, then Rescan.
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
                {t.columns.map((c) => (
                  <li
                    key={`${t.name}.${c.name}`}
                    className="font-mono text-xs text-slate-400"
                  >
                    <span className="text-slate-200">{c.name}</span>{" "}
                    <span className="text-amber-200/90">{c.type}</span>
                    {c.isPk && (
                      <span className="ml-1 text-[10px] uppercase text-violet-400">
                        pk
                      </span>
                    )}
                    {!c.nullable && (
                      <span className="ml-1 text-[10px] text-slate-500">
                        not null
                      </span>
                    )}
                  </li>
                ))}
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
