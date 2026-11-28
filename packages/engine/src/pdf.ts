import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Simple business documents (quotations, invoices, reports) as PDF: a title,
 * a few lines of text, a table, a total and notes. Built in memory with
 * pdf-lib, no browser or external service.
 *
 * The built-in fonts only cover Western characters, so ₹ becomes "Rs." and
 * anything else they can't draw becomes "?". The document says which.
 */

export interface DocInput {
  title: string;
  /** Your company / sender, shown top right. */
  from?: string;
  /** Who it's for, shown under the title. */
  to?: string;
  /** A date or reference line, e.g. "Quotation Q-12 · 26 Nov 2026". */
  reference?: string;
  intro?: string;
  rows?: Array<Record<string, unknown>>;
  /** Currency label for money columns and the total, e.g. "Rs." or "$". */
  currency?: string;
  notes?: string;
  /**
   * A plain list (e.g. a whole sheet tab): no Amount column, totals or money
   * formatting; columns sized to their content, landscape when wide, and the
   * header repeated on every page.
   */
  list?: boolean;
}

export interface DocResult {
  base64: string;
  size: number;
  pages: number;
  total: number | null;
  /** Characters the PDF fonts couldn't show (replaced). */
  replaced: string[];
}

const A4 = { w: 595.28, h: 841.89 };
const M = 50;
const INK = rgb(0.13, 0.14, 0.17);
const MUTED = rgb(0.42, 0.44, 0.5);
const LINE = rgb(0.85, 0.86, 0.89);
const HEAD_BG = rgb(0.95, 0.96, 0.97);

/** Makes text drawable by the standard fonts (WinAnsi). */
export function pdfSafe(text: string, replaced: Set<string>): string {
  return text
    .replace(/₹/g, "Rs. ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\t/g, "    ")
    .replace(/[^\x0A\x20-\x7E\xA0-\xFF€•]/g, (ch) => {
      replaced.add(ch);
      return "?";
    });
}

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[₹$€£,\s]|Rs\.?|INR/gi, "");
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
};

function money(n: number, currency: string): string {
  const s = n.toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return currency ? `${currency} ${s}` : s;
}

/** Splits text into lines that fit `width`. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) out.push(line);
        // A single word wider than the line: cut it.
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
          let cut = w.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

/** A plain list: the columns as they are, nothing added or totalled. */
function listOf(rows: Array<Record<string, unknown>>) {
  const header: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!header.includes(k)) header.push(k);
  return { header, body: rows.map((r) => header.map((k) => r[k])), moneyCols: new Set<number>(), total: null as number | null };
}

/** Normalises table rows; adds an Amount column when rows have a quantity and a price. */
export function tableOf(rows: Array<Record<string, unknown>>) {
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const find = (...names: string[]) => keys.find((k) => names.includes(k.trim().toLowerCase()));
  const qtyKey = find("qty", "quantity", "units", "nos", "pcs");
  const priceKey = find("price", "rate", "unit price", "unit_price", "cost");
  const amountKey = find("amount", "total", "line total", "subtotal");
  let header = [...keys];
  let body = rows.map((r) => header.map((k) => r[k]));
  if (qtyKey && priceKey && !amountKey) {
    header = [...header, "Amount"];
    body = rows.map((r) => {
      const q = num(r[qtyKey]);
      const p = num(r[priceKey]);
      return [...keys.map((k) => r[k]), q !== null && p !== null ? Math.round(q * p * 100) / 100 : ""];
    });
  }
  const amountCol = header.findIndex((h) => ["amount", "total", "line total", "subtotal"].includes(h.trim().toLowerCase()));
  const moneyCols = new Set(header.map((h, i) => (["price", "rate", "unit price", "unit_price", "cost", "amount", "total", "line total", "subtotal"].includes(h.trim().toLowerCase()) ? i : -1)).filter((i) => i >= 0));
  let total: number | null = null;
  if (amountCol >= 0) {
    const vals = body.map((r) => num(r[amountCol]));
    if (vals.some((v) => v !== null)) total = Math.round(vals.reduce<number>((t, v) => t + (v ?? 0), 0) * 100) / 100;
  }
  return { header, body, moneyCols, total };
}

