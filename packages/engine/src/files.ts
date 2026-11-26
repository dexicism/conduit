import { strToU8, zipSync } from "fflate";
import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { pdfSafe } from "./pdf";

/**
 * File tools that need no outside service: Excel files from rows, photos to a
 * PDF, and merging, splitting and stamping PDFs. Everything is base64 in and out.
 */

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export interface SheetData {
  name: string;
  header: string[];
  rows: unknown[][];
}

/** A real .xlsx (opens in Excel, Google Sheets, LibreOffice): bold header row, numbers as numbers. */
export function buildXlsx(sheets: SheetData[]): { base64: string; size: number } {
  if (!sheets.length) throw new Error("Nothing to put in the Excel file");
  const names = new Set<string>();
  const safeName = (n: string) => {
    let base = n.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
    for (let k = 2; names.has(base.toLowerCase()); k++) base = `${base.slice(0, 28)} ${k}`;
    names.add(base.toLowerCase());
    return base;
  };
  const files: Record<string, Uint8Array> = {};
  const cell = (v: unknown, ref: string, bold: boolean) => {
    if (v === null || v === undefined || v === "") return "";
    const s = bold ? ' s="1"' : "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    const text = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
    // Plain numbers stay numbers; phone numbers and codes with leading zeros stay text.
    if (!bold && /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(text.trim()) && text.trim().replace(/\D/g, "").length < 10) return `<c r="${ref}"${s}><v>${text.trim()}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xml(text.slice(0, 32_000))}</t></is></c>`;
  };
  const sheetXml = sheets.map((sh) => {
    const all = [sh.header, ...sh.rows];
    const widths = sh.header.map((_, c) => Math.min(60, Math.max(8, ...all.map((r) => String(r[c] ?? "").length + 2))));
    const rows = all
      .map((r, i) => `<row r="${i + 1}">${sh.header.map((_, c) => cell(r[c], `${colName(c)}${i + 1}`, i === 0)).join("")}</row>`)
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${rows}</sheetData></worksheet>`;
  });
  const titles = sheets.map((s) => safeName(s.name));
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${titles.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
  );
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${titles.map((t, i) => `<sheet name="${xml(t)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${titles.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${titles.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  files["xl/styles.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
  );
  sheetXml.forEach((x, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(x)));
  const zip = zipSync(files, { level: 6 });
  return { base64: Buffer.from(zip).toString("base64"), size: zip.length };
}

export interface FileIn {
  base64: string;
  mimetype: string;
  fileName?: string | null;
}

const A4 = { w: 595.28, h: 841.89 };

/** Photos (JPEG or PNG) to one PDF, one photo per A4 page, scaled to fit. */
export async function imagesToPdf(images: FileIn[], opts: { title?: string } = {}): Promise<{ base64: string; size: number; pages: number; skipped: string[] }> {
  const doc = await PDFDocument.create();
  if (opts.title) doc.setTitle(pdfSafe(opts.title, new Set()));
  doc.setProducer("Conduit");
  const skipped: string[] = [];
  for (const img of images) {
    const bytes = Buffer.from(img.base64, "base64");
    let embedded;
    try {
      if (img.mimetype === "image/png") embedded = await doc.embedPng(bytes);
      else if (img.mimetype === "image/jpeg" || img.mimetype === "image/jpg") embedded = await doc.embedJpg(bytes);
      else {
        skipped.push(img.fileName || img.mimetype);
        continue;
      }
    } catch {
      skipped.push(img.fileName || img.mimetype);
      continue;
    }
    const landscape = embedded.width > embedded.height;
    const page = doc.addPage(landscape ? [A4.h, A4.w] : [A4.w, A4.h]);
    const { width, height } = page.getSize();
    const m = 24;
    const scale = Math.min((width - 2 * m) / embedded.width, (height - 2 * m) / embedded.height, 1.5);
    const w = embedded.width * scale;
    const h = embedded.height * scale;
    page.drawImage(embedded, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h });
  }
  if (!doc.getPageCount()) throw new Error("None of the files is a JPEG or PNG photo");
  const out = await doc.save();
  return { base64: Buffer.from(out).toString("base64"), size: out.length, pages: doc.getPageCount(), skipped };
}

async function loadPdf(f: FileIn): Promise<PDFDocument> {
  if (f.mimetype !== "application/pdf") throw new Error(`${f.fileName || "A file"} isn't a PDF`);
  try {
    return await PDFDocument.load(Buffer.from(f.base64, "base64"), { ignoreEncryption: true });
  } catch {
    throw new Error(`${f.fileName || "A file"} couldn't be opened as a PDF`);
  }
}

