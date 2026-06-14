// Share-link routing: the pure URL→media-format decision, with no browser APIs
// or dependencies, so both app.ts (bundled) and node:test can import it.
// The extension sets mirror detectFormat()'s audio/video branch in app.ts —
// keep them in sync; detectFormat reuses these sets so they are the source of truth.

// Audio file extensions Folium treats as streamable linked media.
export const AUDIO_EXT = new Set(['mp3', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac']);
// Video file extensions Folium treats as streamable linked media.
export const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv']);

/** Last path/segment extension, lowercased, or '' (query/hash stripped first). */
export function extOf(nameOrPath) {
  const s = String(nameOrPath).split('?')[0].split('#')[0];
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1).toLowerCase() : '';
}

/**
 * If a URL's path points at an audio/video file, return its format; otherwise
 * null (→ caller shelves the URL as a note instead). Non-URLs return null.
 * @param {string} url
 * @returns {'audio' | 'video' | null}
 */
export function mediaFormatForUrl(url) {
  try {
    const p = new URL(url).pathname;
    const e = extOf(p);
    if (AUDIO_EXT.has(e)) return 'audio';
    if (VIDEO_EXT.has(e)) return 'video';
    return null;
  } catch {
    return null;
  }
}
