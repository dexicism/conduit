import { strFromU8, unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildXlsx, imagesToPdf, mergePdfs, pageList, pdfPages, stampPdf } from "./files";
import { buildPdf } from "./pdf";

/** A 1x1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const pdfOf = async (pages: number) => {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([300, 300]);
  return { base64: Buffer.from(await d.save()).toString("base64"), mimetype: "application/pdf" };
};
const pageCount = async (b64: string) => (await PDFDocument.load(Buffer.from(b64, "base64"))).getPageCount();

describe("file tools", () => {
  it("makes a real xlsx: bold header, numbers as numbers, phone numbers and leading zeros as text", () => {
    const x = buildXlsx([{ name: "Leads", header: ["Name", "Phone", "Qty", "Code"], rows: [["Mohan & Co", "9800000101", 5, "007"], ["Kiran", "+91 98000 00102", "12.5", ""]] }]);
    const files = unzipSync(Buffer.from(x.base64, "base64"));
    expect(Object.keys(files).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(strFromU8(files["xl/workbook.xml"]!)).toContain('name="Leads"');
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Name</t></is></c>');
    expect(sheet).toContain("Mohan &amp; Co");
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">9800000101</t></is></c>'); // phone stays text
    expect(sheet).toContain('<c r="C2"><v>5</v></c>');
    expect(sheet).toContain('<c r="C3"><v>12.5</v></c>');
    expect(sheet).not.toContain('r="D3"'); // empty cells are left out
  });

  it("turns photos into a PDF, merges PDFs and photos, picks pages and stamps text", async () => {
    const photos = await imagesToPdf([{ base64: PNG, mimetype: "image/png" }, { base64: PNG, mimetype: "image/png" }, { base64: "AAAA", mimetype: "image/webp", fileName: "x.webp" }]);
    expect(photos.pages).toBe(2);
    expect(photos.skipped).toEqual(["x.webp"]);

    const merged = await mergePdfs([await pdfOf(2), { base64: PNG, mimetype: "image/png" }, await pdfOf(3)]);
    expect(merged.pages).toBe(6);
    expect(await pageCount(merged.base64)).toBe(6);

    expect(pageList("2-4, 6, last", 7)).toEqual([1, 2, 3, 5, 6]);
    expect(() => pageList("5-9", 6)).toThrow(/has 6 pages/);
    const some = await pdfPages({ base64: merged.base64, mimetype: "application/pdf" }, "1, 5-6");
    expect(some.pages).toBe(3);

    const quote = await buildPdf({ title: "Quotation", rows: [{ Item: "Pipe", Qty: 2, Price: 100 }] });
    const stamped = await stampPdf({ base64: quote.base64, mimetype: "application/pdf" }, "APPROVED 26-11-26 ✓", { position: "diagonal" });
    expect(stamped.pages).toBe(1);
    expect(stamped.size).toBeGreaterThan(quote.size);
    await expect(stampPdf({ base64: PNG, mimetype: "image/png" }, "X")).rejects.toThrow(/isn't a PDF/);
  });
});
