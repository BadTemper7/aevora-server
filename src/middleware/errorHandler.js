import { isProd } from "../config/env.js";

export function errorHandler(err, _req, res, _next) {
  let { statusCode = 500, message, code, details } = err;

  // malformed JSON body
  if (err.type === "entity.parse.failed") {
    statusCode = 400;
    message = "Request body is not valid JSON.";
    code = "BAD_JSON";
  }

  // unique index hit (a race the pre-check can't catch)
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? "field";
    statusCode = 409;
    code = "DUPLICATE";
    message = `That ${field} is already taken.`;
    details = { [field]: message };
  }

  if (!err.isOperational && statusCode === 500) {
    console.error(err);
    message = isProd ? "Something went wrong." : err.message;
  }

  res.status(statusCode).json({
    success: false,
    error: { message, code, details },
  });
}
