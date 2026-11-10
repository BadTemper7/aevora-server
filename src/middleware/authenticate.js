import { fromNodeHeaders } from "better-auth/node";

import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/** Gate: a valid session cookie is required. Sets req.user and req.session. */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const session = await req.app.locals.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) throw new AppError("Please log in to continue.", 401, { code: "UNAUTHENTICATED" });

  // Only fully registered accounts can use application endpoints.
  if (!session.user.username) {
    throw new AppError("Choose a username to complete registration.", 403, { code: "REGISTRATION_INCOMPLETE" });
  }

  req.user = session.user;
  req.session = session.session;
  next();
});
