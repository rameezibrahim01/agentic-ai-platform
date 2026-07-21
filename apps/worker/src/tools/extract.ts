// Shared content extraction (ticket 065, lifted from files.ts): the SAME
// parsers, caps, and refusal shapes serve every connector that meets a PDF,
// a workbook, or plain text — a file on disk (057/061/062) or a mail
// attachment (065). Byte-based cores; path handling stays in files.ts.

/** PDFs are parsed in memory — the cap applies BEFORE parsing (ticket 061). */
export const PDF_INPUT_CAP_BYTES = 4 * 1024 * 1024;
/** Workbooks too (ticket 062): refuse typed before the parser can OOM. */
export const XLSX_INPUT_CAP_BYTES = 4 * 1024 * 1024;
export const PDF_NO_TEXT_NOTE =
  "no extractable text — likely a scanned/image-only PDF (OCR is out of scope)";
export const SHEET_ROW_CAP = 500;

/** Extensions the text branch decodes as UTF-8 as-is. */
export const TEXT_EXTENSIONS = [".txt", ".md", ".csv", ".json", ".log"];

/** UTF-8 byte cap with a truncated flag — every extracted text leaves capped. */
export function capUtf8(text: string, capBytes: number): { text: string; truncated: boolean } {
  const truncated = Buffer.byteLength(text, "utf8") > capBytes;
  return {
    text: truncated ? Buffer.from(text, "utf8").subarray(0, capBytes).toString("utf8") : text,
    truncated,
  };
}

export function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Text-layer extraction only (ticket 061): parseable-but-textless PDFs come
 * back empty — the CALLER attaches PDF_NO_TEXT_NOTE; OCR is out of scope.
 * `label` names the refusing tool in every error (docs.read, mail.attachment). */
export async function extractPdfTextFromBytes(bytes: Buffer, label: string): Promise<string> {
  if (bytes.length > PDF_INPUT_CAP_BYTES) {
    throw new Error(
      `${label} refused: PDF is ${bytes.length} bytes; the parse cap is ${PDF_INPUT_CAP_BYTES}`,
    );
  }
  interface PdfDocument {
    numPages: number;
    getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string }[] }> }>;
    destroy(): Promise<void>;
  }
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument(params: { data: Uint8Array; verbosity: number }): { promise: Promise<PdfDocument> };
  };
  let doc: PdfDocument;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  } catch (error) {
    throw new Error(`${label} refused: cannot parse PDF (${(error as Error).message})`);
  }
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const content = await (await doc.getPage(pageNumber)).getTextContent();
      pages.push(content.items.map((item) => item.str ?? "").join(" "));
    }
    return pages.join("\n").trim();
  } finally {
    await doc.destroy();
  }
}

/** How a person reads the cell (ticket 062): numbers plain, dates ISO,
 * formula cells as their cached RESULT, empty as "". */
export function coerceCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const cell = value as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (cell.richText !== undefined) return cell.richText.map((part) => part.text).join("");
    if (cell.result !== undefined) return coerceCell(cell.result);
    if (cell.text !== undefined) return coerceCell(cell.text);
    return JSON.stringify(value);
  }
  return String(value);
}

export interface XlsxTable {
  header: string[];
  rows: string[][];
  truncated: boolean;
  sheets: string[];
}

export async function readXlsxFromBytes(
  bytes: Buffer,
  cap: number,
  label: string,
): Promise<XlsxTable> {
  if (bytes.length > XLSX_INPUT_CAP_BYTES) {
    throw new Error(
      `${label} refused: workbook is ${bytes.length} bytes; the parse cap is ${XLSX_INPUT_CAP_BYTES}`,
    );
  }
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch (error) {
    throw new Error(`${label} refused: cannot parse workbook (${(error as Error).message})`);
  }
  const sheets = workbook.worksheets.map((sheet) => sheet.name);
  const first = workbook.worksheets[0];
  const records: string[][] = [];
  first?.eachRow({ includeEmpty: false }, (row) => {
    // row.values is 1-indexed with an empty slot 0
    const values = (row.values as unknown[]).slice(1);
    records.push(values.map(coerceCell));
  });
  const header = records[0] ?? [];
  const body = records.slice(1);
  const truncated = body.length > cap;
  return { header, rows: truncated ? body.slice(0, cap) : body, truncated, sheets };
}

/** An XlsxTable rendered back to escaped CSV lines — for surfaces that carry
 * one text field (mail.attachment) rather than structured rows. */
export function renderTableAsCsv(table: Pick<XlsxTable, "header" | "rows">): string {
  return [table.header, ...table.rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}
