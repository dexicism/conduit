import { buildXlsx, imagesToPdf, mergePdfs, pdfPages, stampPdf, type FileIn, type StampPosition } from "../files";
import type { ExecContext, Executor, Item } from "../types";
import { SHARED_MEMORY, StepError } from "../types";
import { toText } from "../values";
import { account, readTable, spreadsheetIdOf } from "./apps";
import { parseRows } from "./documents";

type Json = Record<string, unknown>;

/** What a file looks like from its first bytes (base64). */
function sniff(b64: string): string {
  if (b64.startsWith("JVBER")) return "application/pdf";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "application/octet-stream";
}

/**
 * Files from a list: WhatsApp media IDs ("6b0…, 6b1…"), data: URLs or base64,
 * as text (comma / new line separated) or a JSON list. Order is kept.
 */
export async function loadFiles(ctx: ExecContext, v: unknown): Promise<FileIn[]> {
  let list: unknown[] = [];
  if (Array.isArray(v)) list = v;
  else {
    const s = toText(v).trim();
    if (s.startsWith("[")) {
      try {
        list = JSON.parse(s) as unknown[];
      } catch {
        throw new StepError("The file list looks like JSON but isn't valid");
      }
    } else list = s.split(/[\s,;]+/).filter(Boolean);
  }
  const out: FileIn[] = [];
  for (const item of list.slice(0, 50)) {
    if (item && typeof item === "object") {
      const o = item as Json;
      const b64 = toText(o.base64).replace(/^data:[^;]+;base64,/, "");
      if (b64) out.push({ base64: b64, mimetype: toText(o.mimetype) || sniff(b64), fileName: toText(o.fileName) || null });
      else if (toText(o.id)) out.push(...(await loadFiles(ctx, toText(o.id))));
      continue;
    }
    const s = toText(item).trim();
    if (/^[a-f\d]{24}$/i.test(s)) {
      const m = await ctx.services.integrations?.whatsappWeb?.readMedia(s);
      if (!m) throw new StepError(`File ${s} isn't stored anymore (files are kept for 30 days) or belongs to another workspace`);
      out.push({ base64: m.base64, mimetype: m.mimetype, fileName: m.fileName });
      continue;
    }
    const d = /^data:([^;,]+);base64,([\s\S]*)$/.exec(s);
    if (d) out.push({ base64: d[2]!, mimetype: d[1]!, fileName: null });
    else if (/^[A-Za-z0-9+/=]{40,}$/.test(s)) out.push({ base64: s, mimetype: sniff(s), fileName: null });
    else throw new StepError(`"${s.slice(0, 40)}" isn't a media ID or a file`);
  }
  if (!out.length) throw new StepError("No files given");
  return out;
}

function fileName(v: unknown, fallback: string, ext: string): string {
  const base = toText(v).trim() || fallback;
  const clean = base.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
  return clean.toLowerCase().endsWith(`.${ext}`) ? clean : `${clean}.${ext}`;
}

/** Optionally sends the result on WhatsApp right away (so an AI tool can make and send a file in one go). */
async function maybeSend(ctx: ExecContext, p: Json, file: { base64: string; mimetype: string; fileName: string }): Promise<Json> {
  const to = toText(p.sendTo).trim();
  const cred = toText(p.sendWith).trim();
  if (!to || !cred) return {};
  const w = ctx.services.integrations?.whatsappWeb;
  if (!w) throw new StepError("WhatsApp (linked phone) isn't available on this server");
  const caption = toText(p.caption);
  const r = await w.send(cred, { to, text: caption, file });
  const key = r.chatId.split("@")[0]!.split(":")[0]!;
  if (ctx.services.memory && key && !r.chatId.endsWith("@g.us")) {
    await ctx.services.memory.append(SHARED_MEMORY, key, [{ role: "assistant", text: `[Sent a file] ${file.fileName}${caption ? `: ${caption}` : ""}` }], 10);
  }
  return { sent: { messageId: r.messageId, chatId: r.chatId } };
}

function result(ctx: ExecContext, i: number, p: Json, file: Json, extra: Json): Item {
  return { json: { ...ctx.items[i]!.json, [toText(p.outputField) || "file"]: file, ...extra } };
}

