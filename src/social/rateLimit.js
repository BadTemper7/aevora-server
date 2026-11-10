import { rateLimit } from "express-rate-limit";
export const socialRateLimiter = rateLimit({ windowMs: 60 * 1000, limit: 150, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, error: { code: "RATE_LIMIT", message: "Too many requests. Please try again shortly." } } });
export const uploadRateLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, error: { code: "RATE_LIMIT", message: "Upload limit reached. Please try again shortly." } } });

export const friendRequestLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 12, keyGenerator: req => req.user.id, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, error: { code: "REQUEST_LIMIT", message: "Friend request limit reached. Try again later." } } });
export const messageSendLimiter = rateLimit({ windowMs: 60 * 1000, limit: 45, keyGenerator: req => req.user.id, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, error: { code: "MESSAGE_LIMIT", message: "You're sending messages too quickly." } } });
