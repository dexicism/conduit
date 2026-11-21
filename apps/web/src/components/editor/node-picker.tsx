"use client";

import { CATEGORY_LABELS, NODE_DEFINITIONS, TOOL_HANDLE, type NodeCategory } from "@conduit/nodes";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useApps } from "./apps-context";
import { useEditor, useEditorStoreApi } from "./context";
import { NodeIcon } from "./node-visuals";
import type { XY } from "./store";

const ORDER: NodeCategory[] = ["trigger", "ai", "tool", "app", "flow", "core", "transform"];

export function NodePicker({ fallbackPosition }: { fallbackPosition: () => XY }) {
  const store = useEditorStoreApi();
  const picker = useEditor((s) => s.picker);
  const aiEnabled = useEditor((s) => s.ai.enabled);
  const apps = useApps();
  const open = picker !== null;
  const forTools = picker?.from?.handle === TOOL_HANDLE;

  const defs = NODE_DEFINITIONS.filter((d) => {
    // AI steps and tools need a configured model; hide them rather than offer steps that can't run.
    if (!aiEnabled && (d.requiresAi || d.category === "tool")) return false;
    // App steps need that app to be connectable on this server (e.g. Google needs OAuth client keys).
    if (d.app && !apps.some((a) => a.id === d.app)) return false;
    if (forTools) return d.category === "tool";
    if (d.category === "tool") return false; // tools only attach to an agent's tool port
    if (picker?.triggersOnly) return d.category === "trigger";
    if (picker?.from) return d.category !== "trigger";
    return true;
  });

  const title = forTools ? "Add a tool" : picker?.triggersOnly ? "Choose a trigger" : "Add a step";

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => !o && store.getState().openPicker(null)}
      title={title}
      description="Search for a trigger or step to add to the workflow"
      className="sm:max-w-lg"
    >
      <Command
        label="Search steps"
        filter={(value, search, keywords) => {
          const hay = [value, ...(keywords ?? [])].join(" ").toLowerCase();
          return search
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean)
            .every((t) => hay.includes(t))
            ? 1
            : 0;
        }}
      >
        <CommandInput placeholder={forTools ? "Search tools…" : picker?.triggersOnly ? "Search triggers…" : "Search steps…"} aria-label="Search steps" />
        <CommandList className="max-h-[min(60vh,440px)]">
          <CommandEmpty>Nothing matches. Try another word.</CommandEmpty>
          {ORDER.map((cat) => {
            const items = defs.filter((d) => d.category === cat);
            if (!items.length) return null;
            return (
              <CommandGroup key={cat} heading={CATEGORY_LABELS[cat]}>
                {items.map((d) => (
                  <CommandItem
                    key={d.type}
                    value={`${d.name} ${d.type}`}
                    keywords={[d.description, ...(d.keywords ?? [])]}
                    onSelect={() => store.getState().addNode(d.type, picker, fallbackPosition())}
                    className="gap-3 py-2"
                  >
                    <NodeIcon def={d} size="sm" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{d.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{d.description}</p>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
