import { buildSchemaFromFiles } from "./parseSchema";
import type { Dialect } from "./api";

self.onmessage = (e: MessageEvent<{ files: { relativePath: string; content: string }[]; dialect: Dialect }>) => {
  const { files, dialect } = e.data;
  try {
    const result = buildSchemaFromFiles(files, dialect);
    self.postMessage({ type: "success", result });
  } catch (error) {
    self.postMessage({ type: "error", error: String(error) });
  }
};
