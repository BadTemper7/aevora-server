/** Keep one optimized ImageKit object per image/GIF.
 * Serve small previews via signed, on-demand ImageKit transformations.
 * Video poster frames remain independent because ImageKit cannot derive
 * the first frame in every delivery configuration. Local previews stay cached.
 */
export function needsStoredThumbnail(kind, provider) {
  return kind === 'video' || (provider !== 'imagekit' && (kind === 'image' || kind === 'gif'));
}

export const isDynamicImageThumbnail = (media) => Boolean(
  media && media.storageProvider === 'imagekit' &&
  (media.kind === 'image' || media.kind === 'gif') &&
  media.objectKey && !media.thumbObjectKey
);
