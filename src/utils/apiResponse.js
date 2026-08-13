export function sendSuccess(res, data, statusCode = 200, meta) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

export function sendError(res, statusCode, message, { code, details } = {}) {
  return res.status(statusCode).json({
    success: false,
    error: {
      code: code || "ERROR",
      message,
      ...(details !== undefined ? { details } : {}),
    },
  });
}
