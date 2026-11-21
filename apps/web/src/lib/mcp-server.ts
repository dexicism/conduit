import "server-only";
import { FINAL_STATUSES } from "@conduit/core";
import { getDefinition } from "@conduit/nodes";
import { BUILDER_TOOLS, createBuilderSession, triggerItemsFor } from "@conduit/runtime";
import { ObjectId } from "mongodb";
import { ApiError } from "./api";
import type { ApiScope, KeyContext } from "./api-keys";
import { rt } from "./runtime";
import { createWorkflow, getWorkflow, listWorkflows, saveDraft } from "./workflows-repo";

/**
 * MCP server (protocol 2025-06-18, Streamable HTTP with JSON responses).
 * Tools read workflows and edit drafts only: nothing here publishes or deletes.
 */

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface Tool {
  name: string;
  description: string;
  scope: ApiScope;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: KeyContext): Promise<unknown>;
}

const str = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v.trim()) throw new ApiError(400, "validation_failed", `${name} is required`);
  return v.trim();
};

function builderSchema(name: string) {
  return BUILDER_TOOLS.find((t) => t.name === name)!.inputSchema;
}

const TOOLS: Tool[] = [
  {
    name: "list_workflows",
    description: "List workflows in the workspace (newest first). Optional text search.",
    scope: "workflows:read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
    async run(args, ctx) {
      const page = await listWorkflows(ctx.workspace.workspaceId, { filter: "active", limit: 50, ...(typeof args.query === "string" && args.query ? { q: args.query } : {}) });
      return page.data.map((w) => ({ id: w.id, name: w.name, status: w.status, revision: w.revision, updatedAt: w.updatedAt }));
    },
  },
  {
    name: "get_workflow",
    description: "Get a workflow's draft: its steps, parameters and connections, plus the revision to pass to apply_changes.",
    scope: "workflows:read",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" } }, required: ["workflowId"], additionalProperties: false },
    async run(args, ctx) {
      const wf = await getWorkflow(ctx.workspace.workspaceId, str(args.workflowId, "workflowId"));
      return { id: wf.id, name: wf.name, status: wf.status, revision: wf.revision, draft: wf.draft };
    },
  },
  {
    name: "find_steps",
    description: "Search the available step types by keyword. Returns type, name, category and description.",
    scope: "workflows:read",
    inputSchema: builderSchema("find_steps"),
    async run(args) {
      return JSON.parse(createBuilderSession({ nodes: [] } as never).handle("find_steps", args).content);
    },
  },
  {
    name: "describe_step",
    description: "Get the exact parameters, handles, value shapes and example output of one step type.",
    scope: "workflows:read",
    inputSchema: builderSchema("describe_step"),
    async run(args) {
      const r = createBuilderSession({ nodes: [] } as never).handle("describe_step", args);
      if (r.isError) throw new ApiError(400, "validation_failed", r.content);
      return JSON.parse(r.content);
    },
  },
  {
    name: "create_workflow",
    description: "Create an empty workflow (a draft). Add steps with apply_changes.",
    scope: "workflows:write",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, description: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { workflow } = await createWorkflow(ctx.workspace.workspaceId, ctx.actorId, {
        name: str(args.name, "name").slice(0, 150),
        description: typeof args.description === "string" ? args.description.slice(0, 2000) : undefined,
      });
      return { id: workflow.id, name: workflow.name, revision: workflow.revision };
    },
  },
  {
    name: "apply_changes",
    description:
      "Validate and save edits to a workflow's draft (never the live version): add steps (nodes), update steps (updates) and delete steps (deleted). Pass expectedRevision from get_workflow. Returns errors to fix, or the new revision.",
    scope: "workflows:write",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string" }, expectedRevision: { type: "number" }, ...((builderSchema("save_changes").properties as object) ?? {}) },
      required: ["workflowId", "expectedRevision"],
    },
    async run(args, ctx) {
      const wf = await getWorkflow(ctx.workspace.workspaceId, str(args.workflowId, "workflowId"));
      if (args.expectedRevision !== wf.revision) {
        throw new ApiError(409, "revision_conflict", `The draft is at revision ${wf.revision}. Call get_workflow and try again.`);
      }
      const session = createBuilderSession(wf.draft);
      const r = session.handle("save_changes", { response: "Changes from an MCP client", ...args });
      if (r.isError) return { saved: false, error: r.content };
      const saved = await saveDraft(ctx.workspace.workspaceId, ctx.actorId, wf.id, wf.revision, session.graph());
      return { saved: true, revision: saved.revision, summary: session.applied()?.summary, message: r.content };
    },
  },
  {
    name: "test_workflow",
    description: "Run the draft once in test mode (free) from its Manual trigger, and return the result of each step. Waits up to 25 seconds.",
    scope: "executions:run",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" } }, required: ["workflowId"], additionalProperties: false },
    async run(args, ctx) {
      const wf = await getWorkflow(ctx.workspace.workspaceId, str(args.workflowId, "workflowId"));
      const triggers = wf.draft.nodes.filter((n) => getDefinition(n.type)?.category === "trigger" && !n.disabled);
      const trigger = triggers.find((n) => n.type === "trigger.manual") ?? triggers.find((n) => n.type !== "trigger.webhook");
      if (!trigger) throw new ApiError(400, "invalid_request", "Add a Manual trigger to test this workflow");
      const { runtime, executions } = rt();
      const id = await runtime.createExecution(
        {
          workspaceId: ctx.workspace.workspaceId,
          workflowId: new ObjectId(wf.id),
          workflowName: wf.name,
          versionId: null,
          mode: "test",
          graph: wf.draft,
          triggerNodeId: trigger.id,
          triggerItems: triggerItemsFor(trigger.type, new Date(), trigger.parameters),
        },
        true,
      );
      const deadline = Date.now() + 25_000;
      for (;;) {
        const d = await executions.get(ctx.workspace.workspaceId, id.toHexString());
        if (d && (FINAL_STATUSES.includes(d.status) || d.status === "waiting" || Date.now() > deadline)) {
          return {
            executionId: d.id,
            status: d.status,
            error: d.error,
            steps: d.steps.map((s) => ({ nodeId: s.nodeId, label: s.label, status: s.status, error: s.error, output: s.output })),
          };
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    },
  },
  {
    name: "get_execution",
    description: "Get one run: status, error, and each step's input and output.",
    scope: "executions:read",
    inputSchema: { type: "object", properties: { executionId: { type: "string" } }, required: ["executionId"], additionalProperties: false },
    async run(args, ctx) {
      const d = await rt().executions.get(ctx.workspace.workspaceId, str(args.executionId, "executionId"));
      if (!d) throw new ApiError(404, "not_found", "Run not found");
      return d;
    },
  },
];

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type RpcResult = { result: unknown } | { error: { code: number; message: string } };

/** Handles one JSON-RPC message. Returns null for notifications. */
export async function handleMcp(msg: JsonRpcRequest, ctx: KeyContext): Promise<RpcResult | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return {
        result: {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "conduit", title: "Conduit", version: "0.1.0" },
          instructions:
            "Conduit workflows. Use find_steps and describe_step to learn step types, get_workflow for the current draft and its revision, then apply_changes to edit the draft and test_workflow to try it. Publishing happens in the Conduit editor, not here.",
        },
      };
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return { result: {} };
    case "tools/list":
      return {
        result: {
          tools: TOOLS.filter((t) => ctx.scopes.includes(t.scope)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return { error: { code: -32602, message: `Unknown tool ${String(msg.params?.name)}` } };
      if (!ctx.scopes.includes(tool.scope)) {
        return { result: { isError: true, content: [{ type: "text", text: `This connection doesn't have the ${tool.scope} permission` }] } };
      }
      try {
        const out = await tool.run((msg.params?.arguments as Record<string, unknown>) ?? {}, ctx);
        return { result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: Array.isArray(out) ? { items: out } : out } };
      } catch (err) {
        const message = err instanceof ApiError || (err as Error)?.name === "StepError" ? (err as Error).message : "Something went wrong running that tool";
        if (!(err instanceof ApiError)) console.error("[mcp] tool failed", err);
        return { result: { isError: true, content: [{ type: "text", text: message }] } };
      }
    }
    default:
      return isNotification ? null : { error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}
