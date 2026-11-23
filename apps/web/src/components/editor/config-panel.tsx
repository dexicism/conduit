"use client";

import { getDefinition, isFieldVisible, nodeIssues } from "@conduit/nodes";
import { CopyIcon, Trash2Icon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { StepSummary } from "@conduit/core";
import { formatDuration } from "@/components/runs/run-status";
import { JsonView } from "@/components/runs/json-view";
import { cn } from "@/lib/utils";
import { useEditor, useEditorStoreApi } from "./context";
import { dataSourcesFor, resolveContextFor, variablesSource } from "./data-context";
import { latestSteps } from "./store";

function StepOutput({ step }: { step: StepSummary }) {
  const handles = Object.entries(step.output);
  return (
    <div className="grid gap-4 text-sm" data-testid="step-output">
      <p className="text-xs text-muted-foreground">
        {step.status === "success" ? "Succeeded" : step.status === "failed" ? "Failed" : "Waiting"} · {formatDuration(step.durationMs)} ·{" "}
        {step.inputCount} item{step.inputCount === 1 ? "" : "s"} in
        {step.truncated && " · large data shortened"}
      </p>
      {step.error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">{step.error}</p>}
      {step.logs.length > 0 && (
        <div className="grid gap-1.5">
          <p className="font-medium">Console</p>
          <pre className="max-h-40 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px]">{step.logs.join("\n")}</pre>
        </div>
      )}
      {handles.length > 0 &&
        handles.map(([h, items]) => (
          <div key={h} className="grid gap-1.5">
            <p className="font-medium">
              Output{handles.length > 1 || h !== "main" ? ` · ${h}` : ""}{" "}
              <span className="font-normal text-muted-foreground">({step.outputCounts[h] ?? items.length} items)</span>
            </p>
            {items.length ? <JsonView value={items.map((i) => i.json)} label={`Output ${h}`} /> : <p className="text-muted-foreground">No items</p>}
          </div>
        ))}
      <details>
        <summary className="cursor-pointer font-medium">Input</summary>
        <JsonView className="mt-1.5" value={step.input.map((i) => i.json)} label="Input" />
      </details>
    </div>
  );
}
import { NodeIcon } from "./node-visuals";
import { NativeSelect, ParamFieldView } from "./param-fields";

export function ConfigPanel() {
  const store = useEditorStoreApi();
  const openId = useEditor((s) => s.openNodeId);
  const graph = useEditor((s) => s.graph);
  const workflowId = useEditor((s) => s.workflowId);
  const run = useEditor((s) => s.run);
  const tab = useEditor((s) => s.panelTab);
  const node = openId ? graph.nodes.find((n) => n.id === openId) : undefined;
  const def = node ? getDefinition(node.type) : undefined;
  const steps = useMemo(() => latestSteps(run), [run]);
  const step = node ? steps[node.id] : undefined;

  const varsQ = useQuery({
    queryKey: ["variables"],
    queryFn: async () => {
      const res = await fetch("/api/workspace/variables");
      if (!res.ok) return [];
      return ((await res.json()) as { variables: Array<{ name: string; secret: boolean; value: string | null }> }).variables;
    },
    staleTime: 60_000,
  });
  const aiProvider = useEditor((s) => s.ai.provider);
  const sources = useMemo(() => {
    if (!node) return [];
    const vars = variablesSource(varsQ.data ?? []);
    return [...dataSourcesFor(graph, node.id, steps), ...(vars ? [vars] : [])];
  }, [graph, node, steps, varsQ.data]);
  const ctx = useMemo(() => resolveContextFor(sources), [sources]);
  const issues = useMemo(() => (node ? nodeIssues(graph, node) : []), [graph, node]);

  return (
    <AnimatePresence>
      {node && (
        <motion.aside
          key="panel"
          aria-label={`Configure ${node.label}`}
          initial={{ x: 24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 24, opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="absolute inset-0 z-20 flex flex-col border-l bg-background sm:static sm:z-auto sm:w-[420px] sm:shrink-0"
          onKeyDown={(e) => {
            if (e.key === "Escape") store.getState().openNode(null);
          }}
        >
          <header className="flex items-center gap-3 border-b px-4 py-3">
            <NodeIcon def={def} />
            <div className="min-w-0 flex-1">
              <Input
                aria-label="Step name"
                value={node.label}
                onChange={(e) => store.getState().updateNode(node.id, { label: e.target.value })}
                onBlur={(e) => {
                  if (!e.target.value.trim()) store.getState().updateNode(node.id, { label: def?.name ?? "Step" });
                }}
                className="h-8 border-transparent px-1 text-base font-medium shadow-none hover:border-input focus-visible:border-ring dark:bg-transparent"
              />
              <p className="px-1 text-xs text-muted-foreground">{def?.name ?? node.type}</p>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={() => store.getState().openNode(null)}>
              <XIcon />
            </Button>
          </header>

          <Tabs
            value={tab}
            onValueChange={(v) => store.setState({ panelTab: v as typeof tab })}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <TabsList className="mx-4 mt-3 w-auto">
              <TabsTrigger value="parameters">Parameters</TabsTrigger>
              <TabsTrigger value="output">
                Output
                {step && (
                  <span
                    className={cn(
                      "ml-1 size-1.5 rounded-full",
                      step.status === "success" ? "bg-success" : step.status === "failed" ? "bg-destructive" : "bg-warning",
                    )}
                  />
                )}
              </TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="output" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {step ? <StepOutput step={step} /> : (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Run a test to see the data this step receives and produces.
                </p>
              )}
            </TabsContent>
            <TabsContent value="parameters" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {def ? (
                <div className="grid gap-5">
                  <p className="text-sm text-muted-foreground">{def.description}</p>
                  {def.fields.length === 0 && (
                    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">This step has no settings.</p>
                  )}
                  {def.fields
                    .filter((f) => isFieldVisible(f, node.parameters))
                    .map((f) =>
                      // The model picker lists Claude models; a local model ignores it, so say what's used instead.
                      f.name === "model" && def.requiresAi && aiProvider !== "anthropic" ? (
                        <p key={f.name} className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                          {aiProvider === "ollama" ? "Uses your local AI model (set with OLLAMA_MODEL on the server)." : "Uses the AI model set up on this server."}
                        </p>
                      ) : (
                      <ParamFieldView
                        key={f.name}
                        field={f}
                        value={node.parameters[f.name]}
                        onChange={(v) => store.getState().setParameter(node.id, f.name, v)}
                        error={issues.find((i) => i.field === f.name)?.message}
                        sources={sources}
                        ctx={ctx}
                        workflowId={workflowId}
                        params={node.parameters}
                      />
                      ),
                    )}
                </div>
              ) : (
                <p className="text-sm text-destructive">This step type is not available.</p>
              )}
            </TabsContent>
            <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div className="grid gap-5">
                <div className="flex items-start justify-between gap-3">
                  <Label htmlFor="node-disabled" className="grid gap-1 font-normal">
                    <span className="font-medium">Skip this step</span>
                    <span className="text-xs text-muted-foreground">Items pass through unchanged while disabled.</span>
                  </Label>
                  <Switch
                    id="node-disabled"
                    checked={node.disabled === true}
                    onCheckedChange={(c) => store.getState().updateNode(node.id, { disabled: Boolean(c) })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="node-onerror">If this step fails</Label>
                  <NativeSelect
                    id="node-onerror"
                    value={node.onError ?? "stop"}
                    onChange={(e) => store.getState().updateNode(node.id, { onError: e.target.value as "stop" | "continue" })}
                  >
                    <option value="stop">Stop the workflow</option>
                    <option value="continue">Continue with the next step</option>
                  </NativeSelect>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="node-notes">Notes</Label>
                  <Textarea
                    id="node-notes"
                    rows={4}
                    placeholder="Why this step exists, for whoever edits it next"
                    value={node.notes ?? ""}
                    onChange={(e) => store.getState().updateNode(node.id, { notes: e.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Step ID</Label>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">{node.id}</code>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="Copy step ID"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(node.id);
                          toast.success("Step ID copied");
                        } catch {
                          toast.error("Couldn't copy. Select the ID and copy it manually.");
                        }
                      }}
                    >
                      <CopyIcon />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">Later steps reference this step&apos;s data by its ID.</p>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <footer className="flex justify-between gap-2 border-t px-4 py-3">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                store.getState().deleteElements([node.id], []);
                toast("Step deleted", {
                  action: { label: "Undo", onClick: () => store.getState().undo() },
                });
              }}
            >
              <Trash2Icon data-icon="inline-start" /> Delete step
            </Button>
            <Button variant="outline" size="sm" onClick={() => store.getState().duplicateNodes([node.id])}>
              <CopyIcon data-icon="inline-start" /> Duplicate
            </Button>
          </footer>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
