import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { toNodeHandler } from "better-auth/node";

import { corsOptions } from "./config/cors.js";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import accountRoutes from "./routes/accountRoutes.js";
import peopleRoutes from "./social/peopleRoutes.js";
import messageRoutes from "./social/messageRoutes.js";
import videoRoutes from "./social/videoRoutes.js";
import notificationRoutes from "./social/notificationRoutes.js";
import moderationRoutes from "./social/moderationRoutes.js";
import mediaRoutes from "./media/routes.js";
import feedRoutes from "./social/feedRoutes.js";
import storyRoutes from "./social/storyRoutes.js";
import gifRoutes from "./social/gifRoutes.js";
import { socialRateLimiter } from "./social/rateLimit.js";
import { authenticate } from "./middleware/authenticate.js";
import communityRoutes from "./communities/communityRoutes.js";
import channelRoutes from "./communities/channelRoutes.js";
import communityMediaRoutes from "./communities/mediaRoutes.js";
import communityEventRoutes from "./communities/eventRoutes.js";
import { livekitWebhook } from "./communities/mediaService.js";
import { mountProductionClient } from "./productionClient.js";

export function createApp(auth) {
  const app = express();
  app.locals.auth = auth;
  app.disable("x-powered-by");
  app.use(helmet({ crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }, crossOriginResourcePolicy: { policy: "same-origin" } }));
  app.use(cors(corsOptions));
  if (env.NODE_ENV === "development") app.use(morgan("dev"));
  // Auth consumes the raw request before JSON middleware.
  app.all("/api/auth/*", toNodeHandler(auth));
  // LiveKit signs webhook POST bodies. Keep original bytes, and verify before processing.
  app.post("/api/livekit/webhook", express.text({ type: "application/webhook+json", limit: "256kb" }), async (req, res) => {
    try { await livekitWebhook(req.body, req.get("Authorization")); res.sendStatus(200); }
    catch (error) { console.warn("LiveKit webhook rejected:", error.message); res.sendStatus(401); }
  });
  // Story batches contain validated slide metadata and up to 240 sticker layers.
  // Parse only this API subtree at a higher limit; keep general API JSON small.
  app.use('/api/social/stories', express.json({ limit: '256kb' }));
  app.use(express.json({ limit: "16kb" }));
  app.get("/api/health", (_req, res) => res.json({ success: true, data: { status: "ok" } }));
  app.use("/api", accountRoutes);
  app.use("/api/social", (req, _res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.headers.origin && req.headers.origin !== new URL(env.CLIENT_URL).origin) {
      const error = new Error("Request origin is not allowed.");
      error.statusCode = 403;
      error.isOperational = true;
      return next(error);
    }
    next();
  });
  app.use("/api/social", authenticate, socialRateLimiter, peopleRoutes, messageRoutes, gifRoutes, videoRoutes, notificationRoutes, moderationRoutes, feedRoutes, storyRoutes, mediaRoutes);
  app.use("/api", (req, _res, next) => {
    // CSRF hardening for community and voice mutations, consistent with social APIs.
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.headers.origin && req.headers.origin !== new URL(env.CLIENT_URL).origin) {
      const error = new Error("Request origin is not allowed."); error.statusCode = 403; return next(error);
    }
    next();
  }, authenticate, socialRateLimiter, communityRoutes, channelRoutes, communityMediaRoutes, communityEventRoutes);
  // In production, React and the API share one HTTPS origin.
  mountProductionClient(app);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
