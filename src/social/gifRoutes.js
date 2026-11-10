import { Router } from "express";
import { z } from "zod";
import { AppError } from "../utils/AppError.js";
import { GifFavorite, Media } from "./models.js";
import { objectId } from "./helpers.js";
import { body, wrap } from "./routeUtils.js";
import { uploadRateLimiter } from "./rateLimit.js";

const router = Router();
// GIPHY's API policies require browser-side search. Its API key is a client
// integration key, and no GIF files, rendition URLs or search responses are
// cached by the Aevora server. Personal uploads remain private Aevora media.
const favoriteInput = z.discriminatedUnion("source", [
  z.object({ source: z.literal("giphy"), sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,90}$/) }).strict(),
  z.object({ source: z.literal("upload"), sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,90}$/), mediaId: z.string() }).strict(),
]);

router.get("/gifs/mine", wrap(async (req) => {
  const items = await Media.find({ ownerId: req.user.id, purpose: "message", kind: "gif", status: "ready" }).sort({ createdAt: -1 }).limit(60).select("_id originalName createdAt").lean();
  return items.map((item) => ({ id: String(item._id), source: "upload", mediaId: String(item._id), description: item.originalName || "My GIF" }));
}));
router.get("/gifs/favorites", wrap(async (req) => {
  // Legacy Tenor favorites stay in MongoDB but cannot be returned as live GIPHY
  // assets after Tenor's API shutdown. Users may remove them in a migration.
  const items = await GifFavorite.find({ userId: req.user.id, source: { $in: ["giphy", "upload"] } }).sort({ createdAt: -1 }).limit(100).lean();
  return items.map((item) => ({ favoriteId: String(item._id), id: item.sourceId, source: item.source, mediaId: item.mediaId ? String(item.mediaId) : undefined }));
}));
router.post("/gifs/favorites", uploadRateLimiter, wrap(async (req) => {
  const data = body(req, favoriteInput);
  if (data.source === "upload") {
    const media = await Media.findOne({ _id: objectId(data.mediaId), ownerId: req.user.id, kind: "gif", status: "ready", purpose: "message" }).lean();
    if (!media || String(media._id) !== data.sourceId) throw new AppError("GIF not found.", 404);
  }
  const result = await GifFavorite.findOneAndUpdate(
    { userId: req.user.id, source: data.source, sourceId: data.sourceId },
    { $set: { mediaId: data.source === "upload" ? data.mediaId : undefined }, $unset: { url: "", previewUrl: "" } },
    { upsert: true, new: true, runValidators: true },
  );
  return { id: String(result._id) };
}));
router.delete("/gifs/favorites/:id", wrap(async (req) => {
  const item = await GifFavorite.findOneAndDelete({ _id: objectId(req.params.id), userId: req.user.id });
  if (!item) throw new AppError("Favorite not found.", 404);
  return { removed: true };
}));
export default router;
