import { invoke } from "@tauri-apps/api/core";

/** Prefer `localhost` so IPv4/IPv6 resolution matches the OS (same as `curl localhost:11434`). */
const BASE = "http://localhost:11434";

/**
 * Tauri 2 does not always set `window.isTauri`, so `isTauri()` from `@tauri-apps/api/core` can be false
 * inside a real app — then we'd wrongly use `fetch` (blocked / flaky in the WebView) instead of IPC + Rust proxy.
 */
function useOllamaIpc(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Matches Ollama `/api/tags` and `/api/ps` model `details` (see ollama docs api.md). */
export interface OllamaModelDetails {
  parent_model?: string;
  format?: string;
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
}

export interface OllamaModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  /** Present on `/api/tags`; may be omitted on `/api/ps`. */
  modified_at?: string;
  details?: OllamaModelDetails;
}

/** `/api/ps` — models currently loaded in memory. */
export interface OllamaRunningModel extends OllamaModel {
  expires_at?: string;
  size_vram?: number;
}

export interface TagsResponse {
  models: OllamaModel[];
}

export interface PsResponse {
  models: OllamaRunningModel[];
}

export async function ollamaHealth(): Promise<boolean> {
  try {
    if (useOllamaIpc()) {
      await invoke<unknown>("ollama_api_tags");
      return true;
    }
    const r = await fetch(`${BASE}/api/tags`, { method: "GET" });
    return r.ok;
  } catch {
    return false;
  }
}

/** Accept normal Ollama shape or minor variants. */
function extractModelsArrayFromTagsPayload(payload: unknown): unknown[] {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;
  if (Array.isArray(o.models)) return o.models;
  if (o.data != null && typeof o.data === "object") {
    const d = o.data as Record<string, unknown>;
    if (Array.isArray(d.models)) return d.models;
  }
  return [];
}

function extractModelsArrayFromPsPayload(payload: unknown): unknown[] {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;
  if (Array.isArray(o.models)) return o.models;
  return [];
}

function normalizeTagEntries(raw: unknown[]): OllamaModel[] {
  const out: OllamaModel[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const name = String(m.name ?? m.model ?? "").trim();
    if (!name) continue;
    const size =
      typeof m.size === "number" && Number.isFinite(m.size)
        ? m.size
        : Number(m.size) || 0;
    out.push({
      name,
      model: String(m.model ?? name),
      size,
      digest: String(m.digest ?? ""),
      modified_at:
        typeof m.modified_at === "string" ? m.modified_at : undefined,
      details: m.details as OllamaModelDetails | undefined,
    });
  }
  return out;
}

export async function listModels(): Promise<OllamaModel[]> {
  let payload: unknown;
  if (useOllamaIpc()) {
    payload = await invoke<unknown>("ollama_api_tags");
  } else {
    const r = await fetch(`${BASE}/api/tags`);
    if (!r.ok) throw new Error(`Ollama tags failed: HTTP ${r.status}`);
    try {
      payload = await r.json();
    } catch {
      throw new Error("Ollama /api/tags: invalid JSON");
    }
  }
  const raw = extractModelsArrayFromTagsPayload(payload);
  return normalizeTagEntries(raw);
}

/** Running / loaded models (VRAM). Fails soft if server is old or errors. */
/** Order for UI: in-memory models first (`/api/ps`), then by name. */
export function sortLocalModelsForPicker(
  models: OllamaModel[],
  runningNames: ReadonlySet<string>,
): OllamaModel[] {
  return [...models].sort((a, b) => {
    const ar = runningNames.has(a.name) ? 0 : 1;
    const br = runningNames.has(b.name) ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name);
  });
}

export async function listRunningModels(): Promise<OllamaRunningModel[]> {
  try {
    let payload: unknown;
    if (useOllamaIpc()) {
      payload = await invoke<unknown>("ollama_api_ps");
    } else {
      try {
        const r = await fetch(`${BASE}/api/ps`);
        if (!r.ok) return [];
        payload = await r.json();
      } catch {
        return [];
      }
    }
    const raw = extractModelsArrayFromPsPayload(payload);
    return raw
      .filter((m): m is OllamaRunningModel => m != null && typeof m === "object")
      .map((m) => ({
        ...m,
        name: (m.name || m.model || "").trim(),
      }))
      .filter((m) => m.name.length > 0);
  } catch {
    return [];
  }
}

export async function* pullModelStream(
  model: string,
): AsyncGenerator<{ status?: string; completed?: number; total?: number }> {
  const r = await fetch(`${BASE}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: model.trim(), stream: true }),
  });
  if (!r.ok || !r.body) throw new Error(`Pull failed: ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as {
          status?: string;
          completed?: number;
          total?: number;
        };
      } catch {
        /* ignore partial */
      }
    }
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function* chatStream(
  model: string,
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!r.ok || !r.body) {
    const t = await r.text();
    throw new Error(t || `Chat failed: ${r.status}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
        };
        const piece = obj.message?.content;
        if (piece) yield piece;
      } catch {
        /* ignore */
      }
    }
  }
}
