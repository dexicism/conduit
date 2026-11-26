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

/** "Send it on WhatsApp too": lets an AI tool make a file and send it in one go. */
const sendFields = (): ParamField[] => [
  { kind: "string", name: "fileName", label: "File name", aiFill: true },
  { kind: "credential", name: "sendWith", label: "Send on WhatsApp from", app: "whatsappWeb", description: "Optional. Sends the file right away." },
  { kind: "string", name: "sendTo", label: "Send to", aiFill: true, placeholder: "+919876543210 or a chat id" },
  { kind: "string", name: "caption", label: "Message with it", multiline: true, aiFill: true },
  { kind: "string", name: "outputField", label: "Save as", default: "file", required: true, expression: false },
];

const fileSample = (name: string, mimetype: string, extra: Record<string, unknown> = {}) => ({ file: { fileName: name, mimetype, size: 5120, ...extra, base64: "UEsDBBQ..." } });

export const excelNode: NodeDefinition = {
  type: "doc.excel",
  version: 1,
  name: "Make Excel file",
  description: "Make a real .xlsx file: from a table someone wrote (or the AI read from photos), from the items coming in, or from a Google Sheet tab (all rows, or only the ones that match). Bold header, numbers as numbers, phone numbers kept as text.",
  category: "transform",
  icon: "FileSpreadsheet",
  color: "emerald",
  keywords: ["excel", "xlsx", "spreadsheet", "export", "download", "table", "file", "convert"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  asTool: { name: "make_excel", description: "Make an Excel (.xlsx) file and, if a WhatsApp number and recipient are set, send it. Rows: lines like 'Name | Phone | City', first line = headers. Or export rows of a sheet tab that contain a value." },
  fields: [
    {
      kind: "select",
      name: "source",
      label: "Rows from",
      default: "rows",
      options: [
        { value: "rows", label: "A table (written or from the AI)" },
        { value: "sheet", label: "A Google Sheet tab" },
        { value: "items", label: "All the items coming in (one file)" },
      ],
    },
    { kind: "string", name: "rows", label: "Table", multiline: true, aiFill: true, placeholder: "Name | Phone | City\nMohan | 9800000101 | Gurugram", showIf: { field: "source", equals: ["rows"] } },
    { kind: "credential", name: "credential", label: "Google account", app: "google", showIf: { field: "source", equals: ["sheet"] } },
    { kind: "string", name: "spreadsheetId", label: "Spreadsheet", placeholder: "Spreadsheet URL or ID", showIf: { field: "source", equals: ["sheet"] } },
    { kind: "string", name: "sheet", label: "Tab", default: "Sheet1", showIf: { field: "source", equals: ["sheet"] } },
    { kind: "string", name: "filterColumn", label: "Only rows where column", aiFill: true, placeholder: "Assigned To (or empty: any column)", showIf: { field: "source", equals: ["sheet"] } },
    { kind: "string", name: "filterValue", label: "contains", aiFill: true, placeholder: "Ravi (empty = all rows)", showIf: { field: "source", equals: ["sheet"] } },
    { kind: "string", name: "sheetName", label: "Sheet name in the file", default: "Sheet1", aiFill: true },
    ...sendFields(),
  ],
  outputSample: fileSample("leads.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", { rows: 12 }),
};

const filesField = (label: string, description: string): ParamField => ({ kind: "string", name: "files", label, required: true, multiline: true, aiFill: true, placeholder: "${['$input']['media']['id']}", description });

export const imagesToPdfNode: NodeDefinition = {
  type: "doc.imagesToPdf",
  version: 1,
  name: "Photos to PDF",
  description: "Put photos (JPEG or PNG) into one PDF, one per page, scaled to fit A4. Give WhatsApp media IDs (comma or line separated), data: URLs or base64.",
  category: "transform",
  icon: "Files",
  color: "emerald",
  keywords: ["pdf", "photos", "images", "scan", "convert", "jpg", "png", "combine"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  asTool: { name: "photos_to_pdf", description: "Put photos into one PDF (by their media IDs from the chat) and, if set, send it on WhatsApp." },
  fields: [filesField("Photos", "Media IDs, in order."), { kind: "string", name: "title", label: "PDF title", aiFill: true }, ...sendFields()],
  outputSample: fileSample("photos.pdf", "application/pdf", { pages: 3 }),
};

export const pdfMergeNode: NodeDefinition = {
  type: "doc.pdfMerge",
  version: 1,
  name: "Merge PDFs",
  description: "Join several PDFs (and photos) into one PDF, in the order given.",
  category: "transform",
  icon: "Files",
  color: "emerald",
  keywords: ["pdf", "merge", "combine", "join", "append"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  asTool: { name: "merge_pdfs", description: "Join PDFs and photos (by media ID, in order) into one PDF and, if set, send it on WhatsApp." },
  fields: [filesField("Files", "Media IDs of PDFs or photos, in order."), ...sendFields()],
  outputSample: fileSample("merged.pdf", "application/pdf", { pages: 7 }),
};

export const pdfPagesNode: NodeDefinition = {
  type: "doc.pdfPages",
  version: 1,
  name: "Pick PDF pages",
  description: "Keep only some pages of a PDF (split it), like 1-3, 5 or last.",
  category: "transform",
  icon: "Scissors",
  color: "emerald",
  keywords: ["pdf", "split", "pages", "extract", "cut", "remove pages"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  asTool: { name: "pdf_pages", description: "Make a PDF with only some pages of another (e.g. 2-4) and, if set, send it on WhatsApp." },
  fields: [
    { kind: "string", name: "file", label: "PDF", required: true, aiFill: true, placeholder: "${['$input']['media']['id']}" },
    { kind: "string", name: "pages", label: "Pages", required: true, aiFill: true, placeholder: "1-3, 5" },
    ...sendFields(),
  ],
  outputSample: fileSample("quote-pages.pdf", "application/pdf", { pages: 3 }),
};

export const pdfStampNode: NodeDefinition = {
  type: "doc.pdfStamp",
  version: 1,
  name: "Stamp text on a PDF",
  description: "Write text like APPROVED, PAID, a date or a reference onto a PDF: in a corner, in the middle, or across the page.",
  category: "transform",
  icon: "Stamp",
  color: "emerald",
  keywords: ["pdf", "stamp", "approved", "paid", "watermark", "date", "sign", "mark"],
  inputs: [{ id: "main" }],
  outputs: [{ id: "main" }],
  asTool: { name: "stamp_pdf", description: "Write text (e.g. APPROVED 26-11-26) onto a PDF and, if set, send it on WhatsApp." },
  fields: [
    { kind: "string", name: "file", label: "PDF", required: true, aiFill: true, placeholder: "${['$input']['media']['id']}" },
    { kind: "string", name: "text", label: "Text", required: true, aiFill: true, placeholder: "APPROVED" },
    {
      kind: "select",
      name: "position",
      label: "Where",
      default: "top-right",
      options: [
        { value: "top-right", label: "Top right" },
        { value: "top-left", label: "Top left" },
        { value: "bottom-right", label: "Bottom right" },
        { value: "bottom-left", label: "Bottom left" },
        { value: "center", label: "Middle" },
        { value: "diagonal", label: "Across the page (watermark)" },
      ],
    },
    { kind: "string", name: "pages", label: "Pages", aiFill: true, placeholder: "All (or e.g. 1, last)" },
    {
      kind: "select",
      name: "color",
      label: "Colour",
      default: "red",
      options: [
        { value: "red", label: "Red" },
        { value: "blue", label: "Blue" },
        { value: "green", label: "Green" },
        { value: "black", label: "Black" },
      ],
    },
    ...sendFields(),
  ],
  outputSample: fileSample("quote-stamped.pdf", "application/pdf", { pages: 2 }),
};
