export default class ApiError extends Error {
  constructor(statusCode, message, { code, details } = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code || ApiError.codeForStatus(statusCode);
    this.details = details;
    Error.captureStackTrace?.(this, ApiError);
  }

  static codeForStatus(status) {
    const map = {
      400: "BAD_REQUEST",
      404: "NOT_FOUND",
      409: "CONFLICT",
      413: "PAYLOAD_TOO_LARGE",
      415: "UNSUPPORTED_MEDIA_TYPE",
      422: "UNPROCESSABLE_ENTITY",
      500: "INTERNAL_ERROR",
      503: "SERVICE_UNAVAILABLE",
    };
    return map[status] || "ERROR";
  }

  static badRequest(message, opts) {
    return new ApiError(400, message, opts);
  }

  static notFound(message = "Resource not found", opts) {
    return new ApiError(404, message, opts);
  }

  static unsupportedMediaType(message, opts) {
    return new ApiError(415, message, opts);
  }

  static unprocessable(message, opts) {
    return new ApiError(422, message, opts);
  }

  static internal(message = "Internal server error", opts) {
    return new ApiError(500, message, opts);
  }

  static unavailable(message = "Service unavailable", opts) {
    return new ApiError(503, message, opts);
  }
}
