import { memo, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { KeyRound, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LoadedTable } from "../lib/api";
import {
  columnTypeForDisplay,
  displayTableName,
  referenceLineForColumn,
  tableMatchKey,
} from "../lib/schemaDisplay";

const NODE_WIDTH = 400;
const HEADER_H = 38;
const PAD_Y = 10;
const NAME_LINE = 16;
const TYPE_LINE_H = 13;
const REF_LINE_H = 12;
const ROW_GAP = 6;

export type TableErNodeData = {
  label: string;
  columns: {
    name: string;
    typeSql: string;
    isPk: boolean;
    isFk: boolean;
    refLine: string | null;
  }[];
  h: number;
};

function typeLineCount(typeSql: string, charsPerLine = 46): number {
  const t = typeSql.trim();
  if (!t) return 0;
  return Math.min(12, Math.max(1, Math.ceil(t.length / charsPerLine)));
}

function columnBlockHeight(c: {
  typeSql: string;
  refLine: string | null;
}): number {
  const typeLines = typeLineCount(c.typeSql);
  let h = NAME_LINE + ROW_GAP;
  if (typeLines > 0) {
    h += typeLines * TYPE_LINE_H;
  }
  if (c.refLine) {
    const refLines = Math.min(4, Math.max(1, Math.ceil(c.refLine.length / 50)));
    h += refLines * REF_LINE_H + 2;
  }
  return h;
}

function nodeHeight(cols: TableErNodeData["columns"]): number {
  const body = cols.reduce((sum, c) => sum + columnBlockHeight(c), 0);
  return HEADER_H + body + PAD_Y;
}

const TableErNode = memo(function TableErNodeFn(
  props: NodeProps<Node<TableErNodeData>>,
) {
  const { data } = props;
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        className="!h-2 !w-2 !border-2 !border-cyan-500 !bg-slate-950"
      />
      <div
        className="rounded-lg border-2 border-cyan-600/90 bg-slate-950 shadow-lg"
        style={{ width: NODE_WIDTH }}
      >
        <div className="rounded-t-md border-b border-cyan-800/90 bg-gradient-to-b from-cyan-950 to-slate-900 px-2 py-2 text-center text-[13px] font-semibold text-cyan-50">
          {data.label}
        </div>
        <div>
          {data.columns.map((c) => (
            <div
              key={c.name}
              className="border-b border-slate-800/80 px-2 py-1.5 last:border-b-0"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex w-4 shrink-0 justify-center">
                  {c.isPk ? (
                    <KeyRound className="size-3 text-amber-400" aria-label="PK" />
                  ) : c.isFk ? (
                    <Link2 className="size-3 text-violet-400" aria-label="FK" />
                  ) : null}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium leading-tight text-slate-100">
                    {c.name}
                  </div>
                  {c.typeSql ? (
                    <div className="mt-0.5 break-all font-mono text-[10px] leading-snug text-slate-300">
                      {c.typeSql}
                    </div>
                  ) : null}
                  {c.refLine ? (
                    <div className="mt-1 break-words font-mono text-[9px] leading-tight text-violet-300/95">
                      {c.refLine}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        className="!h-2 !w-2 !border-2 !border-cyan-500 !bg-slate-950"
      />
    </>
  );
});

const nodeTypes: NodeTypes = { tableEr: TableErNode };

function layoutWithDagre(
  nodes: Node<TableErNodeData>[],
  edges: Edge[],
): Node<TableErNodeData>[] {
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    nodesep: 56,
    ranksep: 80,
    marginx: 36,
    marginy: 36,
  });
  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: n.data.h });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    const h = n.data.h;
    return {
      ...n,
      position: {
        x: p.x - NODE_WIDTH / 2,
        y: p.y - h / 2,
      },
    };
  });
}

