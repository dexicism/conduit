import { aiFillSchema, collectAiFills, fillAiPlaceholders, resolveParameters, type WorkflowNode } from "@conduit/core";
import { DEFAULT_MODEL, toolsOfAgent, type Assignment, type SwitchCase } from "@conduit/nodes";
import { calculate } from "../calc";
import type { ExecContext, Executor, Item, LlmBlock, LlmMessage, LlmRequest, LlmResult, LlmService, LlmTool } from "../types";
import { StepError } from "../types";
import { parseJsonParam, toNumber, toText } from "../values";
import { APP_ACTIONS } from "./apps";
import { performHttp } from "./core";

const MAX_TOOL_OUTPUT = 20_000;

function requireLlm(ctx: ExecContext): LlmService {
  if (!ctx.services.llm) throw new StepError("AI isn't configured on this server. Ask an admin to add a model API key.");
  return ctx.services.llm;
}

function textOf(blocks: LlmBlock[]): string {
  return blocks
    .filter((b): b is Extract<LlmBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function checkStop(res: LlmResult) {
  if (res.stopReason === "refusal") throw new StepError("The model declined to process this item");
  if (res.stopReason === "max_tokens") throw new StepError("The model's answer was cut off (too long)");
}

function modelOf(p: Record<string, unknown>): string {
  return toText(p.model) || DEFAULT_MODEL;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The step's Image field as a picture for the model: a stored media ID, a data: URL, or raw base64. */
async function imageBlocks(ctx: ExecContext, p: Record<string, unknown>): Promise<LlmBlock[]> {
  const v = toText(p.image).trim();
  if (!v) return [];
  let mimetype = "image/jpeg";
  let base64 = v;
  if (/^[a-f\d]{24}$/i.test(v)) {
    const m = await ctx.services.integrations?.whatsappWeb?.readMedia(v);
    if (!m) throw new StepError("That image isn't stored anymore (files are kept for 30 days) or belongs to another workspace");
    mimetype = m.mimetype;
    base64 = m.base64;
  } else {
    const d = /^data:([^;,]+);base64,([\s\S]*)$/.exec(v);
    if (d) {
      mimetype = d[1]!;
      base64 = d[2]!;
    } else if (v.startsWith("iVBOR")) mimetype = "image/png";
    else if (v.startsWith("UklGR")) mimetype = "image/webp";
    if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) throw new StepError("Image: use a media ID, a data: URL or base64");
  }
  if (!IMAGE_TYPES.includes(mimetype)) throw new StepError(`Image: ${mimetype} isn't a picture the model can read (use JPEG, PNG, WebP or GIF)`);
  if (base64.length * 0.75 > MAX_IMAGE_BYTES) throw new StepError("Image: pictures can be at most 8 MB");
  return [{ type: "image", mimetype, base64: base64.replace(/\s/g, "") }];
}

/** Agents need today's date for "remind me Friday" or "overdue since Monday". */
function withNow(instructions: string, now: Date): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: tz }).format(now);
  return `${instructions ? `${instructions}\n\n` : ""}It's now ${when} (${tz}).`;
}

/** Single structured call: the reply is JSON matching `schema`. */
async function structured(
  ctx: ExecContext,
  p: Record<string, unknown>,
  system: string,
  user: string,
  schema: Record<string, unknown>,
  images: LlmBlock[] = [],
): Promise<Record<string, unknown>> {
  const res = await requireLlm(ctx).chat({
    model: modelOf(p),
    system,
    messages: [{ role: "user", content: [...images, { type: "text", text: user }] }],
    jsonSchema: schema,
    effort: "low",
    maxTokens: 8000,
  });
  checkStop(res);
  const raw = textOf(res.content);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new StepError("The model returned an answer that isn't valid JSON");
  }
}

function inputText(p: Record<string, unknown>): string {
  const t = toText(p.text).trim();
  if (!t) throw new StepError("Text is empty");
  return t.slice(0, 100_000);
}

// ---------------------------------------------------------------------------
// Structured steps
// ---------------------------------------------------------------------------

