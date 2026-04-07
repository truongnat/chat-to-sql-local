import { listen } from "@tauri-apps/api/event";
import {
  ChevronDown,
  Download,
  MessageSquarePlus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type {
  ChatMessage,
  ChatSession,
  LoadedTable,
  Workspace,
} from "../lib/api";
import {
  appendChatMessage,
  createChatSession,
  deleteChatSession,
  installOllamaFromDownload,
  listChatMessages,
  listChatSessions,
  ollamaInstallerExists,
  searchSchemaForChat,
  startOllamaInstallerDownload,
  tryStartOllama,
  updateChatSessionTitle,
  updateWorkspaceModel,
} from "../lib/api";
import type { Dialect } from "../lib/api";
import {
  buildSystemPrompt,
  extractSqlBlock,
  formatRetrievalForPrompt,
  selectRelevantTables,
  stripFirstSqlCodeBlock,
} from "../lib/context";
import {
  DEFAULT_SUGGESTED_MODEL,
  OLLAMA_MODEL_SIZE_HINT_BYTES,
  OLLAMA_MODEL_SUGGESTIONS,
} from "../lib/ollamaModelSuggestions";
import type { OllamaModel, OllamaRunningModel } from "../lib/ollama";
import {
  chatStream,
  listModels,
  listOllamaLibraryCatalog,
  listRunningModels,
  ollamaHealth,
  pullModelStream,
  sortLocalModelsForPicker,
} from "../lib/ollama";
import { cn } from "@/lib/utils";

/** `local` = installed on this machine; `catalog` = ollama.com library entry (size / metadata for pull UI). */
type ModelPickerRow = {
  name: string;
  local?: OllamaModel;
  catalog?: OllamaModel;
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Ollama sometimes lags updating `/api/tags` right after pull; also tolerate trivial string differences. */
function localListHasModel(tags: OllamaModel[], pulledName: string): boolean {
  const want = pulledName.trim().toLowerCase();
  if (!want) return false;
  return tags.some((m) => {
    const n = m.name?.trim().toLowerCase() ?? "";
    return n === want;
  });
}

function isPlaceholderChatTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  return t === "new chat" || t === "chat";
}

/** Short line from the first user message — used as the chat session title. */
function deriveChatTitleFromUserMessage(text: string, maxLen = 52): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "New chat";
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1).trimEnd()}…`;
}

export function ChatPanel({
  workspace,
  tables,
  dialect,
}: {
  workspace: Workspace;
  tables: LoadedTable[];
  dialect: Dialect;
}) {
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null);
  const [ollamaTagsError, setOllamaTagsError] = useState<string | null>(null);
  const [libraryCatalogError, setLibraryCatalogError] = useState<string | null>(
    null,
  );
  const [libraryCatalog, setLibraryCatalog] = useState<OllamaModel[]>([]);
  const [localModels, setLocalModels] = useState<OllamaModel[]>([]);
  const [runningModels, setRunningModels] = useState<OllamaRunningModel[]>([]);
  const [model, setModel] = useState(
    () => workspace.ollamaModel?.trim() || DEFAULT_SUGGESTED_MODEL,
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [pullModelInput, setPullModelInput] = useState(DEFAULT_SUGGESTED_MODEL);
  const [pullLog, setPullLog] = useState("");
  const [pullingName, setPullingName] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [ollamaStartBusy, setOllamaStartBusy] = useState(false);
  const [ollamaStartHint, setOllamaStartHint] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [installerOnDisk, setInstallerOnDisk] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    received: number;
    total: number | null;
  } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshOllama = useCallback(async () => {
    const ok = await ollamaHealth();
    setOllamaOk(ok);

    const libPromise = listOllamaLibraryCatalog()
      .then((lib) => {
        setLibraryCatalog(lib);
        setLibraryCatalogError(null);
      })
      .catch((e) => {
        setLibraryCatalogError(String(e));
      });

    if (ok) {
      try {
        const [tags, running] = await Promise.all([
          listModels(),
          listRunningModels(),
        ]);
        setOllamaTagsError(null);
        setLocalModels(tags);
        setRunningModels(running);
        const names = tags.map((m) => m.name).filter(Boolean);
        setModel((prev) => {
          if (prev) return prev;
          if (names.length) return names[0];
          return DEFAULT_SUGGESTED_MODEL;
        });
      } catch (e) {
        setLocalModels([]);
        setRunningModels([]);
        setOllamaTagsError(String(e));
      }
    } else {
      setLocalModels([]);
      setRunningModels([]);
      setOllamaTagsError(null);
    }

    await libPromise;
  }, []);

  useEffect(() => {
    void refreshOllama();
  }, [refreshOllama]);

  const runningNames = useMemo(
    () => new Set(runningModels.map((m) => m.name).filter(Boolean)),
    [runningModels],
  );

  const runningByName = useMemo(() => {
    const m = new Map<string, OllamaRunningModel>();
    for (const x of runningModels) {
      if (x.name) m.set(x.name, x);
    }
    return m;
  }, [runningModels]);

  const mergedPickerRows = useMemo((): ModelPickerRow[] => {
    const catalogByName = new Map<string, OllamaModel>();
    for (const c of libraryCatalog) {
      if (c.name) catalogByName.set(c.name, c);
    }

    const sorted = sortLocalModelsForPicker(localModels, runningNames);
    const seen = new Set<string>();
    const rows: ModelPickerRow[] = [];

    for (const m of sorted) {
      const n = m.name;
      if (!n || seen.has(n)) continue;
      seen.add(n);
      rows.push({
        name: n,
        local: m,
        catalog: catalogByName.get(n),
      });
    }

    for (const lib of libraryCatalog) {
      const n = lib.name;
      if (!n || seen.has(n)) continue;
      seen.add(n);
      rows.push({ name: n, catalog: lib });
    }

    for (const n of OLLAMA_MODEL_SUGGESTIONS) {
      if (!n || seen.has(n)) continue;
      seen.add(n);
      const cat = catalogByName.get(n);
      rows.push(cat ? { name: n, catalog: cat } : { name: n });
    }

    return rows;
  }, [localModels, runningNames, libraryCatalog]);

  const modelPickerRows = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return mergedPickerRows;
    return mergedPickerRows.filter((r) => r.name.toLowerCase().includes(q));
  }, [mergedPickerRows, modelSearch]);

  useEffect(() => {
    if (ollamaOk !== false) return;
    void ollamaInstallerExists().then(setInstallerOnDisk);
  }, [ollamaOk]);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;

    void listen<{ received: number; total?: number | null }>(
      "ollama-download-progress",
      (ev) => {
        const t = ev.payload.total;
        setDownloadProgress({
          received: ev.payload.received,
          total: t === undefined || t === null ? null : t,
        });
      },
    ).then((fn) => {
      unlistenProgress = fn;
    });

    void listen<{ path: string; error?: string }>(
      "ollama-download-done",
      (ev) => {
        setDownloadBusy(false);
        setDownloadProgress(null);
        if (ev.payload.error) {
          setOllamaStartHint(ev.payload.error);
          return;
        }
        setInstallerOnDisk(true);
        void (async () => {
          try {
            const msg = await installOllamaFromDownload();
            setOllamaStartHint(msg.replace(/\*\*/g, ""));
          } catch (err) {
            setOllamaStartHint(String(err));
          }
        })();
      },
    ).then((fn) => {
      unlistenDone = fn;
    });

    return () => {
      unlistenProgress?.();
      unlistenDone?.();
    };
  }, []);

  useEffect(() => {
    const w = workspace.ollamaModel?.trim() ?? "";
    if (w) {
      setModel(w);
      return;
    }
    setModel(DEFAULT_SUGGESTED_MODEL);
  }, [workspace.ollamaModel, workspace.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let list = await listChatSessions(workspace.id);
      if (list.length === 0) {
        const s = await createChatSession(workspace.id, "New chat");
        list = [s];
      }
      if (cancelled) return;
      setSessions(list);
      const sid = list[0].id;
      setSessionId(sid);
      const hist = await listChatMessages(sid);
      if (!cancelled) setMessages(hist);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  async function handleTryStartOllama() {
    setOllamaStartBusy(true);
    setOllamaStartHint(null);
    try {
      const hint = await tryStartOllama();
      setOllamaStartHint(hint);
      let ok = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        ok = await ollamaHealth();
        if (ok) break;
      }
      if (ok) {
        await refreshOllama();
        setOllamaStartHint("Ollama is reachable on 127.0.0.1:11434.");
      } else {
        setOllamaStartHint(
          (prev) =>
            `${prev ?? ""} After 20s the API is still not reachable — use Download installer below or start Ollama manually.`,
        );
      }
    } catch (e) {
      setOllamaStartHint(String(e));
    } finally {
      setOllamaStartBusy(false);
    }
  }

  async function handleDownloadInstaller() {
    setOllamaStartHint(null);
    setDownloadBusy(true);
    setDownloadProgress({ received: 0, total: null });
    try {
      await startOllamaInstallerDownload();
    } catch (e) {
      setDownloadBusy(false);
      setDownloadProgress(null);
      setOllamaStartHint(String(e));
    }
  }

  async function handleRunInstallerOnly() {
    setOllamaStartHint(null);
    try {
      const msg = await installOllamaFromDownload();
      setOllamaStartHint(msg.replace(/\*\*/g, ""));
    } catch (e) {
      setOllamaStartHint(String(e));
    }
  }

  async function selectSession(id: number) {
    if (streaming || id === sessionId) return;
    setSessionId(id);
    const hist = await listChatMessages(id);
    setMessages(hist);
    setModelMenuOpen(false);
  }

  async function startNewChat() {
    if (streaming) return;
    const s = await createChatSession(workspace.id, "New chat");
    setSessions((prev) => [s, ...prev]);
    setSessionId(s.id);
    setMessages([]);
    setModelMenuOpen(false);
  }

  async function removeSession(id: number, e?: React.MouseEvent) {
    e?.stopPropagation();
    if (streaming) return;
    try {
      await deleteChatSession(workspace.id, id);
    } catch {
      return;
    }
    const next = await listChatSessions(workspace.id);
    if (next.length === 0) {
      const s = await createChatSession(workspace.id, "New chat");
      setSessions([s]);
      setSessionId(s.id);
      setMessages([]);
      return;
    }
    setSessions(next);
    if (sessionId === id) {
      const sid = next[0].id;
      setSessionId(sid);
      setMessages(await listChatMessages(sid));
    }
  }

  async function pullModelByName(name: string) {
    const trimmed = name.trim();
    if (!trimmed || pullingName) return;
    setPullingName(trimmed);
    setPullLog("");
    try {
      for await (const ev of pullModelStream(trimmed)) {
        const line = ev.status
          ? `${ev.status}${ev.completed != null && ev.total != null ? ` ${ev.completed}/${ev.total}` : ""}\n`
          : "";
        if (line) setPullLog((l) => l + line);
      }
      // `/api/tags` can briefly lag behind a finished pull — retry before refreshing UI.
      for (let attempt = 0; attempt < 12; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 200));
        }
        try {
          const tags = await listModels();
          if (localListHasModel(tags, trimmed)) break;
        } catch {
          /* ignore until refreshOllama surfaces the error */
        }
      }
      await refreshOllama();
      setModel(trimmed);
      void updateWorkspaceModel(workspace.id, trimmed);
      setPullModelInput(DEFAULT_SUGGESTED_MODEL);
      setModelMenuOpen(false);
    } catch (e) {
      setPullLog((l) => l + String(e));
    } finally {
      setPullingName(null);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || !sessionId || !model || streaming) return;

    const userMsg = await appendChatMessage(sessionId, "user", text);
    setMessages((m) => [...m, userMsg]);
    setInput("");

    const sessMeta = sessions.find((s) => s.id === sessionId);
    if (sessMeta && isPlaceholderChatTitle(sessMeta.title)) {
      const all = await listChatMessages(sessionId);
      const userCount = all.filter((m) => m.role === "user").length;
      if (userCount === 1) {
        try {
          await updateChatSessionTitle(
            sessionId,
            deriveChatTitleFromUserMessage(text),
          );
          const refreshed = await listChatSessions(workspace.id);
          setSessions(refreshed);
        } catch {
          /* ignore */
        }
      }
    }

    setStreaming(true);

    const subset = selectRelevantTables(tables, text);
    let retrievalBlock = "";
    try {
      const hits = await searchSchemaForChat(workspace.id, text, 8);
      retrievalBlock = formatRetrievalForPrompt(hits);
    } catch {
      /* Web build or IPC unavailable — chat without RAG */
    }
    const system = buildSystemPrompt(
      subset,
      dialect,
      text,
      retrievalBlock || undefined,
    );

    let assistantText = "";
    const assistantPlaceholder: ChatMessage = {
      id: -1,
      sessionId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    setMessages((m) => [...m, assistantPlaceholder]);

    try {
      const hist = await listChatMessages(sessionId);
      const conv = hist
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

      const stream = chatStream(model, [
        { role: "system", content: system },
        ...conv.slice(-24),
      ]);

      for await (const chunk of stream) {
        assistantText += chunk;
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant" && last.id === -1) {
            copy[copy.length - 1] = { ...last, content: assistantText };
          }
          return copy;
        });
      }

      const saved = await appendChatMessage(
        sessionId,
        "assistant",
        assistantText,
      );
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant" && last.id === -1) {
          copy[copy.length - 1] = saved;
        }
        return copy;
      });
    } catch (e) {
      const err = `Error: ${String(e)}`;
      await appendChatMessage(sessionId, "assistant", err);
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant" && last.id === -1) {
          copy[copy.length - 1] = {
            ...last,
            id: Date.now(),
            content: err,
          };
        }
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col border-l border-slate-800 bg-slate-900/50">
      <div className="flex flex-col gap-2 border-b border-slate-800 px-3 py-2">
        {ollamaOk === false && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-900/50 bg-amber-950/40 px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
            <span className="text-xs text-amber-100">
              Ollama is not running at{" "}
              <code className="text-amber-200/90">127.0.0.1:11434</code>. Download
              the official installer inside the app, run it, then start Ollama.
            </span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={ollamaStartBusy}
                className="rounded bg-amber-700 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
                onClick={() => void handleTryStartOllama()}
              >
                {ollamaStartBusy ? "Starting…" : "Start Ollama"}
              </button>
              <button
                type="button"
                disabled={downloadBusy}
                className="rounded border border-amber-700/60 px-3 py-1 text-xs text-amber-100 hover:bg-amber-900/50 disabled:opacity-50"
                onClick={() => void handleDownloadInstaller()}
              >
                {downloadBusy ? "Downloading…" : "Download installer"}
              </button>
              {installerOnDisk && !downloadBusy && (
                <button
                  type="button"
                  className="rounded border border-amber-600/50 px-3 py-1 text-xs text-amber-50 hover:bg-amber-900/40"
                  onClick={() => void handleRunInstallerOnly()}
                >
                  Run installer again
                </button>
              )}
              <button
                type="button"
                className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800"
                onClick={() => void refreshOllama()}
              >
                Check again
              </button>
            </div>
            {downloadProgress && (
              <div className="w-full space-y-1">
                <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-amber-500 transition-[width] duration-300"
                    style={{
                      width: downloadProgress.total
                        ? `${Math.min(100, (downloadProgress.received / downloadProgress.total) * 100)}%`
                        : "35%",
                    }}
                  />
                </div>
                <p className="text-[10px] text-amber-200/70">
                  {fmtBytes(downloadProgress.received)}
                  {downloadProgress.total != null
                    ? ` / ${fmtBytes(downloadProgress.total)}`
                    : " — size unknown, still downloading…"}
                </p>
              </div>
            )}
            {ollamaStartHint && (
              <p className="w-full text-[11px] text-amber-200/80">{ollamaStartHint}</p>
            )}
          </div>
        )}
      </div>
      {pullLog && (
        <pre className="max-h-24 shrink-0 overflow-auto border-b border-slate-800 bg-black/30 px-3 py-1 text-[10px] text-slate-400">
          {pullLog}
        </pre>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        <aside className="flex w-[188px] shrink-0 flex-col border-r border-slate-800 bg-slate-950/50">
          <div className="border-b border-slate-800 p-2">
            <button
              type="button"
              disabled={streaming}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/80 px-2.5 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              onClick={() => void startNewChat()}
            >
              <MessageSquarePlus className="size-3.5 shrink-0" />
              New chat
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            <p className="px-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
              History
            </p>
            <ul className="flex flex-col gap-0.5">
              {sessions.map((s) => (
                <li key={s.id} className="group flex items-stretch gap-0.5">
                  <button
                    type="button"
                    disabled={streaming}
                    className={cn(
                      "min-w-0 flex-1 truncate rounded-md px-2 py-2 text-left text-xs transition-colors disabled:opacity-40",
                      sessionId === s.id
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200",
                    )}
                    title={s.title}
                    onClick={() => void selectSession(s.id)}
                  >
                    {s.title}
                  </button>
                  <button
                    type="button"
                    disabled={streaming}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-slate-500 opacity-0 hover:bg-slate-800 hover:text-rose-400 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-0"
                    title="Delete chat"
                    onClick={(e) => void removeSession(s.id, e)}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {messages.map((msg) => {
          const sql =
            msg.role === "assistant" ? extractSqlBlock(msg.content) : null;
          const displayBody =
            msg.role === "assistant" && sql
              ? stripFirstSqlCodeBlock(msg.content)
              : msg.content;
          return (
            <div
              key={msg.id === -1 ? "stream" : msg.id}
              className={`mb-3 rounded-lg px-3 py-2 text-sm ${
                msg.role === "user"
                  ? "ml-8 bg-cyan-950/40 text-slate-100"
                  : "mr-4 bg-slate-800/60 text-slate-200"
              }`}
            >
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                {msg.role}
              </div>
              {displayBody.trim() ? (
                <pre className="whitespace-pre-wrap font-sans">{displayBody}</pre>
              ) : null}
              {msg.role === "assistant" && sql && (
                <div className="mt-2 space-y-2 border-t border-slate-700/80 pt-2">
                  <SyntaxHighlighter
                    language="sql"
                    style={oneDark}
                    customStyle={{
                      margin: 0,
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  >
                    {sql}
                  </SyntaxHighlighter>
                  <button
                    type="button"
                    className="rounded bg-cyan-800 px-2 py-0.5 text-xs text-white hover:bg-cyan-700"
                    onClick={() => void navigator.clipboard.writeText(sql)}
                  >
                    Copy SQL
                  </button>
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
          </div>
          <div className="shrink-0 border-t border-slate-800 p-2">
            <div className="flex gap-2">
              <textarea
                className="min-h-[72px] min-w-0 flex-1 resize-y rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
                placeholder="Ask for a query using your schema…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="flex shrink-0 flex-col items-stretch justify-end gap-2">
                {ollamaOk && (
                  <div className="relative w-[min(12rem,28vw)]">
                    <button
                      type="button"
                      aria-expanded={modelMenuOpen}
                      aria-haspopup="listbox"
                      className="inline-flex w-full max-w-full items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900/90 py-1.5 pl-2.5 pr-2 text-left text-xs text-slate-100 shadow-sm hover:border-slate-500"
                      onClick={() => {
                        setModelMenuOpen((o) => !o);
                        if (!modelMenuOpen) setModelSearch("");
                      }}
                    >
                      {runningNames.has(model) ? (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                          title="Loaded in memory"
                        />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {model || "Model"}
                      </span>
                      <ChevronDown className="size-3.5 shrink-0 text-slate-400" />
                    </button>
                    {modelMenuOpen && (
              <div
                className="absolute right-0 bottom-full z-50 mb-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-xl"
                role="listbox"
              >
                <input
                  type="search"
                  autoFocus
                  placeholder="Filter models…"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  className="w-full border-b border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                />
                <ul className="max-h-56 overflow-y-auto py-1">
                  {ollamaTagsError ? (
                    <li className="px-3 py-2 text-xs text-rose-300/90">
                      Could not read local models (GET /api/tags):{" "}
                      {ollamaTagsError}
                    </li>
                  ) : null}
                  {libraryCatalogError ? (
                    <li className="px-3 py-1.5 text-[11px] text-amber-200/80">
                      Library list unavailable (ollama.com/api/tags):{" "}
                      {libraryCatalogError}
                    </li>
                  ) : null}
                  {modelPickerRows.length === 0 ? (
                    <li className="px-3 py-2 text-xs text-slate-500">No matches</li>
                  ) : (
                    modelPickerRows.map(({ name, local: loc, catalog: cat }) => {
                      const installed = loc != null;
                      const active = model === name;
                      const busy = pullingName === name;
                      const run = runningByName.get(name);
                      const metaParts = [
                        loc?.details?.parameter_size ??
                          cat?.details?.parameter_size,
                        loc?.details?.quantization_level ??
                          cat?.details?.quantization_level,
                      ].filter(Boolean);
                      if (run?.size_vram != null) {
                        metaParts.push(`${fmtBytes(run.size_vram)} VRAM`);
                      } else if (run) {
                        metaParts.push("in memory");
                      }
                      const metaLine = metaParts.join(" · ");
                      const hintBytes = OLLAMA_MODEL_SIZE_HINT_BYTES[name];
                      const diskBytes =
                        loc != null && loc.size > 0
                          ? loc.size
                          : cat != null && cat.size > 0
                            ? cat.size
                            : hintBytes != null
                              ? hintBytes
                              : null;
                      const sizeTitle =
                        loc != null && loc.size > 0
                          ? "Installed size (local)"
                          : cat != null && cat.size > 0
                            ? "Catalog size (ollama.com)"
                            : hintBytes != null
                              ? "Approximate hint"
                              : "Unknown until pulled";
                      return (
                        <li
                          key={name}
                          className={`flex items-stretch gap-0.5 ${
                            active ? "bg-slate-800/90" : "hover:bg-slate-800/60"
                          }`}
                          role="option"
                          aria-selected={active}
                        >
                          <button
                            type="button"
                            disabled={!!pullingName}
                            className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm text-slate-100 disabled:cursor-wait disabled:opacity-70"
                            onClick={() => {
                              if (pullingName) return;
                              if (installed) {
                                setModel(name);
                                void updateWorkspaceModel(workspace.id, name);
                                setModelMenuOpen(false);
                              } else {
                                void pullModelByName(name);
                              }
                            }}
                          >
                            <span className="block truncate font-medium">{name}</span>
                            {metaLine ? (
                              <span className="mt-0.5 block truncate text-[10px] font-normal text-slate-500">
                                {metaLine}
                              </span>
                            ) : !installed ? (
                              <span className="mt-0.5 block truncate text-[10px] font-normal text-slate-600">
                                {cat
                                  ? "Not installed — click to pull"
                                  : "Not in catalog — manual pull"}
                              </span>
                            ) : null}
                          </button>
                          <span
                            className="flex min-w-[4.5rem] shrink-0 items-center justify-end pr-0.5 text-right"
                            title={sizeTitle}
                          >
                            {diskBytes != null ? (
                              <span className="text-[10px] tabular-nums text-slate-400">
                                {fmtBytes(diskBytes)}
                              </span>
                            ) : (
                              <span className="text-[10px] text-slate-600">—</span>
                            )}
                          </span>
                          {installed ? (
                            <button
                              type="button"
                              title="Update or re-pull (POST /api/pull)"
                              disabled={busy || !!pullingName}
                              className="flex size-8 shrink-0 items-center justify-center text-slate-500 hover:bg-slate-700/80 hover:text-slate-200 disabled:opacity-40"
                              onClick={(e) => {
                                e.stopPropagation();
                                void pullModelByName(name);
                              }}
                            >
                              {busy ? (
                                <span className="text-[10px]">…</span>
                              ) : (
                                <RefreshCw className="size-3.5" />
                              )}
                            </button>
                          ) : (
                            <button
                              type="button"
                              title="Pull (POST /api/pull)"
                              disabled={busy || !!pullingName}
                              className="flex shrink-0 items-center justify-center px-2 text-slate-400 hover:bg-slate-700/80 hover:text-slate-100 disabled:opacity-40"
                              onClick={(e) => {
                                e.stopPropagation();
                                void pullModelByName(name);
                              }}
                            >
                              {busy ? (
                                <span className="text-[10px]">…</span>
                              ) : (
                                <Download className="size-4" />
                              )}
                            </button>
                          )}
                        </li>
                      );
                    })
                  )}
                </ul>
                <div className="flex gap-2 border-t border-slate-800 bg-slate-950/60 p-2">
                  <input
                    type="text"
                    value={pullModelInput}
                    onChange={(e) => setPullModelInput(e.target.value)}
                    placeholder="model:tag — POST /api/pull"
                    className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void pullModelByName(pullModelInput);
                    }}
                  />
                  <button
                    type="button"
                    disabled={!pullModelInput.trim() || !!pullingName}
                    className="shrink-0 rounded bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-600 disabled:opacity-40"
                    onClick={() => void pullModelByName(pullModelInput)}
                  >
                    {pullingName ? "Pulling…" : "Pull"}
                  </button>
                </div>
              </div>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  disabled={streaming || !model}
                  className="rounded bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-40"
                  onClick={() => void send()}
                >
                  Send
                </button>
              </div>
            </div>
            <p className="mt-1 text-[10px] text-slate-500">
              ⌘/Ctrl+Enter to send · Smart context:{" "}
              {tables.length > 50
                ? "only relevant tables + FK neighbors are sent when you have 50+ tables."
                : "full schema sent."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
