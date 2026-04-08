import { useEffect, useState } from "react";
import { getAuditLogs, exportAuditLogs, type AuditLog } from "../lib/api";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";
import { ShieldCheck, Clock, Tag, Info, Download } from "lucide-react";
import { Button } from "./ui/button";

export function AuditLogModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (open) {
      setLoading(true);
      getAuditLogs()
        .then(setLogs)
        .finally(() => setLoading(false));
    }
  }, [open]);

  async function handleExport() {
    setExporting(true);
    try {
      const path = await save({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: `audit_logs_${new Date().toISOString().split("T")[0]}.json`,
      });
      if (path) {
        const data = await exportAuditLogs();
        await writeTextFile(path, data);
      }
    } catch (e) {
      console.error("Export failed", e);
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-slate-900 text-slate-100 border-slate-800">
        <DialogHeader className="flex flex-row items-center justify-between space-y-0">
          <DialogTitle className="flex items-center gap-2 text-xl">
            <ShieldCheck className="text-cyan-400" />
            Security Audit Logs
          </DialogTitle>
          <Button
            variant="outline"
            size="sm"
            className="bg-slate-800 border-slate-700 hover:bg-slate-700"
            disabled={exporting || logs.length === 0}
            onClick={handleExport}
          >
            <Download className="size-4 mr-2" />
            {exporting ? "Exporting..." : "Export to JSON"}
          </Button>
        </DialogHeader>

        <ScrollArea className="h-[400px] mt-4 pr-4">
          {loading ? (
            <div className="flex items-center justify-center h-full text-slate-500">
              Loading logs...
            </div>
          ) : logs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-slate-500">
              No logs found.
            </div>
          ) : (
            <div className="space-y-3">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="p-3 rounded-lg border border-slate-800 bg-slate-950/50 hover:bg-slate-800/40 transition-colors"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded bg-cyan-900/30 text-cyan-400 text-[10px] font-bold tracking-wider">
                        {log.eventType}
                      </span>
                      {log.workspaceId && (
                        <span className="flex items-center gap-1 text-[10px] text-slate-500">
                          <Tag size={10} /> WS #{log.workspaceId}
                        </span>
                      )}
                    </div>
                    <span className="flex items-center gap-1 text-[10px] text-slate-500 font-mono">
                      <Clock size={10} />
                      {new Date(log.timestamp).toLocaleString()}
                    </span>
                  </div>
                  {log.metadata && (
                    <div className="flex items-start gap-2 text-xs text-slate-300">
                      <Info size={12} className="mt-0.5 shrink-0 text-slate-500" />
                      <p className="break-all">{log.metadata}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
