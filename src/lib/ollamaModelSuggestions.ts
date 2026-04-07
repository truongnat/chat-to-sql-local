/**
 * Model mặc định / fallback khi catalog ollama.com chưa tải hoặc không có tên đó.
 * Menu chính lấy từ ollama.com/api/tags + model local (localhost /api/tags).
 */
export const OLLAMA_MODEL_SUGGESTIONS: readonly string[] = [
  "gemma3:4b",
  "gemma3:12b",
  "gemma3:27b",
  "gemma3:1b",
  "sqlcoder:7b",
  "sqlcoder:15b",
  "deepseek-r1:8b",
  "qwen3-coder:30b",
  "qwen3-vl:30b",
  "llama3.2:3b",
  "llama3.2:1b",
  "phi4:latest",
];

export const DEFAULT_SUGGESTED_MODEL =
  OLLAMA_MODEL_SUGGESTIONS[0] ?? "gemma3:4b";

/** Dung lượng gợi ý (bytes) khi model chưa có trong /api/tags — chỉ để hiển thị. */
export const OLLAMA_MODEL_SIZE_HINT_BYTES: Readonly<Record<string, number>> = {
  "gemma3:1b": 800_000_000,
  "gemma3:4b": 8_600_000_000,
  "gemma3:12b": 24_000_000_000,
  "gemma3:27b": 55_000_000_000,
  "deepseek-r1:8b": 5_200_000_000,
  "qwen3-coder:30b": 18_500_000_000,
  "qwen3-vl:30b": 20_000_000_000,
  "sqlcoder:7b": 4_200_000_000,
  "sqlcoder:15b": 8_800_000_000,
  "llama3.2:3b": 2_000_000_000,
  "llama3.2:1b": 1_300_000_000,
  "phi4:latest": 8_500_000_000,
};
