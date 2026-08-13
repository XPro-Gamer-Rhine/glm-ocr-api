import ApiError from "../utils/ApiError.js";
import { ID_PATTERN } from "../utils/ids.js";

export function validateIdParam(req, _res, next) {
  const { id } = req.params;
  if (!ID_PATTERN.test(id)) {
    return next(ApiError.badRequest(`Invalid extraction id "${id}".`));
  }
  next();
}
