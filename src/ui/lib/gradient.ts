/**
 * Tiny, dependency-free hex color interpolation. Used for the wordmark banner's
 * teal gradient and the subtle separator fade. Pure math — no React, no deps.
 */
export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate between two hex colors. `t` is clamped to [0, 1]. */
export function lerpHex(a: string, b: string, t: number): string {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  return rgbToHex([
    lerp(ra[0], rb[0], tt),
    lerp(ra[1], rb[1], tt),
    lerp(ra[2], rb[2], tt),
  ]);
}

/**
 * Produce `n` hex colors spanning `stops` with piecewise-linear interpolation.
 * `gradient(['#000','#fff'], 3)` → ['#000000', '#808080', '#ffffff'].
 */
export function gradient(stops: string[], n: number): string[] {
  const first = stops[0] ?? '#000000';
  if (n <= 0) return [];
  if (n === 1) return [first];
  if (stops.length === 1) return Array.from({ length: n }, () => first);

  const segments = stops.length - 1;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const pos = (i / (n - 1)) * segments;
    const seg = Math.min(segments - 1, Math.floor(pos));
    const t = pos - seg;
    out.push(lerpHex(stops[seg] ?? first, stops[seg + 1] ?? first, t));
  }
  return out;
}
