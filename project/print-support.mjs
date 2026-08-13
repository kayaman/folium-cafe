// Pure printing helpers shared by the browser app and node:test.

/**
 * Resolve the requested one-based PDF pages.
 * @param {{ mode: 'current'|'single'|'range', current: number, single?: string|number, start?: string|number, end?: string|number, total: number }} input
 * @returns {{ pages: number[], error: null|'required'|'integer'|'bounds'|'order' }}
 */
export function resolvePrintPages(input) {
  const { mode, current, total } = input;
  if (!Number.isSafeInteger(total) || total < 1) return { pages: [], error: 'bounds' };

  const parsePage = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return { value: 0, error: 'required' };
    if (!/^\d+$/.test(raw)) return { value: 0, error: 'integer' };
    const page = Number(raw);
    if (!Number.isSafeInteger(page)) return { value: 0, error: 'integer' };
    if (page < 1 || page > total) return { value: page, error: 'bounds' };
    return { value: page, error: null };
  };

  if (mode === 'current') {
    const parsed = parsePage(current);
    return parsed.error ? { pages: [], error: parsed.error } : { pages: [parsed.value], error: null };
  }
  if (mode === 'single') {
    const parsed = parsePage(input.single);
    return parsed.error ? { pages: [], error: parsed.error } : { pages: [parsed.value], error: null };
  }
  if (mode !== 'range') return { pages: [], error: 'integer' };

  const start = parsePage(input.start);
  if (start.error) return { pages: [], error: start.error };
  const end = parsePage(input.end);
  if (end.error) return { pages: [], error: end.error };
  if (start.value > end.value) return { pages: [], error: 'order' };
  return {
    pages: Array.from({ length: end.value - start.value + 1 }, (_, i) => start.value + i),
    error: null,
  };
}

/** PDF points are 1/72 inch. Cap unusually large pages to a safe pixel budget. */
export function printRenderScale(widthPoints, heightPoints, dpi = 150, maxPixels = 16_000_000) {
  if (![widthPoints, heightPoints, dpi, maxPixels].every(n => Number.isFinite(n) && n > 0)) return 1;
  const requested = dpi / 72;
  const capped = Math.sqrt(maxPixels / (widthPoints * heightPoints));
  return Math.min(requested, capped);
}

/** Convert RGBA pixels to grayscale in place while preserving alpha. */
export function grayscalePixels(data) {
  for (let i = 0; i + 3 < data.length; i += 4) {
    const gray = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }
  return data;
}

/** True for the conventional browser print shortcut on Windows/Linux/macOS. */
export function isPrintShortcut(event) {
  return !!event && !event.altKey && (event.ctrlKey || event.metaKey)
    && String(event.key || '').toLowerCase() === 'p';
}
