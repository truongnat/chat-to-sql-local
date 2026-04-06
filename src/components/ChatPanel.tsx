import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { ChatMessage, LoadedTable, Workspace } from "../lib/api";
import {
  appendChatMessage,
  createChatSession,
  installOllamaFromDownload,
  listChatMessages,
  listChatSessions,
  ollamaInstallerExists,
  startOllamaInstallerDownload,
  tryStartOllama,
  updateWorkspaceModel,
} from "../lib/api";
import type { Dialect } from "../lib/api";
import {
  buildSystemPrompt,
  extractSqlBlock,
  selectRelevantTables,
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
  listRunningModels,
  ollamaHealth,
  pullModelStream,
  sortLocalModelsForPicker,
} from "../lib/ollama";

type ModelPickerRow = { name: string; meta?: OllamaModel };

function IconChevronDown({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function IconDownload({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
  const modelPickerRef = useRef<HTMLDivElement>(null);

  const refreshOllama = useCallback(async () => {
    const ok = await ollamaHealth();
    setOllamaOk(ok);
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
      setOllamaTagsError(null);
    }
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
    const sorted = sortLocalModelsForPicker(localModels, runningNames);
    const seen = new Set<string>();
    const rows: ModelPickerRow[] = [];
    for (const m of sorted) {
      const n = m.name;
      if (!n || seen.has(n)) continue;
      seen.add(n);
      rows.push({ name: n, meta: m });
    }
    for (const n of OLLAMA_MODEL_SUGGESTIONS) {
      if (!n || seen.has(n)) continue;
      seen.add(n);
      rows.push({ name: n });
    }
    return rows;
  }, [localModels, runningNames]);

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
    if (!modelMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const el = modelPickerRef.current;
      if (el && !el.contains(e.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modelMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sessions = await listChatSessions(workspace.id);
      let sid: number;
      if (sessions.length) {
        sid = sessions[0].id;
      } else {
        const s = await createChatSession(workspace.id, "Chat");
        sid = s.id;
      }
      if (cancelled) return;
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
    setStreaming(true);

    const subset = selectRelevantTables(tables, text);
    const system = buildSystemPrompt(subset, dialect);

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
        <div className="flex flex-wrap items-center gap-2">
        {ollamaOk && (
          <div className="relative flex items-center gap-2" ref={modelPickerRef}>
            <span className="text-xs text-slate-500">Model</span>
            <button
              type="button"
              aria-expanded={modelMenuOpen}
              aria-haspopup="listbox"
              className="inline-flex max-w-[min(16rem,100%)] items-center gap-2 rounded-full border border-slate-600 bg-slate-900/90 py-1.5 pl-3 pr-2 text-left text-sm text-slate-100 shadow-sm hover:border-slate-500"
              onClick={() => {
                setModelMenuOpen((o) => !o);
                if (!modelMenuOpen) setModelSearch("");
              }}
            >
              {runningNames.has(model) ? (
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-emerald-500"
                  title="Model loaded in memory (/api/ps)"
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate font-medium">
                {model || "Select model"}
              </span>
              <IconChevronDown className="shrink-0 text-slate-400" />
            </button>
            {modelMenuOpen && (
              <div
                className="absolute left-0 top-full z-50 mt-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-xl"
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
                      Could not read models (GET /api/tags): {ollamaTagsError}
                    </li>
                  ) : modelPickerRows.length === 0 ? (
                    <li className="px-3 py-2 text-xs text-slate-500">No matches</li>
                  ) : (
                    modelPickerRows.map(({ name, meta: m }) => {
                      const installed = m != null;
                      const active = model === name;
                      const busy = pullingName === name;
                      const run = runningByName.get(name);
                      const metaParts = [
                        m?.details?.parameter_size,
                        m?.details?.quantization_level,
                      ].filter(Boolean);
                      if (run?.size_vram != null) {
                        metaParts.push(`${fmtBytes(run.size_vram)} VRAM`);
                      } else if (run) {
                        metaParts.push("in memory");
                      }
                      const metaLine = metaParts.join(" · ");
                      const hintBytes = OLLAMA_MODEL_SIZE_HINT_BYTES[name];
                      const diskBytes =
                        m != null && m.size > 0
                          ? m.size
                          : hintBytes != null
                            ? hintBytes
                            : null;
                      const sizeTitle =
                        m != null && m.size > 0
                          ? "from GET /api/tags"
                          : hintBytes != null
                            ? "approximate (hint)"
                            : "unknown until pulled";
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
                                Not installed — click to pull
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
                          <button
                            type="button"
                            title={
                              installed
                                ? "Re-pull or update (POST /api/pull)"
                                : "Pull (POST /api/pull)"
                            }
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
                              <IconDownload />
                            )}
                          </button>
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
        </div>
      </div>
      {pullLog && (
        <pre className="max-h-24 overflow-auto border-b border-slate-800 bg-black/30 px-3 py-1 text-[10px] text-slate-400">
          {pullLog}
        </pre>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {messages.map((msg) => {
          const sql =
            msg.role === "assistant" ? extractSqlBlock(msg.content) : null;
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
              <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
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
      <div className="border-t border-slate-800 p-2">
        <div className="flex gap-2">
          <textarea
            className="min-h-[72px] flex-1 resize-y rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
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
          <button
            type="button"
            disabled={streaming || !model}
            className="self-end rounded bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-40"
            onClick={() => void send()}
          >
            Send
          </button>
        </div>
        <p className="mt-1 text-[10px] text-slate-500">
          ⌘/Ctrl+Enter to send · Smart context:{" "}
          {tables.length > 50
            ? "only relevant tables + FK neighbors are sent when you have 50+ tables."
            : "full schema sent."}
        </p>
      </div>
    </div>
  );
}