export const classifyExecutor: Executor = async (ctx) => {
  const raw = ctx.node.parameters;
  const cats = (Array.isArray(raw.categories) ? (raw.categories as SwitchCase[]) : []).filter((c) => toText(c.value).trim());
  if (!cats.length) throw new StepError("Add at least one category");
  const allowOther = raw.allowOther !== false;
  const outputs: Record<string, Item[]> = Object.fromEntries(cats.map((c) => [`case-${c.id}`, [] as Item[]]));
  if (allowOther) outputs.other = [];
  const names = [...new Set(cats.map((c) => toText(c.value).trim()))];
  const choices = allowOther ? [...names, "other"] : names;
  for (let i = 0; i < ctx.items.length; i++) {
    const p = ctx.params(i);
    const out = await structured(
      ctx,
      p,
      "You classify text into exactly one of the given categories. Answer with the single best category and a confidence between 0 and 1." +
        (allowOther ? " Use \"other\" only when no category fits." : ""),
      `Categories: ${choices.map((c) => JSON.stringify(c)).join(", ")}\n${toText(p.guidance) ? `Guidance: ${toText(p.guidance)}\n` : ""}\nText to classify:\n<text>\n${inputText(p)}\n</text>`,
      {
        type: "object",
        properties: { category: { type: "string", enum: choices }, confidence: { type: "number" } },
        required: ["category", "confidence"],
        additionalProperties: false,
      },
    );
    const category = toText(out.category);
    const item = { json: { ...ctx.items[i]!.json, category, confidence: Number(out.confidence) || 0 } };
    const hit = cats.find((c) => toText(c.value).trim() === category);
    if (hit) outputs[`case-${hit.id}`]!.push(item);
    else if (allowOther) outputs.other!.push(item);
    else throw new StepError(`The model chose an unknown category "${category}"`);
  }
  return { outputs };
};

export const sentimentExecutor: Executor = async (ctx) => {
  const main: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const p = ctx.params(i);
    const out = await structured(
      ctx,
      p,
      "You judge the overall sentiment of text from its author's point of view.",
      `Text:\n<text>\n${inputText(p)}\n</text>`,
      {
        type: "object",
        properties: {
          sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
          confidence: { type: "number" },
          explanation: { type: "string" },
        },
        required: ["sentiment", "confidence", "explanation"],
        additionalProperties: false,
      },
    );
    main.push({ json: { ...ctx.items[i]!.json, [toText(p.outputField) || "ai"]: out } });
  }
  return { outputs: { main } };
};

const MOD_CATEGORIES = ["harassment", "hate", "violence", "sexual", "self-harm", "spam", "custom-policy"];

export const moderateExecutor: Executor = async (ctx) => {
  const allowed: Item[] = [];
  const flagged: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const p = ctx.params(i);
    const policy = toText(p.policy).trim();
    const out = await structured(
      ctx,
      p,
      "You are a content moderator. Flag text that is harassment, hate, threats or violence, sexual content, self-harm encouragement, or spam" +
        (policy ? `, or that breaks this extra rule (category "custom-policy"): ${policy}` : "") +
        ". Do not flag ordinary complaints, criticism or strong language that isn't aimed at a person.",
      `Text to review:\n<text>\n${inputText(p)}\n</text>`,
      {
        type: "object",
        properties: {
          flagged: { type: "boolean" },
          categories: { type: "array", items: { type: "string", enum: MOD_CATEGORIES } },
          reason: { type: "string" },
        },
        required: ["flagged", "categories", "reason"],
        additionalProperties: false,
      },
    );
    const item = { json: { ...ctx.items[i]!.json, [toText(p.outputField) || "ai"]: out } };
    (out.flagged === true ? flagged : allowed).push(item);
  }
  return { outputs: { allowed, flagged } };
};

const EXTRACT_TYPES: Record<Assignment["type"], string> = { string: "string", number: "number", boolean: "boolean", json: "string" };

export const extractExecutor: Executor = async (ctx) => {
  const main: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const p = ctx.params(i);
    const fields = ((p.fields as Assignment[]) ?? []).filter((f) => toText(f.name).trim());
    if (!fields.length) throw new StepError("Add at least one field to extract");
    const properties = Object.fromEntries(
      fields.map((f) => [
        toText(f.name).trim(),
        {
          anyOf: [{ type: EXTRACT_TYPES[f.type] ?? "string" }, { type: "null" }],
          description: (toText(f.value) || toText(f.name)) + (f.type === "json" ? " (as JSON text)" : ""),
        },
      ]),
    );
    const images = await imageBlocks(ctx, p);
    const text = toText(p.text).trim().slice(0, 100_000);
    if (!text && !images.length) throw new StepError("Give it some text or an image to read");
    const out = await structured(
      ctx,
      p,
      "You extract structured data from text and pictures. Use null for any field that isn't clearly there. Don't guess or invent values.",
      [images.length ? "Read the attached image." : "", text ? `Text:\n<text>\n${text}\n</text>` : ""].filter(Boolean).join("\n\n"),
      { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
      images,
    );
    for (const f of fields) {
      const k = toText(f.name).trim();
      if (f.type === "json" && typeof out[k] === "string") {
        try {
          out[k] = JSON.parse(out[k] as string);
        } catch {
          /* keep the text */
        }
      }
    }
    main.push({ json: { ...ctx.items[i]!.json, [toText(p.outputField) || "ai"]: out } });
  }
  return { outputs: { main } };
};