/** Excel (.xlsx) from rows someone wrote, from the step's input items, or from a sheet tab (optionally only matching rows). */
export const excelExecutor: Executor = async (ctx) => {
  const main: Item[] = [];
  const first = ctx.params(0);
  // "All input items": one file for the whole list.
  if (first.source === "items") {
    const rows = ctx.items.map((it) => it.json);
    const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const x = buildXlsx([{ name: toText(first.sheetName) || "Sheet1", header, rows: rows.map((r) => header.map((h) => r[h])) }]);
    const file = { fileName: fileName(first.fileName, toText(first.sheetName) || "export", "xlsx"), mimetype: XLSX, size: x.size, rows: rows.length, base64: x.base64 };
    const sent = await maybeSend(ctx, first, file);
    return { outputs: { main: [{ json: { [toText(first.outputField) || "file"]: file, ...sent } }] } };
  }
  for (let i = 0; i < ctx.items.length; i++) {
    const p = ctx.params(i);
    let header: string[];
    let rows: unknown[][];
    if (p.source === "sheet") {
      const { accessToken } = await account(p, "google", ctx.services);
      const t = await readTable(ctx.services, accessToken, spreadsheetIdOf(p.spreadsheetId), p.sheet);
      const col = toText(p.filterColumn).trim();
      const want = toText(p.filterValue).trim().toLowerCase();
      const c = col ? t.header.findIndex((h) => h.toLowerCase() === col.toLowerCase()) : -1;
      if (col && c < 0) throw new StepError(`No column named "${col}". The sheet has: ${t.header.filter(Boolean).join(", ")}`);
      const keep = t.header.map((h, k) => (h.trim() || t.rows.some((r) => (r[k] ?? "").trim()) ? k : -1)).filter((k) => k >= 0);
      header = keep.map((k) => t.header[k] || `Column ${k + 1}`);
      rows = t.rows
        .filter((r) => r.some((x) => x.trim()))
        .filter((r) => !want || (c >= 0 ? (r[c] ?? "").toLowerCase().includes(want) : r.join(" ").toLowerCase().includes(want)))
        .map((r) => keep.map((k) => r[k] ?? ""));
    } else {
      const objs = parseRows(p.rows);
      if (!objs.length) throw new StepError("The table is empty. Write lines like 'Name | Phone' with one line per row.");
      header = [...new Set(objs.flatMap((r) => Object.keys(r)))];
      rows = objs.map((r) => header.map((h) => r[h]));
    }
    if (rows.length > 20_000) throw new StepError("At most 20,000 rows");
    const name = toText(p.sheetName) || "Sheet1";
    const x = buildXlsx([{ name, header, rows }]);
    const file = { fileName: fileName(p.fileName, name === "Sheet1" ? "export" : name, "xlsx"), mimetype: XLSX, size: x.size, rows: rows.length, base64: x.base64 };
    main.push(result(ctx, i, p, file, await maybeSend(ctx, p, file)));
  }
  return { outputs: { main } };
};

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const imagesToPdfExecutor: Executor = async (ctx) => {
  const main: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const p = ctx.params(i);
    const r = await imagesToPdf(await loadFiles(ctx, p.files), { title: toText(p.title) });
    if (r.skipped.length) ctx.log(`Skipped (not JPEG or PNG): ${r.skipped.join(", ")}`);
    const file = { fileName: fileName(p.fileName, "photos", "pdf"), mimetype: "application/pdf", size: r.size, pages: r.pages, base64: r.base64 };
    main.push(result(ctx, i, p, file, { skipped: r.skipped, ...(await maybeSend(ctx, p, file)) }));
  }
  return { outputs: { main } };
};

export const pdfMergeExecutor: Executor = async (ctx) => {
  const main: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const p = ctx.params(i);
    let r;
    try {
      r = await mergePdfs(await loadFiles(ctx, p.files));
    } catch (e) {
      throw new StepError((e as Error).message);
    }
    const file = { fileName: fileName(p.fileName, "merged", "pdf"), mimetype: "application/pdf", size: r.size, pages: r.pages, base64: r.base64 };
    main.push(result(ctx, i, p, file, await maybeSend(ctx, p, file)));
  }
  return { outputs: { main } };
};

export const pdfPagesExecutor: Executor = async (ctx) => {
  const main: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const p = ctx.params(i);
    const [f] = await loadFiles(ctx, p.file);
    let r;
    try {
      r = await pdfPages(f!, toText(p.pages));
    } catch (e) {
      throw new StepError((e as Error).message);
    }
    const file = { fileName: fileName(p.fileName, (f!.fileName ?? "pages").replace(/\.pdf$/i, "") + "-pages", "pdf"), mimetype: "application/pdf", size: r.size, pages: r.pages, base64: r.base64 };
    main.push(result(ctx, i, p, file, await maybeSend(ctx, p, file)));
  }
  return { outputs: { main } };
};

export const pdfStampExecutor: Executor = async (ctx) => {
  const main: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const p = ctx.params(i);
    const [f] = await loadFiles(ctx, p.file);
    let r;
    try {
      r = await stampPdf(f!, toText(p.text), {
        position: (toText(p.position) || "top-right") as StampPosition,
        pages: toText(p.pages),
        color: (toText(p.color) || "red") as "red",
      });
    } catch (e) {
      throw new StepError((e as Error).message);
    }
    const file = { fileName: fileName(p.fileName, (f!.fileName ?? "document").replace(/\.pdf$/i, "") + "-stamped", "pdf"), mimetype: "application/pdf", size: r.size, pages: r.pages, base64: r.base64 };
    main.push(result(ctx, i, p, file, await maybeSend(ctx, p, file)));
  }
  return { outputs: { main } };
};
