import { Router } from "express";

import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { sendSuccess } from "../utils/responseHandler.js";

const router = Router();

// any signed-in user
router.get("/me", authenticate, (req, res) => sendSuccess(res, { user: req.user }));

// example of a role-gated route: signed in AND role === "admin"
router.get("/admin/ping", authenticate, authorize("admin"), (_req, res) => sendSuccess(res, { pong: true }));

export default router;