/** Several PDFs (and photos) into one PDF, in order. */
export async function mergePdfs(files: FileIn[]): Promise<{ base64: string; size: number; pages: number }> {
  if (!files.length) throw new Error("No files to merge");
  const out = await PDFDocument.create();
  out.setProducer("Conduit");
  for (const f of files) {
    if (f.mimetype.startsWith("image/")) {
      const one = await PDFDocument.load(Buffer.from((await imagesToPdf([f])).base64, "base64"));
      for (const p of await out.copyPages(one, one.getPageIndices())) out.addPage(p);
      continue;
    }
    const src = await loadPdf(f);
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  const bytes = await out.save();
  return { base64: Buffer.from(bytes).toString("base64"), size: bytes.length, pages: out.getPageCount() };
}

/** "2-4, 7" -> [1,2,3,6] (0-based), checked against the page count. "last" works too. */
export function pageList(spec: string, count: number): number[] {
  const out: number[] = [];
  for (const part of spec.split(/[,;\s]+/).filter(Boolean)) {
    const p = part.toLowerCase().replace(/last/g, String(count));
    const m = /^(\d+)(?:-(\d+))?$/.exec(p);
    if (!m) throw new Error(`"${part}" isn't a page number or range like 2-4`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > count || a > b) throw new Error(`Pages ${part}: the PDF has ${count} page${count === 1 ? "" : "s"}`);
    for (let i = a; i <= b; i++) if (!out.includes(i - 1)) out.push(i - 1);
  }
  if (!out.length) throw new Error("Which pages? e.g. 1-3, 5");
  return out;
}

/** Keeps only some pages of a PDF, in the order given. */
export async function pdfPages(file: FileIn, spec: string): Promise<{ base64: string; size: number; pages: number }> {
  const src = await loadPdf(file);
  const keep = pageList(spec, src.getPageCount());
  const out = await PDFDocument.create();
  out.setProducer("Conduit");
  for (const p of await out.copyPages(src, keep)) out.addPage(p);
  const bytes = await out.save();
  return { base64: Buffer.from(bytes).toString("base64"), size: bytes.length, pages: out.getPageCount() };
}

export type StampPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left" | "center" | "diagonal";

/** Writes text (like "APPROVED", a date or a reference) onto the pages of a PDF. */
export async function stampPdf(
  file: FileIn,
  text: string,
  opts: { position?: StampPosition; pages?: string; size?: number; color?: "red" | "blue" | "green" | "black" } = {},
): Promise<{ base64: string; size: number; pages: number }> {
  const doc = await loadPdf(file);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = pdfSafe(text, new Set()).trim();
  if (!safe) throw new Error("The stamp text is empty");
  const colors = { red: rgb(0.8, 0.1, 0.1), blue: rgb(0.1, 0.25, 0.7), green: rgb(0.1, 0.55, 0.25), black: rgb(0.1, 0.1, 0.1) };
  const color = colors[opts.color ?? "red"];
  const pos = opts.position ?? "top-right";
  const pages = opts.pages?.trim() ? pageList(opts.pages, doc.getPageCount()) : doc.getPageIndices();
  for (const i of pages) {
    const page = doc.getPage(i);
    const { width, height } = page.getSize();
    const size = opts.size ?? (pos === "diagonal" || pos === "center" ? Math.min(72, (width * 0.7) / Math.max(4, safe.length * 0.6)) : 14);
    const tw = font.widthOfTextAtSize(safe, size);
    const m = 30;
    if (pos === "diagonal") {
      page.drawText(safe, { x: width / 2 - (tw / 2) * 0.7, y: height / 2 - (tw / 2) * 0.7, size, font, color, rotate: degrees(45), opacity: 0.35 });
      continue;
    }
    const x = pos.endsWith("right") ? width - m - tw : pos.endsWith("left") ? m : (width - tw) / 2;
    const y = pos.startsWith("top") ? height - m - size : pos.startsWith("bottom") ? m : height / 2;
    page.drawRectangle({ x: x - 6, y: y - 5, width: tw + 12, height: size + 10, borderColor: color, borderWidth: 1.5, opacity: 0 });
    page.drawText(safe, { x, y, size, font, color });
  }
  const bytes = await doc.save();
  return { base64: Buffer.from(bytes).toString("base64"), size: bytes.length, pages: doc.getPageCount() };
}
