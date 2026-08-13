import { Router } from "express";
import healthRoutes from "./health.routes.js";
import extractionRoutes from "./extraction.routes.js";

const router = Router();

router.use("/health", healthRoutes);
router.use("/extract/statements", extractionRoutes);

// Future route modules mount here, e.g.:
// router.use("/extract/invoices", invoiceRoutes);

export default router;