function buildGraph(
  tables: LoadedTable[],
): { nodes: Node<TableErNodeData>[]; edges: Edge[] } {
  const idByKey = new Map<string, string>();
  const nodes: Node<TableErNodeData>[] = tables.map((t, i) => {
    const key = tableMatchKey(t.name);
    const id = `er-${i}-${key.replace(/[^a-z0-9]+/g, "_")}`;
    idByKey.set(key, id);

    const fkColSet = new Set<string>();
    for (const fk of t.foreignKeys) {
      for (const c of fk.columns) fkColSet.add(c);
    }

    const cols = t.columns.map((c) => ({
      name: c.name,
      typeSql: columnTypeForDisplay(c.type) ?? "",
      isPk: c.isPk,
      isFk: fkColSet.has(c.name),
      refLine: referenceLineForColumn(t, c.name),
    }));
    const h = nodeHeight(cols);
    return {
      id,
      type: "tableEr",
      position: { x: 0, y: 0 },
      // Explicit size so MiniMap gets bounds before DOM measurement (custom nodes).
      width: NODE_WIDTH,
      height: h,
      data: {
        label: displayTableName(t.name),
        columns: cols,
        h,
      },
    };
  });

  const edgeMap = new Map<string, string[]>();
  for (const t of tables) {
    const childKey = tableMatchKey(t.name);
    const targetId = idByKey.get(childKey);
    if (!targetId) continue;
    for (const fk of t.foreignKeys) {
      const parentKey = tableMatchKey(fk.referencedTable);
      const sourceId = idByKey.get(parentKey);
      if (!sourceId) continue;
      const lbl = `${fk.columns.join(", ")} → ${fk.referencedColumns.join(", ")}`;
      const pair =
        sourceId === targetId
          ? `${sourceId}|${targetId}|${fk.columns.join(",")}|${fk.referencedColumns.join(",")}`
          : `${sourceId}|${targetId}`;
      const arr = edgeMap.get(pair) ?? [];
      arr.push(lbl);
      edgeMap.set(pair, arr);
    }
  }

  const edges: Edge[] = [];
  let ei = 0;
  for (const [pair, labels] of edgeMap) {
    const parts = pair.split("|");
    const source = parts[0];
    const target = parts[1];
    if (!source || !target) continue;
    const isSelf = source === target;
    edges.push({
      id: `e-${ei++}`,
      source,
      target,
      sourceHandle: "out",
      targetHandle: "in",
      label: labels.join(" · "),
      type: isSelf ? "bezier" : "smoothstep",
      animated: false,
      style: { stroke: "#22d3ee", strokeWidth: 2 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "#22d3ee",
        width: 18,
        height: 18,
      },
      labelStyle: { fill: "#94a3b8", fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: "#0f172a", fillOpacity: 0.92 },
      labelBgPadding: [4, 2],
      ...(isSelf
        ? {
            pathOptions: { curvature: 0.45 },
          }
        : {}),
    });
  }

  const placed = layoutWithDagre(nodes, edges);
  return { nodes: placed, edges };
}

function schemaSignature(tables: LoadedTable[]): string {
  return tables
    .map(
      (t) =>
        `${t.name}:${t.columns.length}:${t.foreignKeys.map((f) => f.referencedTable + f.columns.join()).join(";")}`,
    )
    .join("|");
}

export function SchemaErDiagram({
  tables,
  className,
}: {
  tables: LoadedTable[];
  className?: string;
}) {
  const { nodes, edges } = useMemo(() => buildGraph(tables), [tables]);
  const flowKey = useMemo(() => schemaSignature(tables), [tables]);

  if (tables.length === 0) return null;

  return (
    <div className={cn("min-h-0 min-w-0 flex-1", className)}>
      <ReactFlow
        key={flowKey}
        colorMode="dark"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnScroll
        zoomOnScroll
        minZoom={0.04}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        onInit={(instance) => {
          requestAnimationFrame(() =>
            instance.fitView({ padding: 0.15, maxZoom: 1.25, duration: 200 }),
          );
        }}
        className="h-full min-h-[400px] rounded-lg border border-slate-800 bg-slate-950/80"
      >
        <Background gap={20} size={1} color="#334155" />
        <Controls
          className="schema-er-controls !m-2 !overflow-hidden !rounded-md !border !border-slate-600 !shadow-lg"
          showInteractive={false}
        />
        <MiniMap
          className="!m-2 !rounded-md !border !border-slate-600 !bg-slate-900/90"
          style={{ width: 240, height: 180 }}
          maskColor="rgba(15, 23, 42, 0.55)"
          maskStrokeColor="rgba(34, 211, 238, 0.5)"
          maskStrokeWidth={2}
          nodeColor={() => "#0891b2"}
          nodeStrokeColor={() => "#22d3ee"}
          nodeStrokeWidth={2}
          offsetScale={2}
          pannable
          zoomable
        />
      </ReactFlow>
    </div>
  );
}
