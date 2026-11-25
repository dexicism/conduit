import { buildPdf, type DocInput } from "../pdf";
import type { Executor, Item } from "../types";
import { StepError } from "../types";
import { toText } from "../values";

/**
 * Table rows from what people (or the AI) write: a JSON array of objects, a
 * JSON array of arrays (first one is the header), or lines like
 *   Item | Qty | Price
 *   Steel pipe | 50 | 200
 */
export function parseRows(v: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(v)) {
    if (v.every((r) => Array.isArray(r))) {
      const [head, ...rest] = v as unknown[][];
      const keys = (head ?? []).map((h) => String(h ?? "").trim());
      return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
    }
    return (v as unknown[]).filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
  }
  const s = toText(v).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      return parseRows(JSON.parse(s));
    } catch {
      throw new StepError("The table looks like JSON but isn't valid");
    }
  }
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sep = lines[0]!.includes("|") ? "|" : lines[0]!.includes("\t") ? "\t" : ",";
  const cells = (l: string) => l.replace(/^\||\|$/g, "").split(sep).map((c) => c.trim());
  const head = cells(lines[0]!);
  return lines
    .slice(1)
    .filter((l) => !/^[\s|:-]+$/.test(l)) // markdown separator rows
    .map((l) => {
      const c = cells(l);
      return Object.fromEntries(head.map((h, i) => [h, c[i] ?? ""]));
    });
}

export function docInputOf(p: Record<string, unknown>): DocInput {
  const title = toText(p.title).trim();
  if (!title) throw new StepError("The document needs a title");
  const rows = parseRows(p.rows);
  if (rows.length > 500) throw new StepError("At most 500 table rows");
  return {
    title,
    from: toText(p.from).trim() || undefined,
    to: toText(p.to_name ?? p.recipient).trim() || undefined,
    reference: toText(p.reference).trim() || undefined,
    intro: toText(p.intro).trim() || undefined,
    rows,
    currency: toText(p.currency).trim(),
    notes: toText(p.notes).trim() || undefined,
  };
}

export function pdfName(v: unknown, title: string): string {
  const base = toText(v).trim() || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

export const pdfExecutor: Executor = async (ctx) => {
  const main: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    const p = ctx.params(i);
    const input = docInputOf(p);
    const pdf = await buildPdf(input);
    if (pdf.replaced.length) ctx.log(`Couldn't show these characters, used "?" instead: ${pdf.replaced.join(" ")}`);
    main.push({
      json: {
        ...ctx.items[i]!.json,
        [toText(p.outputField) || "pdf"]: { fileName: pdfName(p.fileName, input.title), mimetype: "application/pdf", size: pdf.size, pages: pdf.pages, total: pdf.total, base64: pdf.base64 },
      },
    });
  }
  return { outputs: { main } };
};
