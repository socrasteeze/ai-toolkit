/**
 * nvidia-smi prints `[N/A]` or `[Not Supported]` for sensors a GPU does not
 * expose (laptop fan, some power limits). Callers show "-" for null. A real
 * zero stays zero.
 */
export function smiNumber(raw: string | undefined, asFloat = false): number | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (text === '' || /^\[?(?:n\/a|not supported)\]?$/i.test(text)) return null;
  const value = asFloat ? Number.parseFloat(text) : Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : null;
}
