import { Router } from "express";
import asyncHandler from "../middleware/asyncHandler.js";
import { getHealth } from "../controllers/health.controller.js";

const router = Router();

router.get("/", asyncHandler(getHealth));

export default router;
