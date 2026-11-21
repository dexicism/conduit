"use client";

import type { Orientation, WorkflowNode as WfNode } from "@conduit/core";
import { creditCost, getDefinition, outputsOf, TOOL_HANDLE, type ParamIssue } from "@conduit/nodes";
import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
import { CircleAlertIcon, PlusIcon } from "lucide-react";
import { memo, useEffect } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useEditorStoreApi } from "./context";
import { NodeIcon } from "./node-visuals";

export interface WorkflowNodeData extends Record<string, unknown> {
  node: WfNode;
  orientation: Orientation;
  issues: ParamIssue[];
  /** Output handle IDs that already have at least one edge. */
  connectedOutputs: string[];
  /** Result of this step in the current test run. */
  runStep?: { status: "success" | "failed" | "waiting"; items: number; error: string | null };
  /** Just added or changed by the AI builder. */
  highlight?: "added" | "updated";
  /** Number of tools attached to an agent's tool port. */
  toolCount?: number;
}

export type WorkflowFlowNode = Node<WorkflowNodeData, "workflow">;

function spread(i: number, count: number): string {
  return `${((i + 1) / (count + 1)) * 100}%`;
}

export const WorkflowNodeCard = memo(function WorkflowNodeCard({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const store = useEditorStoreApi();
  const updateNodeInternals = useUpdateNodeInternals();
  const { node, orientation, issues, connectedOutputs, runStep, highlight, toolCount = 0 } = data;
  const def = getDefinition(node.type);
  const horizontal = orientation === "horizontal";
  const inputs = def?.inputs ?? [];
  const outputs = def ? outputsOf(def, node.parameters) : [];
  const isTool = def?.category === "tool";
  const handleKey = `${orientation}|${outputs.map((o) => o.id).join(",")}|${def?.toolPort ? "tp" : ""}`;
  // Tools attach from below (or the side, when vertical); keep their input on that edge.
  const inputPos = isTool ? (horizontal ? Position.Top : Position.Left) : horizontal ? Position.Left : Position.Top;
  const toolPortPos = horizontal ? Position.Bottom : Position.Right;

  // Handles change with Switch cases and orientation; React Flow must re-measure them
  // before edges can attach to new handles.
  useEffect(() => {
    updateNodeInternals(id);
  }, [handleKey, id, updateNodeInternals]);
  const isTrigger = def?.category === "trigger";
  const multiOut = outputs.length > 1 || outputs.some((o) => o.label);

  return (
    <div
      data-testid={`node-${node.id}`}
      data-run-status={runStep?.status}
      className={cn(
        "group relative w-[200px] rounded-xl border bg-card text-card-foreground shadow-sm transition-shadow",
        selected ? "border-primary ring-2 ring-primary/30" : "hover:border-foreground/20",
        !selected && runStep?.status === "success" && "border-success ring-2 ring-success/25",
        !selected && runStep?.status === "failed" && "border-destructive ring-2 ring-destructive/25",
        !selected && runStep?.status === "waiting" && "border-warning ring-2 ring-warning/25",
        !selected && !runStep && highlight === "added" && "border-success ring-4 ring-success/30",
        !selected && !runStep && highlight === "updated" && "border-signal ring-4 ring-signal/30",
        isTool && "border-dashed",
        node.disabled && "opacity-50",
        isTrigger && "rounded-l-[22px]",
      )}
    >
      {inputs.map((h, i) => (
        <Handle
          key={`in-${h.id}`}
          id={h.id}
          type="target"
          position={inputPos}
          style={
            inputPos === Position.Left
              ? { top: spread(i, inputs.length) }
              : { left: spread(i, inputs.length) }
          }
          className="!size-3 !border-2 !border-background !bg-muted-foreground"
          aria-label={`Input ${h.label ?? ""}`}
        >
          {h.label && !isTool && (
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[10px] text-muted-foreground">
              {h.label}
            </span>
          )}
        </Handle>
      ))}

      {def?.toolPort && (
        <Handle
          id={TOOL_HANDLE}
          type="source"
          position={toolPortPos}
          style={horizontal ? { left: "30%" } : { top: "70%" }}
          className="!size-3 !rotate-45 !rounded-[2px] !border-2 !border-background !bg-violet-500"
          aria-label="Tool port"
        >
          <span
            className={cn(
              "pointer-events-none absolute text-[10px] whitespace-nowrap text-muted-foreground",
              horizontal ? "top-3 left-1/2 -translate-x-1/2 -rotate-45" : "top-1/2 left-3 -translate-y-1/2 -rotate-45",
            )}
          >
            tools{toolCount ? ` (${toolCount})` : ""}
          </span>
          <button
            type="button"
            aria-label={`Add a tool to ${node.label}`}
            onClick={(e) => {
              e.stopPropagation();
              store.getState().openPicker({ from: { nodeId: node.id, handle: TOOL_HANDLE } });
            }}
            className={cn(
              "nodrag absolute flex size-5 -rotate-45 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100",
              selected && "opacity-100",
              horizontal ? "top-8 left-1/2 -translate-x-1/2" : "top-1/2 left-12 -translate-y-1/2",
            )}
          >
            <PlusIcon className="size-3" />
          </button>
        </Handle>
      )}

      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <NodeIcon def={def} />
        <div className="min-w-0 flex-1">
          {def && def.name !== node.label && (
            <p className="truncate text-[10px] leading-tight text-muted-foreground">{def.name}</p>
          )}
          <p className="truncate text-[13px] leading-snug font-medium" title={node.label}>
            {node.label}
          </p>
        </div>
        {def && creditCost(def) > 0 && (
          <span
            data-testid="node-credits"
            title={`${creditCost(def)} credit${creditCost(def) === 1 ? "" : "s"} per live run`}
            className="shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground tabular-nums"
          >
            {creditCost(def)} cr
          </span>
        )}
        {runStep && (
          <span
            data-testid="node-run-badge"
            title={runStep.error ?? `${runStep.items} item${runStep.items === 1 ? "" : "s"}`}
            className={cn(
              "absolute -top-2.5 -right-2 rounded-full border bg-background px-1.5 text-[10px] leading-4 font-medium tabular-nums",
              runStep.status === "success" && "border-success text-success",
              runStep.status === "failed" && "border-destructive text-destructive",
              runStep.status === "waiting" && "border-warning text-warning",
            )}
          >
            {runStep.status === "failed" ? "error" : runStep.status === "waiting" ? "waiting" : runStep.items}
          </span>
        )}
        {issues.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="text-warning"
                  aria-label={`${issues.length} issue${issues.length === 1 ? "" : "s"}`}
                  data-testid="node-issues"
                />
              }
            >
              <CircleAlertIcon className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64">
              <ul className="space-y-0.5">
                {issues.slice(0, 4).map((i, k) => (
                  <li key={k}>{i.message}</li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {outputs.map((h, i) => {
        const style = horizontal ? { top: spread(i, outputs.length) } : { left: spread(i, outputs.length) };
        const free = !connectedOutputs.includes(h.id);
        return (
          <Handle
            key={`out-${h.id}`}
            id={h.id}
            type="source"
            position={horizontal ? Position.Right : Position.Bottom}
            style={style}
            className="!size-3 !border-2 !border-background !bg-primary"
            aria-label={`Output ${h.label ?? h.id}`}
          >
            {multiOut && h.label && (
              <span
                className={cn(
                  "pointer-events-none absolute text-[10px] whitespace-nowrap text-muted-foreground",
                  horizontal ? "top-1/2 left-3.5 -translate-y-1/2" : "top-3 left-1/2 -translate-x-1/2",
                )}
              >
                {h.label}
              </span>
            )}
            {free && (
              <button
                type="button"
                aria-label={`Add a step after ${node.label}${multiOut ? ` (${h.label ?? h.id})` : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  store.getState().openPicker({ from: { nodeId: node.id, handle: h.id } });
                }}
                className={cn(
                  "nodrag absolute flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100",
                  selected && "opacity-100",
                  horizontal
                    ? cn("top-1/2 -translate-y-1/2", multiOut && h.label ? "left-14" : "left-5")
                    : cn("left-1/2 -translate-x-1/2", multiOut && h.label ? "top-8" : "top-5"),
                )}
              >
                <PlusIcon className="size-3" />
              </button>
            )}
          </Handle>
        );
      })}
    </div>
  );
});
