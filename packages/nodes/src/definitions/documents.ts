import type { NodeDefinition, ParamField } from "../types";

/** The fields that describe a document, shared by "Make PDF" and "WhatsApp: send a PDF". */
export const documentFields = (ai = false): ParamField[] => [
  { kind: "string", name: "title", label: "Title", required: true, placeholder: "Quotation", aiFill: ai },
  { kind: "string", name: "reference", label: "Reference line", placeholder: "Q-12 · 26 Nov 2026 · valid 15 days", aiFill: ai },
  { kind: "string", name: "from", label: "From (your company)", multiline: true, placeholder: "Your company name\nAddress, GST no., phone" },
  { kind: "string", name: "to_name", label: "For (customer)", multiline: true, placeholder: "Mehta Traders, Pune", aiFill: ai },
  { kind: "string", name: "intro", label: "Text", multiline: true, aiFill: ai, description: "A few lines before the table." },
  {
    kind: "string",
    name: "rows",
    label: "Table",
    multiline: true,
    aiFill: ai,
    placeholder: "Item | Qty | Price\nSteel pipe 2in | 50 | 200",
    description: "Lines with | between columns (first line = headers), or a JSON list. With Qty and Price columns, an Amount column and the total are added.",
  },
  { kind: "string", name: "currency", label: "Currency", default: "Rs.", expression: false, description: "Shown before prices and the total. (₹ can't be drawn by the PDF fonts, so use Rs.)" },
  { kind: "string", name: "notes", label: "Notes", multiline: true, aiFill: ai, placeholder: "Prices exclude GST. Delivery in 7 days." },
  { kind: "string", name: "fileName", label: "File name", placeholder: "quotation-mehta.pdf", aiFill: ai },
];

export const pdfNode: NodeDefinition = {
  type: "doc.pdf",
  version: 1,
  name: "Make PDF document",
  description: "Turn a title, some text and a table into a clean A4 PDF: quotations, invoices, reports. Totals are worked out for you. The file comes out as base64, ready for WhatsApp, Gmail or Drive.",
  category: "transform",
  icon: "FileText",
  color: "emerald",
  keywords: ["pdf", "document", "quotation", "quote", "invoice", "bill", "report", "file", "estimate"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  fields: [...documentFields(), { kind: "string", name: "outputField", label: "Save as", default: "pdf", required: true, expression: false }],
  outputSample: { pdf: { fileName: "quotation.pdf", mimetype: "application/pdf", size: 2210, pages: 1, total: 10000, base64: "JVBERi0xLjcK…" } },
};