// ---------------------------------------------------------------------------
// AI Agent with tools
// ---------------------------------------------------------------------------

interface BoundTool {
  spec: LlmTool;
  run(args: Record<string, unknown>): Promise<unknown>;
}

function stringifyResult(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 0) ?? "null";
  return s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + "\n…(truncated)" : s;
}

function bindTools(ctx: ExecContext, item: Item, itemIndex: number, depth: number): BoundTool[] {
  const nodes: Record<string, unknown> = {};
  for (const [id, out] of Object.entries(ctx.state.outputs)) if (out.length) nodes[id] = out[Math.min(itemIndex, out.length - 1)]!.json;
  const resolve = (n: WorkflowNode) => resolveParameters(n.parameters, { input: item.json, nodes, vars: ctx.services.vars }).value;

  return toolsOfAgent(ctx.graph, ctx.node)
    .filter((t) => !t.disabled)
    .map((t): BoundTool | null => {
      const name = toText(t.parameters.toolName);
      const description = toText(t.parameters.toolDescription);
      const params = resolve(t);
      switch (t.type) {
        case "tool.http": {
          const slots = collectAiFills(t.parameters);
          return {
            spec: { name, description, inputSchema: aiFillSchema(slots) },
            run: async (args) => {
              const filled = fillAiPlaceholders(params, args);
              return performHttp({ ...filled, bodyType: "json", failOnErrorStatus: false, timeoutSeconds: 30 }, ctx.services);
            },
          };
        }
        case "tool.calculator":
          return {
            spec: {
              name,
              description,
              inputSchema: {
                type: "object",
                properties: { expression: { type: "string", description: "Arithmetic expression, e.g. (12.5 * 3) / 4" } },
                required: ["expression"],
                additionalProperties: false,
              },
            },
            run: async (args) => ({ result: calculate(toText(args.expression)) }),
          };
        case "tool.think":
          return {
            spec: {
              name,
              description,
              inputSchema: {
                type: "object",
                properties: { thought: { type: "string", description: "Your reasoning or plan" } },
                required: ["thought"],
                additionalProperties: false,
              },
            },
            run: async () => "Noted.",
          };
        case "tool.workflow": {
          const slots = collectAiFills(t.parameters);
          return {
            spec: { name, description, inputSchema: aiFillSchema(slots) },
            run: async (args) => {
              const filled = fillAiPlaceholders(params, args);
              const input = parseJsonParam(filled.input, "Input") ?? {};
              const res = await ctx.services.executeWorkflow({ workflowId: toText(filled.workflowId), input, waitForResult: true });
              return res.map((r) => r.json);
            },
          };
        }
        case "tool.code":
          return {
            spec: {
              name,
              description,
              inputSchema: {
                type: "object",
                properties: { input: { type: "string", description: toText(params.inputDescription) || "Input text" } },
                required: ["input"],
                additionalProperties: false,
              },
            },
            run: async (args) => {
              const res = await ctx.services.runCode({ code: toText(t.parameters.code), mode: "perItem", items: [{ json: { input: toText(args.input) } }] });
              return res.items.length === 1 ? res.items[0] : res.items;
            },
          };
        case "tool.subagent":
          return {
            spec: {
              name,
              description,
              inputSchema: {
                type: "object",
                properties: { task: { type: "string", description: "The sub-task, with all context the specialist needs" } },
                required: ["task"],
                additionalProperties: false,
              },
            },
            run: async (args) => {
              if (depth >= 2) throw new StepError("Sub-agents can't start further sub-agents");
              const res = await requireLlm(ctx).chat({
                model: toText(params.model) || DEFAULT_MODEL,
                system: toText(params.instructions),
                messages: [{ role: "user", content: [{ type: "text", text: toText(args.task) }] }],
                effort: "medium",
                maxTokens: 16000,
              });
              checkStop(res);
              return textOf(res.content);
            },
          };
        default: {
          // App action tools: `tool.<action type>` runs that action with the agent's values filled in.
          const action = t.type.startsWith("tool.app.") ? APP_ACTIONS[t.type.slice("tool.".length)] : undefined;
          if (!action) return null;
          const slots = collectAiFills(t.parameters);
          return {
            spec: { name, description, inputSchema: aiFillSchema(slots) },
            run: async (args) => action(fillAiPlaceholders(params, args), ctx.services),
          };
        }
      }
    })
    .filter((t): t is BoundTool => t !== null);
}

