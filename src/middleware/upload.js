import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import config from "../config/index.js";
import ApiError from "../utils/ApiError.js";
import { newId } from "../utils/ids.js";

fs.mkdirSync(config.storage.uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.storage.uploadsDir),
  filename: (req, file, cb) => {
    // The upload id becomes the extraction id — one PDF per extraction record.
    req.extractionId = newId();
    const ext = path.extname(file.originalname).toLowerCase() || ".pdf";
    cb(null, `${req.extractionId}${ext}`);
  },
});

function fileFilter(_req, file, cb) {
  const isPdfMime = file.mimetype === "application/pdf" || file.mimetype === "application/x-pdf";
  const isPdfExt = path.extname(file.originalname).toLowerCase() === ".pdf";
  if (isPdfMime || isPdfExt) return cb(null, true);
  cb(ApiError.unsupportedMediaType(`Only PDF files are accepted (got "${file.mimetype}").`));
}

const uploader = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.extraction.maxFileSizeBytes, files: 1 },
});

/** Accepts the PDF as multipart field "file" (falls back to "pdf"). */
export const uploadPdf = uploader.fields([
  { name: "file", maxCount: 1 },
  { name: "pdf", maxCount: 1 },
]);

/** Normalises multer's fields shape to req.file and enforces presence. */
export function requirePdfFile(req, _res, next) {
  const file = req.files?.file?.[0] || req.files?.pdf?.[0];
  if (!file) {
    return next(
      ApiError.badRequest('No PDF uploaded. Send the file as multipart form field "file".')
    );
  }
  req.file = file;
  next();
}
