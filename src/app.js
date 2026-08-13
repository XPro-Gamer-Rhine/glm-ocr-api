import express from "express";
import cors from "cors";
import apiRoutes from "./routes/index.js";
import requestLogger from "./middleware/requestLogger.js";
import notFound from "./middleware/notFound.js";
import errorHandler from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use(requestLogger);

  app.get("/", (_req, res) => {
    res.json({
      name: "dime-ocr",
      description: "PDF data extraction API powered by GLM-OCR",
      endpoints: {
        health: "GET /api/v1/health",
        createExtraction: "POST /api/v1/extract/statements (multipart field: file, optional ?sync=true, ?ocr=false)",
        listExtractions: "GET /api/v1/extract/statements",
        getExtraction: "GET /api/v1/extract/statements/:id",
        getRawData: "GET /api/v1/extract/statements/:id/raw",
        getProcessedData: "GET /api/v1/extract/statements/:id/processed",
        reanalyze: "POST /api/v1/extract/statements/:id/reanalyze",
        deleteExtraction: "DELETE /api/v1/extract/statements/:id",
      },
    });
  });

  app.use("/api/v1", apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
