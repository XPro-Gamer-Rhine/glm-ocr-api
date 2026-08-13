import fs from "node:fs";
import * as mupdf from "mupdf";

/**
 * PDF access via MuPDF's WASM build — no system dependencies (no poppler,
 * no native canvas), so it runs identically on macOS, Linux and Windows.
 *
 * Pages are rendered one at a time so huge PDFs never hold more than a
 * single page bitmap in memory.
 */
export default class PdfRenderer {
  constructor(filePath, { dpi = 150 } = {}) {
    const data = fs.readFileSync(filePath);
    this.doc = mupdf.Document.openDocument(data, "application/pdf");
    this.dpi = dpi;
  }

  get pageCount() {
    return this.doc.countPages();
  }

  /** Render one page (0-based) to a PNG buffer; dpiOverride for retries. */
  renderPageToPng(pageIndex, dpiOverride) {
    const page = this.doc.loadPage(pageIndex);
    try {
      const scale = (dpiOverride || this.dpi) / 72;
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true
      );
      try {
        return Buffer.from(pixmap.asPNG());
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  /** Extract the embedded text layer of one page (empty string for scans). */
  extractPageText(pageIndex) {
    const page = this.doc.loadPage(pageIndex);
    try {
      const structured = page.toStructuredText("preserve-whitespace");
      try {
        return structured.asText();
      } finally {
        structured.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  getMetadata() {
    const read = (key) => {
      try {
        return this.doc.getMetaData(key) || null;
      } catch {
        return null;
      }
    };
    return {
      title: read("info:Title"),
      author: read("info:Author"),
      creator: read("info:Creator"),
      producer: read("info:Producer"),
      creationDate: read("info:CreationDate"),
    };
  }

  close() {
    this.doc.destroy();
  }
}
