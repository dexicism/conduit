import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { parseRows } from "./executors/documents";
import { buildPdf, pdfSafe, tableOf } from "./pdf";

describe("PDF documents", () => {
  it("reads tables written as lines, markdown or JSON", () => {
    expect(parseRows("Item | Qty | Price\n|---|---|---|\nSteel pipe | 50 | 200\nBends | 10 | 35.5")).toEqual([
      { Item: "Steel pipe", Qty: "50", Price: "200" },
      { Item: "Bends", Qty: "10", Price: "35.5" },
    ]);
    expect(parseRows('[["Item","Qty"],["A",1]]')).toEqual([{ Item: "A", Qty: 1 }]);
    expect(parseRows([{ Item: "B", Qty: 2 }])).toEqual([{ Item: "B", Qty: 2 }]);
    expect(parseRows("Name,Phone\nRavi,98123")).toEqual([{ Name: "Ravi", Phone: "98123" }]);
    expect(parseRows("")).toEqual([]);
  });

  it("adds amounts and a total when there's a quantity and a price", () => {
    const t = tableOf([
      { Item: "Steel pipe", Qty: "50", Price: "₹200" },
      { Item: "Bends", Qty: "10", Price: "35.5" },
    ]);
    expect(t.header).toEqual(["Item", "Qty", "Price", "Amount"]);
    expect(t.body.map((r) => r[3])).toEqual([10000, 355]);
    expect(t.total).toBe(10355);
    expect(tableOf([{ Item: "x", Amount: "1,200" }, { Item: "y", Amount: "300" }]).total).toBe(1500);
    expect(tableOf([{ Name: "Ravi" }]).total).toBeNull();
  });

  it("makes a whole list (like a sheet tab) as a landscape table: no totals, header on every page", async () => {
    const cols = ["Name", "Designation", "Mobile number", "Architect", "House number", "Sector", "Address", "Remarks", "Qualified", "Quoted"];
    const rows = Array.from({ length: 120 }, (_, i) => Object.fromEntries(cols.map((c) => [c, c === "Mobile number" ? `98000001${String(i).padStart(2, "0")}` : `${c} ${i}`])));
    rows[0]!.Qty = "2";
    rows[0]!.Price = "100";
    const r = await buildPdf({ title: "Scanning Data", rows, list: true });
    expect(r.total).toBeNull();
    expect(r.pages).toBeGreaterThan(2);
    const doc = await PDFDocument.load(Buffer.from(r.base64, "base64"));
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
    // A short list with few columns stays upright.
    const small = await PDFDocument.load(Buffer.from((await buildPdf({ title: "Two", rows: [{ Name: "Mohan", Phone: "9800000101" }], list: true })).base64, "base64"));
    expect(small.getPage(0).getSize().height).toBeGreaterThan(small.getPage(0).getSize().width);
  });

  it("swaps characters the PDF fonts can't draw", () => {
    const r = new Set<string>();
    expect(pdfSafe("₹500 – “ok” …", r)).toBe('Rs. 500 - "ok" ...');
    expect(pdfSafe("नमस्ते", r)).toBe("??????");
    expect(r.size).toBeGreaterThan(0);
  });

  it("builds a real, readable PDF, over several pages when the table is long", async () => {
    const small = await buildPdf({
      title: "Quotation",
      from: "Shadab Traders\nPune",
      to: "Mehta Traders",
      reference: "Q-12 · 26 Nov 2026",
      intro: "Thanks for your enquiry. Here are our prices.",
      rows: parseRows("Item | Qty | Price\nSteel pipe 2in | 50 | 200"),
      currency: "Rs.",
      notes: "Prices exclude GST.",
    });
    const bytes = Buffer.from(small.base64, "base64");
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(small).toMatchObject({ pages: 1, total: 10000, replaced: [] });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("Quotation");

    const big = await buildPdf({ title: "Price list", rows: Array.from({ length: 120 }, (_, i) => ({ Item: `Part ${i + 1} with a fairly long description that wraps`, Qty: 1, Price: i })) });
    expect(big.pages).toBeGreaterThan(2);
    expect(big.total).toBe((119 * 120) / 2);
  });
});
