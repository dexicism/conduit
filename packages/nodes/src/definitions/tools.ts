import type { NodeDefinition, ParamField } from "../types";
import { AGENT_HANDLE, DEFAULT_MODEL, MODEL_OPTIONS } from "../types";

export const toolName = (def: string): ParamField => ({
  kind: "string",
  name: "toolName",
  label: "Tool name",
  default: def,
  required: true,
  expression: false,
  format: "tool-name",
  description: "Letters, digits, '_' or '-'. The agent sees this name.",
});

export const toolDescription = (def: string): ParamField => ({
  kind: "string",
  name: "toolDescription",
  label: "When to use it",
  default: def,
  required: true,
  multiline: true,
  expression: false,
  description: "Tell the agent what the tool does and when to call it.",
});

const base = {
  version: 1,
  category: "tool" as const,
  color: "slate" as const,
  inputs: [{ id: AGENT_HANDLE, label: "agent" }],
  outputs: [],
  outputSample: {},
};

export const AI_FILL_HINT =
  "Use ={{AI('name', `what it is`, 'string')}} for values the agent should fill in, e.g. a search term.";

export const httpTool: NodeDefinition = {
  ...base,
  type: "tool.http",
  name: "HTTP request tool",
  description: "Let the agent call an API. Mark the parts it should fill in.",
  icon: "Globe",
  keywords: ["api", "fetch", "lookup", "search"],
  fields: [
    toolName("lookup"),
    toolDescription("Look up information from our API."),
    {
      kind: "select",
      name: "method",
      label: "Method",
      default: "GET",
      options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m })),
    },
    { kind: "string", name: "url", label: "URL", required: true, aiFill: true, description: AI_FILL_HINT, placeholder: "https://api.example.com/orders/={{AI('orderId', `The order number`, 'string')}}" },
    { kind: "keyValue", name: "headers", label: "Headers" },
    { kind: "json", name: "jsonBody", label: "JSON body", default: "", showIf: { field: "method", equals: ["POST", "PUT", "PATCH", "DELETE"] } },
  ],
};

export const calculatorTool: NodeDefinition = {
  ...base,
  type: "tool.calculator",
  name: "Calculator",
  description: "Exact arithmetic for the agent: + − × ÷, powers, rounding and more.",
  icon: "Calculator",
  keywords: ["math", "compute", "arithmetic"],
  fields: [toolName("calculator"), toolDescription("Evaluate an arithmetic expression exactly, e.g. (12.5 * 3) / 4.")],
};

export const thinkTool: NodeDefinition = {
  ...base,
  type: "tool.think",
  name: "Think",
  description: "A scratchpad the agent can use to plan before acting.",
  icon: "Brain",
  keywords: ["plan", "reason", "scratchpad"],
  fields: [toolName("think"), toolDescription("Write down your reasoning or plan. Does not change anything.")],
};

export const workflowTool: NodeDefinition = {
  ...base,
  type: "tool.workflow",
  name: "Run workflow tool",
  description: "Let the agent run another workflow and use its result.",
  icon: "Workflow",
  keywords: ["sub-workflow", "call", "function"],
  fields: [
    toolName("run_workflow"),
    toolDescription("Run the workflow that handles this request."),
    { kind: "workflow", name: "workflowId", label: "Workflow", required: true, description: "It must start with “Called by another workflow”." },
    {
      kind: "json",
      name: "input",
      label: "Input (JSON)",
      default: '{\n  "request": "={{AI(\'request\', `What to pass to the workflow`, \'string\')}}"\n}',
      description: AI_FILL_HINT,
    },
  ],
};

export const codeTool: NodeDefinition = {
  ...base,
  type: "tool.code",
  name: "Code tool",
  description: "Let the agent run your JavaScript with a text input it chooses.",
  icon: "Code",
  keywords: ["javascript", "function", "script"],
  fields: [
    toolName("run_code"),
    toolDescription("Transform the given text."),
    {
      kind: "string",
      name: "inputDescription",
      label: "Describe the input",
      default: "The text to process",
      required: true,
      expression: false,
    },
    {
      kind: "code",
      name: "code",
      label: "JavaScript",
      language: "javascript",
      required: true,
      default: "// `item.input` is the text the agent passed in. Return an object.\nreturn { result: item.input.toUpperCase() };\n",
    },
  ],
};

export const subAgentTool: NodeDefinition = {
  ...base,
  type: "tool.subagent",
  name: "Sub-agent",
  description: "Hand a focused sub-task to a second agent with its own instructions.",
  icon: "BotMessageSquare",
  keywords: ["delegate", "specialist", "helper", "agent"],
  fields: [
    toolName("ask_specialist"),
    toolDescription("Ask a specialist to draft or review text."),
    { kind: "select", name: "model", label: "Model", default: DEFAULT_MODEL, options: MODEL_OPTIONS },
    { kind: "string", name: "instructions", label: "Instructions", multiline: true, required: true, expression: false },
  ],
};

/** Tool version of an app action: same fields, attached to an agent's tool port. Type is `tool.<action type>`. */
export function appActionTool(def: NodeDefinition): NodeDefinition {
  if (!def.asTool) throw new Error(`${def.type} has no tool variant`);
  return {
    ...base,
    type: `tool.${def.type}`,
    name: `${def.name} (tool)`,
    description: `Let the agent ${def.description.charAt(0).toLowerCase()}${def.description.slice(1)}`,
    icon: def.icon,
    app: def.app,
    keywords: [...(def.keywords ?? []), "tool"],
    fields: [
      toolName(def.asTool.name),
      toolDescription(def.asTool.description),
      ...def.fields.map((f): ParamField =>
        f.kind === "string" && f.expression !== false ? { ...f, aiFill: true, description: f.description ?? AI_FILL_HINT } : f,
      ),
    ],
  };
}
