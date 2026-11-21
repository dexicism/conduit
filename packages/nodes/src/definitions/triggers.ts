import type { NodeDefinition } from "../types";

function randomSlug(len = 16): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export const manualTrigger: NodeDefinition = {
  type: "trigger.manual",
  version: 1,
  name: "Manual start",
  description: "Start the workflow by hand from the editor. Useful while building and testing.",
  category: "trigger",
  icon: "MousePointerClick",
  color: "amber",
  keywords: ["click", "test", "run"],
  inputs: [],
  outputs: [{ id: "main" }],
  fields: [],
  outputSample: { startedAt: "2026-01-01T09:00:00.000Z" },
};

export const webhookTrigger: NodeDefinition = {
  type: "trigger.webhook",
  version: 1,
  name: "Webhook",
  description: "Start when an HTTP request arrives at this workflow's unique URL.",
  category: "trigger",
  icon: "Webhook",
  color: "amber",
  keywords: ["http", "api", "endpoint", "request"],
  inputs: [],
  outputs: [{ id: "main" }],
  initParameters: () => ({ path: randomSlug() }),
  fields: [
    {
      kind: "select",
      name: "method",
      label: "HTTP method",
      default: "POST",
      options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m })),
    },
    {
      kind: "string",
      name: "path",
      label: "Path",
      required: true,
      expression: false,
      format: "path-segment",
      description: "The last part of the URL. Letters, digits, '-' and '_' only.",
    },
    {
      kind: "select",
      name: "respond",
      label: "Respond",
      default: "immediately",
      options: [
        { value: "immediately", label: "Immediately with 202 Accepted" },
        { value: "respondNode", label: "From a Respond node in the workflow" },
      ],
    },
    {
      kind: "select",
      name: "auth",
      label: "Authentication",
      default: "none",
      options: [
        { value: "none", label: "None (URL is the secret)" },
        { value: "header", label: "Require a header value" },
      ],
    },
    {
      kind: "string",
      name: "authHeaderName",
      label: "Header name",
      default: "x-api-key",
      required: true,
      expression: false,
      showIf: { field: "auth", equals: ["header"] },
    },
    {
      kind: "string",
      name: "authHeaderValue",
      label: "Expected value",
      required: true,
      expression: false,
      showIf: { field: "auth", equals: ["header"] },
    },
  ],
  outputSample: {
    method: "POST",
    headers: { "content-type": "application/json" },
    query: { source: "website" },
    body: { email: "lead@example.com", name: "Sam Lee", message: "Interested in a demo" },
  },
};

export const scheduleTrigger: NodeDefinition = {
  type: "trigger.schedule",
  version: 1,
  name: "Schedule",
  description: "Start on a repeating interval or a cron schedule.",
  category: "trigger",
  icon: "Clock",
  color: "amber",
  keywords: ["cron", "timer", "interval", "daily", "hourly"],
  inputs: [],
  outputs: [{ id: "main" }],
  fields: [
    {
      kind: "select",
      name: "mode",
      label: "Repeat",
      default: "interval",
      options: [
        { value: "interval", label: "Every fixed interval" },
        { value: "cron", label: "Cron expression" },
      ],
    },
    {
      kind: "number",
      name: "every",
      label: "Every",
      default: 1,
      min: 1,
      max: 1000,
      required: true,
      showIf: { field: "mode", equals: ["interval"] },
    },
    {
      kind: "select",
      name: "unit",
      label: "Unit",
      default: "hours",
      options: [
        { value: "minutes", label: "Minutes" },
        { value: "hours", label: "Hours" },
        { value: "days", label: "Days" },
        { value: "weeks", label: "Weeks" },
      ],
      showIf: { field: "mode", equals: ["interval"] },
    },
    {
      kind: "string",
      name: "cron",
      label: "Cron expression",
      placeholder: "0 9 * * 1-5",
      description: "Five fields: minute hour day-of-month month day-of-week.",
      required: true,
      expression: false,
      format: "cron",
      showIf: { field: "mode", equals: ["cron"] },
    },
    {
      kind: "string",
      name: "timezone",
      label: "Time zone",
      default: "UTC",
      expression: false,
      placeholder: "e.g. Asia/Jakarta",
    },
  ],
  outputSample: { firedAt: "2026-01-01T09:00:00.000Z", timezone: "UTC" },
};

export const subworkflowTrigger: NodeDefinition = {
  type: "trigger.subworkflow",
  version: 1,
  name: "Called by another workflow",
  description: "Start when another workflow runs this one with an Execute workflow step.",
  category: "trigger",
  icon: "LogIn",
  color: "amber",
  keywords: ["function", "reuse", "module", "execute"],
  inputs: [],
  outputs: [{ id: "main" }],
  fields: [],
  outputSample: { input: { example: "Data passed by the calling workflow" } },
};

export const errorTrigger: NodeDefinition = {
  type: "trigger.error",
  version: 1,
  name: "On workflow error",
  description: "Start when a workflow that names this one as its error handler fails.",
  category: "trigger",
  icon: "TriangleAlert",
  color: "amber",
  keywords: ["failure", "alert", "fallback", "exception"],
  inputs: [],
  outputs: [{ id: "main" }],
  fields: [],
  outputSample: {
    workflow: { id: "665f1c2e9b1e4a0012ab34cd", name: "Lead router" },
    execution: { id: "665f1c2e9b1e4a0012ab34ce", startedAt: "2026-01-01T09:00:00.000Z" },
    error: { nodeId: "node-http", message: "Request failed with status 500" },
  },
};

export const formTrigger: NodeDefinition = {
  type: "trigger.form",
  version: 1,
  name: "Form",
  description: "Start when someone submits a hosted form. Publish to get its public link.",
  category: "trigger",
  icon: "ClipboardList",
  color: "amber",
  keywords: ["form", "survey", "submit", "lead", "signup", "page"],
  inputs: [],
  outputs: [{ id: "main" }],
  initParameters: () => ({ path: randomSlug() }),
  fields: [
    { kind: "string", name: "title", label: "Form title", required: true, default: "Contact us", expression: false },
    { kind: "string", name: "description", label: "Description", multiline: true, expression: false },
    { kind: "formFields", name: "questions", label: "Questions", required: true },
    { kind: "string", name: "submitLabel", label: "Button text", default: "Submit", expression: false },
    { kind: "string", name: "successMessage", label: "After submitting", default: "Thanks! We got your response.", multiline: true, expression: false },
    {
      kind: "string",
      name: "path",
      label: "Link path",
      required: true,
      expression: false,
      format: "path-segment",
      description: "The form lives at /form/<path> once published.",
    },
  ],
  outputSample: { fields: { name: "Ana", email: "ana@example.com" }, submittedAt: "2026-01-01T09:00:00.000Z" },
};
