import type { NodeDefinition } from "../types";

export const httpRequestNode: NodeDefinition = {
  type: "core.http",
  version: 1,
  name: "HTTP request",
  description: "Call any API or URL and use the response in later steps.",
  category: "core",
  icon: "Globe",
  color: "indigo",
  keywords: ["api", "rest", "fetch", "get", "post", "url", "call"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  fields: [
    {
      kind: "select",
      name: "method",
      label: "Method",
      default: "GET",
      options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m })),
    },
    { kind: "string", name: "url", label: "URL", required: true, placeholder: "https://api.example.com/v1/items", format: "url" },
    {
      kind: "select",
      name: "authentication",
      label: "Authentication",
      default: "none",
      options: [
        { value: "none", label: "None, or headers below" },
        { value: "credential", label: "Saved API key" },
      ],
    },
    { kind: "credential", name: "credential", label: "API key", app: "httpHeader", required: true, showIf: { field: "authentication", equals: ["credential"] } },
    { kind: "keyValue", name: "query", label: "Query parameters", keyPlaceholder: "name", valuePlaceholder: "value" },
    { kind: "keyValue", name: "headers", label: "Headers", keyPlaceholder: "Authorization", valuePlaceholder: "Bearer ..." },
    {
      kind: "select",
      name: "bodyType",
      label: "Body",
      default: "json",
      options: [
        { value: "none", label: "No body" },
        { value: "json", label: "JSON" },
        { value: "form", label: "Form (URL-encoded)" },
        { value: "text", label: "Raw text" },
      ],
      showIf: { field: "method", equals: ["POST", "PUT", "PATCH", "DELETE"] },
    },
    {
      kind: "json",
      name: "jsonBody",
      label: "JSON body",
      default: "{\n  \n}",
      showIf: { field: "bodyType", equals: ["json"] },
    },
    { kind: "keyValue", name: "formBody", label: "Form fields", showIf: { field: "bodyType", equals: ["form"] } },
    { kind: "string", name: "textBody", label: "Text body", multiline: true, showIf: { field: "bodyType", equals: ["text"] } },
    { kind: "number", name: "timeoutSeconds", label: "Timeout (seconds)", default: 30, min: 1, max: 300 },
    {
      kind: "boolean",
      name: "failOnErrorStatus",
      label: "Fail the step on 4xx/5xx responses",
      default: true,
    },
  ],
  outputSample: { status: 200, headers: { "content-type": "application/json" }, body: { id: 123, ok: true } },
};

export const codeNode: NodeDefinition = {
  type: "core.code",
  version: 1,
  name: "Code",
  description: "Run JavaScript to transform items when the built-in steps aren't enough.",
  category: "core",
  icon: "Code",
  color: "indigo",
  keywords: ["javascript", "js", "script", "function", "custom"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  fields: [
    {
      kind: "select",
      name: "mode",
      label: "Run",
      default: "perItem",
      options: [
        { value: "perItem", label: "Once per item (`item` is available)" },
        { value: "all", label: "Once for all items (`items` is available)" },
      ],
    },
    {
      kind: "code",
      name: "code",
      label: "JavaScript",
      language: "javascript",
      required: true,
      default:
        "// `item` is the current item's data. Return an object (or an array of objects).\nreturn {\n  ...item,\n  processedAt: new Date().toISOString(),\n};\n",
    },
  ],
  outputSample: { processedAt: "2026-01-01T09:00:00.000Z" },
};

export const setFieldsNode: NodeDefinition = {
  type: "core.set",
  version: 1,
  name: "Set fields",
  description: "Add, rename or compute fields on each item.",
  category: "core",
  icon: "SquarePen",
  color: "indigo",
  keywords: ["edit", "assign", "map", "rename", "fields", "transform"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  fields: [
    { kind: "assignments", name: "assignments", label: "Fields", required: true },
    {
      kind: "boolean",
      name: "keepOthers",
      label: "Keep the item's other fields",
      default: true,
    },
  ],
  outputSample: {},
};

export const respondNode: NodeDefinition = {
  type: "core.respond",
  version: 1,
  name: "Respond to webhook",
  description: "Send the HTTP response for a webhook that waits for the workflow.",
  category: "core",
  icon: "Reply",
  color: "indigo",
  keywords: ["return", "response", "reply", "http"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  fields: [
    { kind: "number", name: "status", label: "Status code", default: 200, min: 100, max: 599 },
    { kind: "keyValue", name: "headers", label: "Headers" },
    { kind: "json", name: "body", label: "Body (JSON)", default: '{\n  "ok": true\n}' },
  ],
  outputSample: {},
};

export const executeWorkflowNode: NodeDefinition = {
  type: "core.execute-workflow",
  version: 1,
  name: "Execute workflow",
  description: "Run another workflow like a function and use what it returns.",
  category: "core",
  icon: "Workflow",
  color: "indigo",
  keywords: ["sub-workflow", "call", "function", "reuse", "module"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  fields: [
    {
      kind: "workflow",
      name: "workflowId",
      label: "Workflow",
      required: true,
      description: "The workflow must start with “Called by another workflow”.",
    },
    { kind: "json", name: "input", label: "Input (JSON)", default: "{}" },
    { kind: "boolean", name: "waitForResult", label: "Wait for it to finish and return its output", default: true },
  ],
  outputSample: { result: { example: "Output of the called workflow" } },
};
