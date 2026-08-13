import { Router } from "express";
import asyncHandler from "../middleware/asyncHandler.js";
import { uploadPdf, requirePdfFile } from "../middleware/upload.js";
import { validateIdParam } from "../middleware/validators.js";
import {
  createExtraction,
  listExtractions,
  getExtraction,
  getRawData,
  getProcessedData,
  reanalyze,
  deleteExtraction,
} from "../controllers/extraction.controller.js";

const router = Router();

router.post("/", uploadPdf, requirePdfFile, asyncHandler(createExtraction));
router.get("/", asyncHandler(listExtractions));
router.get("/:id", validateIdParam, asyncHandler(getExtraction));
router.get("/:id/raw", validateIdParam, asyncHandler(getRawData));
router.get("/:id/processed", validateIdParam, asyncHandler(getProcessedData));
router.post("/:id/reanalyze", validateIdParam, asyncHandler(reanalyze));
router.delete("/:id", validateIdParam, asyncHandler(deleteExtraction));

export default router;
