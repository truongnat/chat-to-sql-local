import { listen } from "@tauri-apps/api/event";
import { message, open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { SchemaTree } from "./components/SchemaTree";
import type { Dialect, LoadedTable, Workspace, WorkspaceSchemaStats } from "./lib/api";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspaceSchemaStats,
  listWorkspaces,
  loadParsedSchema,
  rescanWorkspace,
  saveParsedSchema,
  updateWorkspaceDialect,
} from "./lib/api";
import { buildSchemaFromFiles } from "./lib/parseSchema";

const DIALECTS: Dialect[] = [
  "postgresql",
  "mysql",
  "sqlite",
  "transactsql",
  "bigquery",
];

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [tables, setTables] = useState<LoadedTable[]>([]);
  const [schemaStats, setSchemaStats] = useState<WorkspaceSchemaStats | null>(
    null,
  );
  const [wsName, setWsName] = useState("My workspace");
  const [scanning, setScanning] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const active = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );

  const dialect = (active?.dialect ?? "postgresql") as Dialect;

  const refreshWorkspaces = useCallback(async () => {
    const list = await listWorkspaces();
    setWorkspaces(list);
    setActiveId((prev) => {
      if (prev != null && list.some((w) => w.id === prev)) return prev;
      return list[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  const loadStats = useCallback(async (wsId: number) => {
    try {
      setSchemaStats(await getWorkspaceSchemaStats(wsId));
    } catch {
      setSchemaStats(null);
    }
  }, []);

  const loadTables = useCallback(
    async (wsId: number) => {
      const t = await loadParsedSchema(wsId);
      setTables(t);
      await loadStats(wsId);
    },
    [loadStats],
  );

  const runRescan = useCallback(
    async (wsId: number, d?: Dialect) => {
      setScanning(true);
      try {
        const files = await rescanWorkspace(wsId);
        const list = await listWorkspaces();
        const w = list.find((x) => x.id === wsId);
        const dialectUse = d ?? ((w?.dialect ?? "postgresql") as Dialect);
        const schema = buildSchemaFromFiles(files, dialectUse);
        await saveParsedSchema(wsId, schema);
        await loadParsedSchema(wsId).then(setTables);
        await loadStats(wsId);
      } finally {
        setScanning(false);
      }
    },
    [loadStats],
  );

  useEffect(() => {
    if (activeId != null) void loadTables(activeId);
  }, [activeId, loadTables]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ workspaceId: number }>(
      "workspace-files-changed",
      (ev) => {
        const id = ev.payload.workspaceId;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          if (id === activeId) void runRescan(id);
        }, 450);
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [activeId, runRescan]);

  function normalizeDialogPath(
    raw: string | string[] | null | undefined,
  ): string | null {
    if (raw == null) return null;
    if (typeof raw === "string") return raw.trim() || null;
    if (Array.isArray(raw) && raw.length > 0) {
      const first = raw[0];
      return typeof first === "string" && first.trim() ? first.trim() : null;
    }
    return null;
  }

  async function pickFolderAndCreate() {
    try {
      const raw = await open({
        directory: true,
        multiple: false,
        title: "Choose SQL / DDL folder",
      });
      const selected = normalizeDialogPath(raw);
      if (!selected) return;

      const nm = wsName.trim() || "Workspace";
      const ws = await createWorkspace(nm, selected);
      await refreshWorkspaces();
      setActiveId(ws.id);

      try {
        await runRescan(ws.id, ws.dialect as Dialect);
      } catch (scanErr) {
        await message(
          `Workspace was created, but the first file scan failed:\n\n${String(scanErr)}`,
          { title: "Scan failed", kind: "warning" },
        );
      }
    } catch (e) {
      await message(String(e), {
        title: "Could not create workspace",
        kind: "error",
      });
    }
  }

  async function onDialectChange(next: Dialect) {
    if (!active) return;
    await updateWorkspaceDialect(active.id, next);
    await refreshWorkspaces();
    await runRescan(active.id, next);
  }

  async function removeWorkspace() {
    if (!active) return;
    await deleteWorkspace(active.id);
    setTables([]);
    await refreshWorkspaces();
  }

  if (!workspaces.length) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-6 px-6">
        <div className="max-w-lg text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Chat-to-SQL
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Offline-friendly schema chat: pick a folder of{" "}
            <code className="text-cyan-400">.sql</code> /{" "}
            <code className="text-cyan-400">.ddl</code> files, parse{" "}
            <code className="text-cyan-400">CREATE TABLE</code>, then ask a
            local Ollama model for queries. Your DDL stays on disk; only you
            choose what gets sent to the model.
          </p>
        </div>
        <div className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/80 p-6">
          <label className="text-xs font-medium text-slate-500">
            Workspace name
          </label>
          <input
            className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            value={wsName}
            onChange={(e) => setWsName(e.target.value)}
            placeholder="e.g. Acme warehouse"
          />
          <button
            type="button"
            className="rounded-lg bg-cyan-600 py-2.5 text-sm font-medium text-white hover:bg-cyan-500"
            onClick={() => void pickFolderAndCreate()}
          >
            Choose folder…
          </button>
          <p className="text-center text-xs text-slate-500">
            Requires Ollama on <code className="text-slate-400">localhost:11434</code>{" "}
            for chat (Phase 2).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-800 px-3 py-2">
        <span className="font-semibold text-cyan-400">Chat-to-SQL</span>
        <label className="text-xs text-slate-500">Workspace</label>
        <select
          className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
          value={activeId ?? ""}
          onChange={(e) => setActiveId(Number(e.target.value))}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <label className="text-xs text-slate-500">SQL dialect</label>
        <select
          className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
          value={dialect}
          onChange={(e) => void onDialectChange(e.target.value as Dialect)}
        >
          {DIALECTS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={scanning || !active}
          className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600 disabled:opacity-40"
          onClick={() => active && void runRescan(active.id, dialect)}
        >
          {scanning ? "Scanning…" : "Rescan files"}
        </button>
        <button
          type="button"
          className="ml-auto rounded border border-red-900/60 px-2 py-1 text-xs text-red-300 hover:bg-red-950/40"
          onClick={() => void removeWorkspace()}
        >
          Remove workspace
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-900/30">
          <div className="border-b border-slate-800 px-2 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Schema
            </h2>
            {active && (
              <p className="mt-1 truncate text-[11px] text-slate-500" title={active.rootPath}>
                {active.rootPath}
              </p>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <SchemaTree tables={tables} stats={schemaStats} />
          </div>
        </aside>
        {active && (
          <ChatPanel workspace={active} tables={tables} dialect={dialect} />
        )}
      </div>
    </div>
  );
}
