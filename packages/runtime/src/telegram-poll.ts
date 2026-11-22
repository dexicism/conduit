import { workflowGraphSchema } from "@conduit/core";
import type { Db } from "mongodb";
import { telegramUpdateToItem, type Integrations } from "./integrations";
import type { Runtime, StartInput } from "./runtime";
import { collections, type TriggerDoc } from "./store";

/**
 * Builds the run for one Telegram update sent to a live workflow's bot, or null
 * when the update isn't a message or the workflow is gone. Shared by the webhook
 * route and the poller so both start runs the same way.
 */
export async function telegramRunInput(db: Db, t: TriggerDoc, update: Record<string, unknown>): Promise<StartInput | null> {
  if (!update.message && !update.edited_message) return null;
  const c = collections(db);
  const [wf, version] = await Promise.all([
    c.workflows.findOne({ _id: t.workflowId }, { projection: { name: 1 } }),
    t.versionId ? c.versions.findOne({ _id: t.versionId }) : null,
  ]);
  if (!wf || !version) return null;
  return {
    workspaceId: t.workspaceId,
    workflowId: t.workflowId,
    workflowName: String(wf.name),
    versionId: version._id,
    mode: "production",
    graph: workflowGraphSchema.parse(version.graph),
    triggerNodeId: t.nodeId,
    triggerItems: [{ json: telegramUpdateToItem(update) }],
  };
}

export interface TelegramPollerOptions {
  /** Seconds Telegram holds each request open waiting for a message (long polling). */
  timeoutSec?: number;
  /** Wait between checks when no workflow has a Telegram trigger. */
  idleMs?: number;
  /** Wait after a failed request before trying that bot again. */
  errorBackoffMs?: number;
}

/**
 * Polling mode: asks Telegram for new messages for every bot that starts a live
 * workflow, so receiving works on a PC with no public address. Run exactly one
 * poller per bot (Telegram rejects overlapping getUpdates calls).
 *
 * The offset is kept in memory and on the trigger, so a message isn't started
 * twice; Telegram also forgets updates once a later offset is requested.
 */
export function startTelegramPoller(db: Db, integrations: Integrations, runtime: Pick<Runtime, "createExecution">, opts: TelegramPollerOptions = {}) {
  const c = collections(db);
  const timeoutSec = opts.timeoutSec ?? 10;
  const idleMs = opts.idleMs ?? 2000;
  const backoffMs = opts.errorBackoffMs ?? 5000;
  const offsets = new Map<string, number>();
  const lastError = new Map<string, string>();
  let stopped = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function pollOne(t: TriggerDoc) {
    const bot = t.credentialId!;
    const offset = Math.max(offsets.get(bot) ?? 0, t.pollOffset ?? 0) || undefined;
    try {
      const updates = await integrations.telegram.getUpdates(t.workspaceId, bot, offset, timeoutSec);
      if (lastError.delete(bot)) console.info(`[telegram] bot ${bot} is receiving again`);
      for (const u of updates) {
        const id = Number(u.update_id);
        const input = await telegramRunInput(db, t, u);
        if (input) await runtime.createExecution(input, true);
        if (Number.isFinite(id)) {
          offsets.set(bot, id + 1);
          await c.triggers.updateOne({ _id: t._id }, { $max: { pollOffset: id + 1 } });
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      // Log each new problem once, not on every retry.
      if (lastError.get(bot) !== message) console.warn(`[telegram] can't get messages for bot ${bot}: ${message}`);
      lastError.set(bot, message);
      await sleep(backoffMs);
    }
  }

  const done = (async () => {
    while (!stopped) {
      try {
        const list = await c.triggers.find({ kind: "telegram", credentialId: { $exists: true, $ne: "" } }).toArray();
        if (!list.length) {
          await sleep(idleMs);
          continue;
        }
        const started = Date.now();
        await Promise.all(list.map(pollOne));
        // Telegram holds each request open, but don't spin if a round returns at once.
        const left = 500 - (Date.now() - started);
        if (left > 0) await sleep(left);
      } catch (err) {
        console.error("[telegram] poller error", err);
        await sleep(backoffMs);
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      await done;
    },
  };
}
