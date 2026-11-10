import { AppError } from "../utils/AppError.js";

/** Gate by role. Always place after authenticate: router.get(p, authenticate, authorize("admin"), handler) */
export const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(new AppError("Please log in to continue.", 401, { code: "UNAUTHENTICATED" }));
    if (!roles.includes(req.user.role)) {
      return next(new AppError("You don't have access to this.", 403, { code: "FORBIDDEN" }));
    }
    next();
  };