export async function buildPdf(input: DocInput): Promise<DocResult> {
  const replaced = new Set<string>();
  const t = (s: unknown) => pdfSafe(s === null || s === undefined ? "" : String(s), replaced);
  const currency = t(input.currency ?? "").trim();
  const doc = await PDFDocument.create();
  const list = Boolean(input.list);
  const colCount = input.rows?.length ? new Set(input.rows.flatMap((r) => Object.keys(r))).size : 0;
  const PAGE = list && colCount > 5 ? { w: A4.h, h: A4.w } : A4;
  doc.setTitle(t(input.title));
  doc.setProducer("Conduit");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = doc.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - M;
  const width = PAGE.w - 2 * M;
  let onNewPage = () => {};
  const newPage = () => {
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - M;
    onNewPage();
  };
  const need = (h: number) => {
    if (y - h < M + 20) newPage();
  };
  const text = (s: string, size: number, opts: { f?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; w?: number; gap?: number } = {}) => {
    for (const line of wrap(s, opts.f ?? font, size, opts.w ?? width)) {
      need(size + 4);
      page.drawText(line, { x: opts.x ?? M, y: y - size, size, font: opts.f ?? font, color: opts.color ?? INK });
      y -= size + (opts.gap ?? 4);
    }
  };

  // Header: sender top right, title left.
  if (input.from) {
    const lines = wrap(t(input.from), font, 9, 200);
    lines.forEach((l, i) => page.drawText(l, { x: PAGE.w - M - font.widthOfTextAtSize(l, 9), y: y - 9 - i * 12, size: 9, font, color: MUTED }));
  }
  text(t(input.title), 20, { f: bold, w: width - 210, gap: 8 });
  if (input.reference) text(t(input.reference), 10, { color: MUTED });
  if (input.to) {
    y -= 8;
    text("For", 8, { f: bold, color: MUTED, gap: 2 });
    text(t(input.to), 11);
  }
  y -= 12;
  if (input.intro) {
    text(t(input.intro), 10.5, { gap: 5 });
    y -= 8;
  }

  // Table
  let total: number | null = null;
  if (input.rows?.length) {
    const tbl = list ? listOf(input.rows) : tableOf(input.rows);
    total = tbl.total;
    const cols = tbl.header.length;
    const size = list ? (cols > 10 ? 7 : cols > 7 ? 8 : 9) : 9.5;
    const lineH = list ? size + 2.5 : 12;
    let ws: number[];
    if (list) {
      // Each column gets room by how long its text usually is (header included), within limits.
      const est = tbl.header.map((h, i) => {
        const lens = [String(h).length, ...tbl.body.map((r) => String(r[i] ?? "").length)].sort((a, b) => a - b);
        return Math.min(40, Math.max(4, lens[Math.floor(lens.length * 0.9)] ?? 4));
      });
      const sum = est.reduce((a, b) => a + b, 0);
      ws = est.map((e) => (e / sum) * width);
    } else {
      // First column gets the most room; the others share the rest.
      const firstW = cols > 1 ? Math.max(width * 0.4, width - (cols - 1) * 85) : width;
      const otherW = cols > 1 ? (width - firstW) / (cols - 1) : 0;
      ws = tbl.header.map((_, i) => (i === 0 ? firstW : otherW));
    }
    const xs = ws.map((_, i) => M + ws.slice(0, i).reduce((a, b) => a + b, 0));
    const cellText = (v: unknown, i: number) => {
      const n = num(v);
      return tbl.moneyCols.has(i) && n !== null ? money(n, currency) : t(v ?? "");
    };
    const pad = list ? 3 : 5;
    const drawRow = (cells: string[], isHead: boolean) => {
      const wrapped = cells.map((c, i) => wrap(c, isHead ? bold : font, size, ws[i]! - 2 * pad));
      const h = Math.max(...wrapped.map((w) => w.length)) * lineH + (list ? 7 : 10);
      need(h);
      if (isHead) page.drawRectangle({ x: M, y: y - h, width, height: h, color: HEAD_BG });
      wrapped.forEach((lines, i) =>
        lines.forEach((l, k) => {
          const right = !list && i > 0 && !isHead && num(cells[i]!.replace(currency, "")) !== null;
          const x = right ? xs[i]! + ws[i]! - pad - (isHead ? bold : font).widthOfTextAtSize(l, size) : xs[i]! + pad;
          page.drawText(l, { x, y: y - (list ? size + 3.5 : 15) - k * lineH, size, font: isHead ? bold : font, color: INK });
        }),
      );
      y -= h;
      page.drawLine({ start: { x: M, y }, end: { x: M + width, y }, thickness: 0.6, color: LINE });
    };
    const head = tbl.header.map((h) => t(h));
    drawRow(head, true);
    if (list) onNewPage = () => drawRow(head, true);
    for (const r of tbl.body) drawRow(r.map(cellText), false);
    onNewPage = () => {};
    if (total !== null) {
      need(24);
      const label = `Total  ${money(total, currency)}`;
      page.drawText(label, { x: M + width - bold.widthOfTextAtSize(label, 12) - 5, y: y - 18, size: 12, font: bold, color: INK });
      y -= 28;
    }
    y -= 10;
  }

  if (input.notes) {
    text("Notes", 9, { f: bold, color: MUTED, gap: 3 });
    text(t(input.notes), 10, { gap: 4 });
  }
  if (replaced.size) {
    y -= 6;
    text(`(Some characters couldn't be shown in this PDF and appear as "?".)`, 7.5, { color: MUTED });
  }

  // Page numbers
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const s = `${i + 1} / ${pages.length}`;
    p.drawText(s, { x: PAGE.w - M - font.widthOfTextAtSize(s, 8), y: M / 2, size: 8, font, color: MUTED });
  });

  const bytes = await doc.save();
  return { base64: Buffer.from(bytes).toString("base64"), size: bytes.length, pages: pages.length, total, replaced: [...replaced] };
}
