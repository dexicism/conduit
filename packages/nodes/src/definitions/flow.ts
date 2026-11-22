import type { NodeDefinition, SwitchCase } from "../types";

export const ifNode: NodeDefinition = {
  type: "flow.if",
  version: 1,
  name: "If",
  description: "Send each item down the true or false branch based on conditions.",
  category: "flow",
  icon: "Split",
  color: "sky",
  keywords: ["condition", "branch", "else", "check"],
  inputs: [{ id: "main" }],
  outputs: [
    { id: "true", label: "true" },
    { id: "false", label: "false" },
  ],
  fields: [{ kind: "conditions", name: "conditions", label: "Conditions", required: true }],
  outputSample: {},
};

export const filterNode: NodeDefinition = {
  type: "flow.filter",
  version: 1,
  name: "Filter",
  description: "Keep only the items that match the conditions. Others are dropped.",
  category: "flow",
  icon: "Filter",
  color: "sky",
  keywords: ["where", "only", "remove", "keep"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  fields: [{ kind: "conditions", name: "conditions", label: "Keep items where", required: true }],
  outputSample: {},
};

export const onlyNewNode: NodeDefinition = {
  type: "flow.onlyNew",
  version: 1,
  name: "Only new items",
  description: "Let through only items this step hasn't seen before, so a scheduled check doesn't repeat itself. Test runs don't remember anything.",
  category: "flow",
  icon: "Sparkles",
  color: "sky",
  keywords: ["dedupe", "duplicate", "new", "unique", "seen", "remember", "once", "changes"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  fields: [
    {
      kind: "string",
      name: "key",
      label: "What makes an item unique",
      required: true,
      default: "${['$input']['id']}",
      description: "Usually a link or an ID. Items with a key seen before are dropped.",
    },
    {
      kind: "select",
      name: "firstRun",
      label: "The very first live run",
      default: "skip",
      options: [
        { value: "skip", label: "Just remember what's there (good for watching a feed)" },
        { value: "pass", label: "Let everything through" },
      ],
    },
  ],
  outputSample: {},
};

export const switchNode: NodeDefinition = {
  type: "flow.switch",
  version: 1,
  name: "Switch",
  description: "Route each item to the branch whose value matches.",
  category: "flow",
  icon: "GitFork",
  color: "sky",
  keywords: ["route", "case", "router", "match"],
  inputs: [{ id: "main" }],
  outputs: (params) => {
    const cases = Array.isArray(params.cases) ? (params.cases as SwitchCase[]) : [];
    const outs = cases.map((c, i) => ({ id: `case-${c.id}`, label: c.label || c.value || `Case ${i + 1}` }));
    if (params.fallback !== false) outs.push({ id: "fallback", label: "fallback" });
    return outs;
  },
  fields: [
    {
      kind: "string",
      name: "value",
      label: "Value to match",
      required: true,
      placeholder: "${['$input']['type']}",
      description: "Usually a reference to a field from an earlier step.",
    },
    { kind: "cases", name: "cases", label: "Cases", required: true },
    {
      kind: "boolean",
      name: "fallback",
      label: "Add a fallback branch for unmatched items",
      default: true,
    },
  ],
  outputSample: {},
};

export const loopNode: NodeDefinition = {
  type: "flow.loop",
  version: 1,
  name: "Loop",
  description: "Run the steps on the loop branch once per element, then continue on done.",
  category: "flow",
  icon: "Repeat",
  color: "sky",
  keywords: ["for each", "iterate", "each", "batch", "repeat"],
  inputs: [{ id: "main" }],
  loopInputs: ["main"],
  outputs: [
    { id: "loop", label: "loop" },
    { id: "done", label: "done" },
  ],
  fields: [
    {
      kind: "select",
      name: "mode",
      label: "Loop over",
      default: "list",
      options: [
        { value: "list", label: "Each element of a list" },
        { value: "count", label: "A fixed number of times" },
      ],
    },
    {
      kind: "string",
      name: "list",
      label: "List",
      required: true,
      placeholder: "${['$input']['items']}",
      showIf: { field: "mode", equals: ["list"] },
    },
    {
      kind: "number",
      name: "count",
      label: "Times",
      default: 3,
      min: 1,
      max: 10000,
      required: true,
      expression: true,
      showIf: { field: "mode", equals: ["count"] },
    },
    {
      kind: "number",
      name: "batchSize",
      label: "Elements per iteration",
      default: 1,
      min: 1,
      max: 1000,
    },
  ],
  outputSample: { item: { example: "current element" }, index: 0, total: 3 },
};

export const mergeNode: NodeDefinition = {
  type: "flow.merge",
  version: 1,
  name: "Merge",
  description: "Wait for two branches and combine their items.",
  category: "flow",
  icon: "Merge",
  color: "sky",
  keywords: ["join", "combine", "wait for both", "zip"],
  inputs: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  outputs: [{ id: "main" }],
  fields: [
    {
      kind: "select",
      name: "mode",
      label: "Combine",
      default: "append",
      options: [
        { value: "append", label: "Append: all items from A, then B" },
        { value: "byPosition", label: "By position: pair item 1 with item 1, ..." },
        { value: "chooseA", label: "Pass through A once both arrive" },
      ],
    },
  ],
  outputSample: {},
};

export const waitNode: NodeDefinition = {
  type: "flow.wait",
  version: 1,
  name: "Wait",
  description: "Pause before continuing, for a duration or until a date and time.",
  category: "flow",
  icon: "Hourglass",
  color: "sky",
  keywords: ["delay", "sleep", "pause", "throttle"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  fields: [
    {
      kind: "select",
      name: "mode",
      label: "Wait",
      default: "duration",
      options: [
        { value: "duration", label: "For a duration" },
        { value: "until", label: "Until a date and time" },
      ],
    },
    {
      kind: "number",
      name: "amount",
      label: "Amount",
      default: 5,
      min: 0,
      max: 100000,
      required: true,
      expression: true,
      showIf: { field: "mode", equals: ["duration"] },
    },
    {
      kind: "select",
      name: "unit",
      label: "Unit",
      default: "seconds",
      options: [
        { value: "seconds", label: "Seconds" },
        { value: "minutes", label: "Minutes" },
        { value: "hours", label: "Hours" },
        { value: "days", label: "Days" },
      ],
      showIf: { field: "mode", equals: ["duration"] },
    },
    {
      kind: "string",
      name: "until",
      label: "Date and time",
      placeholder: "2026-12-31T09:00:00Z or a reference",
      required: true,
      showIf: { field: "mode", equals: ["until"] },
    },
  ],
  outputSample: {},
};
