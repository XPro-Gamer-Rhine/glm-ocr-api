import multer from "multer";
import config from "../config/index.js";
import ApiError from "../utils/ApiError.js";
import { sendError } from "../utils/apiResponse.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("error");

// eslint-disable-next-line no-unused-vars
export default function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? `File too large. Limit is ${config.extraction.maxFileSizeBytes / 1024 / 1024} MB.`
        : `Upload error: ${err.message}`;
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return sendError(res, status, message, { code: err.code });
  }

  if (err instanceof ApiError) {
    if (err.statusCode >= 500) log.error(err.message, err.details ?? "");
    return sendError(res, err.statusCode, err.message, { code: err.code, details: err.details });
  }

  log.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err.stack || err);
  return sendError(res, 500, "Internal server error", { code: "INTERNAL_ERROR" });
}
