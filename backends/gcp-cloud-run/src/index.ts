import express from "express";
import proxyRouter from "./routes/proxy";
import adminRouter from "./routes/admin";
import sessionRouter from "./routes/session";

const app = express();
const PORT = parseInt(process.env.PORT || "8080");

// ── Middleware ──────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));

// ── Health check ───────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Session routes (adaptive provisioning) ─────────────────
app.use(sessionRouter);

// ── Proxy routes ───────────────────────────────────────────
app.use(proxyRouter);

// ── Admin routes (includes /admin/topics/*) ────────────────
app.use("/admin", adminRouter);

// ── 404 handler ────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    error: "not_found",
    message: "Unknown endpoint. Available: POST /v1/chat, /v1/session, /admin/*, GET /health",
  });
});

// ── Error handler ──────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "internal_error",
    message: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
  });
});

// ── Start server ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`LLM Proxy running on port ${PORT}`);
  console.log(`  Proxy:  POST http://localhost:${PORT}/v1/chat`);
  console.log(`  Admin:  http://localhost:${PORT}/admin/*`);
  console.log(`  Health: http://localhost:${PORT}/health`);
});

export default app;
