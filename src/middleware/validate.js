import { AppError } from "../utils/AppError.js";

/** Validate req.body against a zod schema; replaces it with the cleaned values. */
export const validate = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const fields = {};
    for (const issue of result.error.issues) {
      const key = issue.path[0] ?? "form";
      fields[key] ??= issue.message;
    }
    return next(
      new AppError("Please check the highlighted fields.", 422, {
        code: "VALIDATION_ERROR",
        details: fields,
      }),
    );
  }
  req.body = result.data;
  next();
};
