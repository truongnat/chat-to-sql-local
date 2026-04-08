import { listen } from "@tauri-apps/api/event";
import { message, open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Database,
  FileCode2,
  FolderPlus,
  MessageSquare,
  Pencil,
  RefreshCw,
  Trash2,
  ShieldCheck,
  X,
} from "lucide-react";
import { ChatPanel } from "./components/ChatPanel";
import { SchemaDiagram } from "./components/SchemaDiagram";
import { SchemaTree } from "./components/SchemaTree";
import { AuditLogModal } from "./components/AuditLogModal";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { Dialect, LoadedTable, Workspace, WorkspaceSchemaStats } from "./lib/api";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspaceSchemaStats,
  listWorkspaces,
  loadParsedSchema,
  rebuildSchemaVectorIndex,
  rescanWorkspace,
  saveParsedSchema,
  updateWorkspace,
  updateWorkspaceDialect,
} from "./lib/api";
import { buildSchemaFromFilesAsync } from "./lib/parseSchema";

type SchemaIndexProgressPayload = {
  workspaceId: number;
  phase: string;
  current: number;
  total: number;
  message?: string | null;
};

type SchemaIndexErrorPayload = {
  workspaceId: number;
  message: string;
};

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
  const [scanning, setScanning] = useState(false);
  const [workspaceModal, setWorkspaceModal] = useState<
    null | { mode: "create" } | { mode: "edit" }
  >(null);
  const [modalWorkspaceName, setModalWorkspaceName] = useState("");
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [schemaPanelTab, setSchemaPanelTab] = useState<"tree" | "diagram">(
    "tree",
  );
  const [vectorIndex, setVectorIndex] = useState<SchemaIndexProgressPayload | null>(
    null,
  );
  const [auditModalOpen, setAuditModalOpen] = useState(false);
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

  useEffect(() => {
    if (!schemaOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSchemaOpen(false);
        setSchemaPanelTab("tree");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [schemaOpen]);

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
        const schema = await buildSchemaFromFilesAsync(files, dialectUse);
        await saveParsedSchema(wsId, schema);
        await loadParsedSchema(wsId).then(setTables);
        await loadStats(wsId);
        void rebuildSchemaVectorIndex(wsId).catch(() => {});
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
    let unProgress: (() => void) | undefined;
    let unErr: (() => void) | undefined;
    void listen<SchemaIndexProgressPayload>("schema-index-progress", (ev) => {
      setVectorIndex(ev.payload);
      if (ev.payload.phase === "done") {
        window.setTimeout(() => {
          setVectorIndex((prev) =>
            prev?.workspaceId === ev.payload.workspaceId &&
            prev?.phase === "done"
              ? null
              : prev,
          );
        }, 5000);
      }
    }).then((fn) => {
      unProgress = fn;
    });
    void listen<SchemaIndexErrorPayload>("schema-index-error", (ev) => {
      setVectorIndex({
        workspaceId: ev.payload.workspaceId,
        phase: "error",
        current: 0,
        total: 0,
        message: ev.payload.message,
      });
    }).then((fn) => {
      unErr = fn;
    });
    return () => {
      unProgress?.();
      unErr?.();
    };
  }, []);

  useEffect(() => {
    if (activeId == null) return;
    const t = window.setTimeout(() => {
      void rebuildSchemaVectorIndex(activeId).catch(() => {});
    }, 1200);
    return () => window.clearTimeout(t);
  }, [activeId]);

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

  function openCreateWorkspaceModal() {
    setModalWorkspaceName("My workspace");
    setWorkspaceModal({ mode: "create" });
  }

  function openEditWorkspaceModal() {
    if (!active) return;
    setModalWorkspaceName(active.name);
    setWorkspaceModal({ mode: "edit" });
  }

  function closeWorkspaceModal() {
    setWorkspaceModal(null);
  }

  const sqlFileDialogFilters = [
    { name: "SQL", extensions: ["sql", "ddl"] as string[] },
  ];

  async function pickSqlFileAndCreateFromModal() {
    if (workspaceModal?.mode !== "create") return;
    try {
      const raw = await open({
        directory: false,
        multiple: false,
        filters: sqlFileDialogFilters,
        title: "Choose SQL or DDL file",
      });
      const selected = normalizeDialogPath(raw);
      if (!selected) return;

      const nm = modalWorkspaceName.trim() || "Workspace";
      const ws = await createWorkspace(nm, selected);
      closeWorkspaceModal();
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

  async function pickSqlFolderAndCreateFromModal() {
    if (workspaceModal?.mode !== "create") return;
    try {
      const raw = await open({
        directory: true,
        multiple: false,
        title: "Choose folder containing .sql / .ddl (e.g. migrations)",
      });
      const selected = normalizeDialogPath(raw);
      if (!selected) return;

      const nm = modalWorkspaceName.trim() || "Workspace";
      const ws = await createWorkspace(nm, selected);
      closeWorkspaceModal();
      await refreshWorkspaces();
      setActiveId(ws.id);

      try {
        await runRescan(ws.id, ws.dialect as Dialect);
      } catch (scanErr) {
        await message(
          `Workspace was created, but the folder scan failed:\n\n${String(scanErr)}`,
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

  async function saveEditedWorkspaceName() {
    if (workspaceModal?.mode !== "edit" || !active) return;
    const nm = modalWorkspaceName.trim();
    if (!nm) {
      await message("Please enter a workspace name.", {
        title: "Name required",
        kind: "warning",
      });
      return;
    }
    try {
      await updateWorkspace(active.id, { name: nm });
      closeWorkspaceModal();
      await refreshWorkspaces();
    } catch (e) {
      await message(String(e), {
        title: "Could not update workspace",
        kind: "error",
      });
    }
  }

  async function pickSqlFileAndUpdateWorkspace() {
    if (workspaceModal?.mode !== "edit" || !active) return;
    try {
      const raw = await open({
        directory: false,
        multiple: false,
        filters: sqlFileDialogFilters,
        title: "Choose new SQL or DDL file",
      });
      const selected = normalizeDialogPath(raw);
      if (!selected) return;

      const nm = modalWorkspaceName.trim();
      await updateWorkspace(active.id, {
        rootPath: selected,
        ...(nm ? { name: nm } : {}),
      });
      closeWorkspaceModal();
      await refreshWorkspaces();
      try {
        await runRescan(active.id, dialect);
      } catch (scanErr) {
        await message(
          `SQL root was updated, but rescan failed:\n\n${String(scanErr)}`,
          { title: "Scan failed", kind: "warning" },
        );
      }
    } catch (e) {
      await message(String(e), {
        title: "Could not update SQL file",
        kind: "error",
      });
    }
  }

  async function pickSqlFolderAndUpdateWorkspace() {
    if (workspaceModal?.mode !== "edit" || !active) return;
    try {
      const raw = await open({
        directory: true,
        multiple: false,
        title: "Choose folder with .sql / .ddl files",
      });
      const selected = normalizeDialogPath(raw);
      if (!selected) return;

      const nm = modalWorkspaceName.trim();
      await updateWorkspace(active.id, {
        rootPath: selected,
        ...(nm ? { name: nm } : {}),
      });
      closeWorkspaceModal();
      await refreshWorkspaces();
      try {
        await runRescan(active.id, dialect);
      } catch (scanErr) {
        await message(
          `SQL root was updated, but rescan failed:\n\n${String(scanErr)}`,
          { title: "Scan failed", kind: "warning" },
        );
      }
    } catch (e) {
      await message(String(e), {
        title: "Could not update SQL folder",
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

  const workspaceModalOverlay =
    workspaceModal != null ? (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
        role="presentation"
        onClick={() => closeWorkspaceModal()}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ws-modal-title"
          className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <h2
            id="ws-modal-title"
            className="font-heading text-lg font-semibold text-foreground"
          >
            {workspaceModal.mode === "create"
              ? "New workspace"
              : "Edit workspace"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {workspaceModal.mode === "create"
              ? "Choose one .sql/.ddl file (e.g. DBeaver export), or a folder (e.g. db/migrations). Folders are scanned for all .sql/.ddl files, ordered by path."
              : "Rename the workspace or point to a different SQL file or folder."}
          </p>
          <div className="mt-4 space-y-2">
            <label
              htmlFor="modal-ws-name"
              className="text-xs font-medium text-muted-foreground"
            >
              Workspace name
            </label>
            <Input
              id="modal-ws-name"
              value={modalWorkspaceName}
              onChange={(e) => setModalWorkspaceName(e.target.value)}
              placeholder="e.g. Acme warehouse"
              autoFocus
            />
          </div>
          {workspaceModal.mode === "edit" && active ? (
            <p
              className="mt-3 break-all text-[11px] leading-snug text-muted-foreground"
              title={active.rootPath}
            >
              SQL root (file or folder):{" "}
              <span className="font-mono text-foreground/80">
                {active.rootPath}
              </span>
            </p>
          ) : null}
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => closeWorkspaceModal()}
            >
              Cancel
            </Button>
            {workspaceModal.mode === "create" ? (
              <>
                <Button
                  type="button"
                  onClick={() => void pickSqlFileAndCreateFromModal()}
                >
                  <FileCode2 className="size-4" />
                  Choose SQL file…
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void pickSqlFolderAndCreateFromModal()}
                >
                  <FolderPlus className="size-4" />
                  Choose SQL folder…
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void pickSqlFileAndUpdateWorkspace()}
                >
                  <FileCode2 className="size-4" />
                  Change SQL file…
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void pickSqlFolderAndUpdateWorkspace()}
                >
                  <FolderPlus className="size-4" />
                  Change SQL folder…
                </Button>
                <Button
                  type="button"
                  onClick={() => void saveEditedWorkspaceName()}
                >
                  Save name
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    ) : null;

  if (!workspaces.length) {
    return (
      <>
        <div className="flex min-h-full flex-col items-center justify-center gap-8 px-6 py-12">
          <div className="w-full max-w-md text-center">
            <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
              Chat-to-SQL
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Offline-friendly schema chat: point a workspace at one{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                .sql
              </code>{" "}
              /{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                .ddl
              </code>{" "}
              file or a folder of migration scripts. We parse{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                CREATE TABLE
              </code>{" "}
              (and merge files in path order), then you can ask a local Ollama model for queries.
            </p>
          </div>
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Get started</CardTitle>
              <CardDescription>
                Requires Ollama on{" "}
                <span className="font-mono text-foreground/80">
                  localhost:11434
                </span>{" "}
                for chat.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                type="button"
                className="w-full"
                onClick={() => openCreateWorkspaceModal()}
              >
                <FolderPlus className="size-4" />
                Create workspace…
              </Button>
            </CardContent>
          </Card>
        </div>
        {workspaceModalOverlay}
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center gap-2 px-1">
            <MessageSquare className="size-5 text-sidebar-primary" />
            <span className="font-heading text-sm font-semibold tracking-tight">
              Chat-to-SQL
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start gap-2 border-sidebar-border bg-sidebar-accent/30 hover:bg-sidebar-accent/50"
            onClick={() => openCreateWorkspaceModal()}
          >
            <FolderPlus className="size-4" />
            New workspace
          </Button>
        </div>
        <Separator className="bg-sidebar-border" />
        <div className="px-3 pt-2 pb-1">
          <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Workspaces
          </p>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2">
          <nav className="flex flex-col gap-0.5 pb-3">
            {workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setActiveId(w.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                  activeId === w.id
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/90 hover:bg-sidebar-accent/40",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {w.name}
                </span>
              </button>
            ))}
          </nav>
        </ScrollArea>
        <Separator className="bg-sidebar-border" />
        <div className="space-y-3 p-3">
          <div className="space-y-1.5">
            <p className="px-0.5 text-[11px] font-medium text-muted-foreground">
              SQL dialect
            </p>
            <Select
              value={dialect}
              onValueChange={(v) => void onDialectChange(v as Dialect)}
              disabled={!active}
            >
              <SelectTrigger className="h-9 w-full bg-sidebar-accent/20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIALECTS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-sidebar-foreground/80"
              title="Edit workspace"
              disabled={!active}
              onClick={() => openEditWorkspaceModal()}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-sidebar-foreground/80"
              title="Rescan files"
              disabled={scanning || !active}
              onClick={() => active && void runRescan(active.id, dialect)}
            >
              <RefreshCw className={cn("size-4", scanning && "animate-spin")} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-sidebar-foreground/80"
              title="Schema"
              disabled={!active}
              onClick={() => setSchemaOpen(true)}
            >
              <Database className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-sidebar-foreground/80"
              title="Security Logs"
              onClick={() => setAuditModalOpen(true)}
            >
              <ShieldCheck className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-destructive hover:bg-destructive/15 hover:text-destructive"
              title="Remove workspace"
              disabled={!active}
              onClick={() => void removeWorkspace()}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          {active && (
            <p
              className="line-clamp-2 break-all text-[10px] leading-snug text-muted-foreground"
              title={active.rootPath}
            >
              {active.rootPath}
            </p>
          )}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {active && vectorIndex && vectorIndex.workspaceId === active.id && (
            <div
              className={`shrink-0 border-b px-3 py-1.5 text-xs ${
                vectorIndex.phase === "error"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : vectorIndex.phase === "done"
                    ? "border-border bg-muted/60 text-muted-foreground"
                    : "border-border bg-muted/50 text-muted-foreground"
              }`}
            >
              {vectorIndex.phase === "error"
                ? `Vector index: ${vectorIndex.message ?? "error"}`
                : (vectorIndex.message ??
                  `Indexing schema… ${vectorIndex.current}/${vectorIndex.total}`)}
            </div>
          )}
        {active && (
          <ChatPanel workspace={active} tables={tables} dialect={dialect} />
        )}
      </div>

      {schemaOpen && (
        <div
          className="fixed inset-0 z-[300] flex flex-col bg-background"
          role="dialog"
          aria-modal="true"
          aria-labelledby="schema-panel-title"
        >
          <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2
                id="schema-panel-title"
                className="font-heading text-lg font-semibold tracking-tight text-foreground"
              >
                Schema
              </h2>
              <p className="text-sm text-muted-foreground">
                Parsed tables and foreign keys from your SQL root (single file or merged folder).
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={schemaPanelTab === "tree" ? "secondary" : "ghost"}
                size="sm"
                className="h-9"
                onClick={() => setSchemaPanelTab("tree")}
              >
                Tables
              </Button>
              <Button
                type="button"
                variant={schemaPanelTab === "diagram" ? "secondary" : "ghost"}
                size="sm"
                className="h-9"
                onClick={() => setSchemaPanelTab("diagram")}
              >
                Diagram
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="shrink-0"
                aria-label="Close schema"
                onClick={() => {
                  setSchemaOpen(false);
                  setSchemaPanelTab("tree");
                }}
              >
                <X className="size-4" />
              </Button>
            </div>
          </header>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {schemaPanelTab === "tree" ? (
              <ScrollArea className="h-full min-h-0 flex-1 px-4 py-4">
                <SchemaTree tables={tables} stats={schemaStats} />
              </ScrollArea>
            ) : (
              <SchemaDiagram tables={tables} fullViewport />
            )}
          </div>
        </div>
      )}

      {workspaceModalOverlay}

      <AuditLogModal
        open={auditModalOpen}
        onOpenChange={setAuditModalOpen}
      />
    </div>
  );
}
