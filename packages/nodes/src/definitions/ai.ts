import type { NodeDefinition, ParamField, SwitchCase } from "../types";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "../types";

const model: ParamField = { kind: "select", name: "model", label: "Model", default: DEFAULT_MODEL, options: MODEL_OPTIONS };
const text = (label = "Text"): ParamField => ({
  kind: "string",
  name: "text",
  label,
  required: true,
  multiline: true,
  placeholder: "${['$input']['message']}",
});
const image: ParamField = {
  kind: "string",
  name: "image",
  label: "Image",
  placeholder: "${['$input']['media']['id']}",
  description: "Optional. A photo or screenshot for the model to read: a WhatsApp media ID, or base64 / a data: URL. Needs a model that can see images (Gemini and Claude can). With Gemini, voice notes and PDFs work too; other files are skipped.",
};
const outputField: ParamField = { kind: "string", name: "outputField", label: "Save result as", default: "ai", required: true, expression: false };

export const agentNode: NodeDefinition = {
  type: "ai.agent",
  version: 1,
  name: "AI Agent",
  description: "Let the AI work through a task, calling the tools you connect, then answer.",
  category: "ai",
  icon: "Bot",
  color: "violet",
  keywords: ["llm", "claude", "assistant", "chat", "reason", "tools", "gpt"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  toolPort: true,
  requiresAi: true,
  fields: [
    model,
    {
      kind: "string",
      name: "instructions",
      label: "Instructions",
      multiline: true,
      placeholder: "You are a support assistant for Acme. Answer briefly and politely.",
      description: "How the agent should behave. Applies to every item.",
    },
    {
      kind: "string",
      name: "prompt",
      label: "Task or message",
      required: true,
      multiline: true,
      placeholder: "${['$input']['body']['message']}",
      description: "What to do for each item. Usually the incoming message.",
    },
    image,
    {
      kind: "select",
      name: "effort",
      label: "Effort",
      default: "medium",
      options: [
        { value: "low", label: "Low: quick replies" },
        { value: "medium", label: "Medium: balanced" },
        { value: "high", label: "High: careful multi-step work" },
      ],
    },
    { kind: "number", name: "maxIterations", label: "Max tool rounds", default: 10, min: 1, max: 25 },
    {
      kind: "select",
      name: "memory",
      label: "Memory",
      default: "none",
      options: [
        { value: "none", label: "None: every item is independent" },
        { value: "window", label: "Remember recent turns of a conversation" },
        { value: "shared", label: "Shared with the whole workspace (same person, any workflow)" },
      ],
    },
    {
      kind: "string",
      name: "sessionKey",
      label: "Conversation ID",
      required: true,
      placeholder: "${['$input']['body']['chatId']}",
      description: "Items with the same ID share memory, e.g. a chat or customer ID.",
      showIf: { field: "memory", equals: ["window", "shared"] },
    },
    { kind: "number", name: "memoryTurns", label: "Turns to remember", default: 10, min: 1, max: 50, showIf: { field: "memory", equals: ["window", "shared"] }, description: "How many recent exchanges are sent to the model with each message." },
    {
      kind: "number",
      name: "memoryKeepDays",
      label: "Keep the chat for (days)",
      default: 0,
      min: 0,
      max: 30,
      showIf: { field: "memory", equals: ["window", "shared"] },
      description: "0 = only the recent exchanges. With days set, the whole chat from those days is stored and the agent gets a tool to search it, while only the recent exchanges are sent each time (so cost doesn't grow).",
    },
  ],
  outputSample: { output: "Your order #1042 shipped yesterday and arrives Friday.", toolCalls: 2 },
};

export const classifyNode: NodeDefinition = {
  type: "ai.classify",
  version: 1,
  name: "Classify text",
  description: "Sort each item into one of your categories, with a branch per category.",
  category: "ai",
  icon: "Tags",
  color: "violet",
  keywords: ["categorize", "intent", "route", "label", "tag", "triage"],
  inputs: [{ id: "main" }],
  outputs: (params) => {
    const cats = Array.isArray(params.categories) ? (params.categories as SwitchCase[]) : [];
    const outs = cats.map((c, i) => ({ id: `case-${c.id}`, label: c.value || `Category ${i + 1}` }));
    if (params.allowOther !== false) outs.push({ id: "other", label: "other" });
    return outs;
  },
  requiresAi: true,
  fields: [
    model,
    text(),
    { kind: "cases", name: "categories", label: "Categories", required: true },
    { kind: "string", name: "guidance", label: "Extra guidance", multiline: true, placeholder: "Refund requests count as billing." },
    { kind: "boolean", name: "allowOther", label: "Send items that fit no category to “other”", default: true },
  ],
  outputSample: { category: "billing", confidence: 0.92 },
};

export const sentimentNode: NodeDefinition = {
  type: "ai.sentiment",
  version: 1,
  name: "Sentiment",
  description: "Tell whether text is positive, neutral or negative, with a confidence score.",
  category: "ai",
  icon: "Smile",
  color: "violet",
  keywords: ["tone", "feeling", "mood", "feedback", "review"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  requiresAi: true,
  fields: [model, text(), outputField],
  outputSample: { ai: { sentiment: "positive", confidence: 0.87, explanation: "Thanks the team and praises the fast reply." } },
};

export const moderateNode: NodeDefinition = {
  type: "ai.moderate",
  version: 1,
  name: "Moderate content",
  description: "Flag abusive, harmful or off-policy text and route it separately.",
  category: "ai",
  icon: "ShieldCheck",
  color: "violet",
  keywords: ["safety", "abuse", "spam", "filter", "guardrail", "toxicity"],
  inputs: [{ id: "main" }],
  outputs: [
    { id: "allowed", label: "allowed" },
    { id: "flagged", label: "flagged" },
  ],
  requiresAi: true,
  fields: [
    model,
    text(),
    {
      kind: "string",
      name: "policy",
      label: "Also flag",
      multiline: true,
      placeholder: "Messages that share phone numbers or ask for payment outside the platform.",
      description: "Optional rules on top of the standard categories (harassment, hate, violence, sexual content, self-harm, spam).",
    },
    outputField,
  ],
  outputSample: { ai: { flagged: false, categories: [], reason: "No policy concerns." } },
};

export const extractNode: NodeDefinition = {
  type: "ai.extract",
  version: 1,
  name: "Extract data",
  description: "Pull structured fields out of free text or a picture (a bill, a screenshot, a business card), like names, dates and amounts.",
  category: "ai",
  icon: "ScanText",
  color: "violet",
  keywords: ["parse", "structured", "fields", "entities", "json", "information"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  requiresAi: true,
  fields: [
    model,
    { ...text(), required: false, description: "The text to read. Can be empty when there's an image." },
    image,
    {
      kind: "assignments",
      name: "fields",
      label: "Fields to extract",
      required: true,
      description: "For each field, describe what to find in the value box.",
    },
    outputField,
  ],
  outputSample: { ai: { name: "Sam Lee", company: "Northwind", budget: 12000 } },
};