export const agentExecutor: Executor = async (ctx) => {
  const llm = requireLlm(ctx);
  const main: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const item = ctx.items[i]!;
    const p = ctx.params(i);
    const prompt = toText(p.prompt).trim();
    if (!prompt) throw new StepError("The task or message is empty");
    const maxRounds = Math.min(25, Math.max(1, Math.floor(toNumber(p.maxIterations ?? 10, "Max tool rounds"))));
    const effort = (["low", "medium", "high"].includes(toText(p.effort)) ? toText(p.effort) : "medium") as LlmRequest["effort"];
    const useMemory = p.memory === "window" && ctx.services.memory;
    const sessionKey = toText(p.sessionKey).trim();
    if (p.memory === "window" && !sessionKey) throw new StepError("Conversation ID is empty, so memory can't be used");

    const messages: LlmMessage[] = [];
    if (useMemory) {
      for (const t of await ctx.services.memory!.load(ctx.node.id, sessionKey)) messages.push({ role: t.role, content: [{ type: "text", text: t.text }] });
    }
    messages.push({ role: "user", content: [...(await imageBlocks(ctx, p)), { type: "text", text: prompt }] });

    const tools = bindTools(ctx, item, i, 0);
    const byName = new Map(tools.map((t) => [t.spec.name, t]));
    let toolCalls = 0;
    let answer: string | null = null;
    let model = modelOf(p);

    for (let round = 0; round <= maxRounds; round++) {
      const res = await llm.chat({
        model: modelOf(p),
        system: withNow(toText(p.instructions), ctx.services.now()),
        messages,
        tools: tools.length ? tools.map((t) => t.spec) : undefined,
        effort,
        maxTokens: 16000,
      });
      model = res.model;
      checkStop(res);
      messages.push({ role: "assistant", content: res.content });
      if (res.stopReason === "pause_turn") continue;
      const calls = res.content.filter((b): b is Extract<LlmBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (res.stopReason !== "tool_use" || !calls.length) {
        answer = textOf(res.content);
        break;
      }
      if (round === maxRounds) break;
      // Run this round's calls together; return all results in one user message.
      const results = await Promise.all(
        calls.map(async (c): Promise<LlmBlock> => {
          toolCalls++;
          const tool = byName.get(c.name);
          if (!tool) return { type: "tool_result", toolUseId: c.id, content: `Unknown tool "${c.name}"`, isError: true };
          try {
            const out = await tool.run((c.input as Record<string, unknown>) ?? {});
            ctx.log(`${c.name}(${stringifyResult(c.input).slice(0, 300)}) → ${stringifyResult(out).slice(0, 300)}`);
            return { type: "tool_result", toolUseId: c.id, content: stringifyResult(out) };
          } catch (err) {
            const msg = (err as Error).message ?? String(err);
            ctx.log(`${c.name} failed: ${msg}`);
            return { type: "tool_result", toolUseId: c.id, content: `Error: ${msg}`, isError: true };
          }
        }),
      );
      messages.push({ role: "user", content: results });
    }
    if (answer === null) throw new StepError(`Stopped after ${maxRounds} tool rounds without a final answer. Raise “Max tool rounds” or simplify the task.`);

    if (useMemory) {
      await ctx.services.memory!.append(
        ctx.node.id,
        sessionKey,
        [
          { role: "user", text: prompt },
          { role: "assistant", text: answer },
        ],
        Math.max(1, Math.floor(toNumber(p.memoryTurns ?? 10, "Turns to remember"))),
      );
    }
    main.push({ json: { output: answer, toolCalls, model } });
  }
  return { outputs: { main } };
};
