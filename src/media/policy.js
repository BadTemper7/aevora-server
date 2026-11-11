/** Pure policy helpers used by worker, upload, and storage tests. */
export const imageSizes = Object.freeze({ avatar: 512, cover: 1920, post: 1920, story: 1920, message: 1600, community: 1920, video: 480 });
export const maxImageWidth = (purpose, variant) => variant === "icon" ? 512 : Math.max(256, Math.min(4096, Number(process.env[`IMAGE_MAX_WIDTH_${String(purpose).toUpperCase()}`]) || imageSizes[purpose] || 1600));
export const videoMaxHeight = () => Math.max(480, Math.min(2160, Number(process.env.VIDEO_MAX_HEIGHT || 1080)));
export const percentageSaved = (before, after) => before > 0 ? Math.round(Math.max(0, (before - after) / before) * 1000) / 10 : 0;
export function preferOriginal({ originalBytes, optimizedBytes, mime, width, height, maxWidth, orientation = 1 }) {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(mime)
    && orientation === 1 && width <= maxWidth && height <= maxWidth && originalBytes <= optimizedBytes;
}
export const storageMime = (kind, sourceMime, keepOriginal = false) => keepOriginal ? sourceMime : kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mp4' : kind === 'file' ? sourceMime : 'image/webp';
