import { z } from "zod";
import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/responseHandler.js";

export const wrap = (handler) => asyncHandler(async (req, res) => {
  const data = await handler(req, res);
  if (!res.headersSent) sendSuccess(res, data);
});
export function body(req, schema) {
  const result = schema.safeParse(req.body);
  if (!result.success) throw new AppError("Please correct the highlighted fields.", 400, { code: "VALIDATION_ERROR", details: result.error.flatten() });
  return result.data;
}
export const short = z.string().trim().min(1).max(200);
export function assert(condition, message = "Not permitted.", status = 403) { if (!condition) throw new AppError(message, status); }
