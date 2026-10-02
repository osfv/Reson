import { convertFileSrc } from "@tauri-apps/api/core";
import type { Album, Palette } from "./api";

export const DEFAULT_PALETTE: Palette = {
  bg: "#141416",
  surface: "#202024",
  accent: "#f4b860",
  onAccent: "#1c1408",
};

const INK = "#f2f1ee";

function chroma(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

/** Album palette, with near-gray accents (from black-and-white or muted covers) swapped for clean
 * off-white. A desaturated tinted gray reads as "disabled" on buttons; white reads as intentional. */
export const paletteOf = (album?: Album | null): Palette => {
  const p = album?.palette ?? DEFAULT_PALETTE;
  return chroma(p.accent) < 0.12 ? { ...p, accent: INK, onAccent: "#141416" } : p;
};

/** Pushes a palette into the root CSS variables. They are registered with @property so the
 * browser interpolates them, which is what makes the whole UI blend between albums. */
export function applyPalette(p: Palette) {
  const root = document.documentElement.style;
  root.setProperty("--bg", p.bg);
  root.setProperty("--surface", p.surface);
  root.setProperty("--accent", p.accent);
  root.setProperty("--on-accent", p.onAccent);
}

const srcCache = new Map<string, string>();
export function coverSrc(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  let src = srcCache.get(path);
  if (!src) srcCache.set(path, (src = convertFileSrc(path)));
  return src;
}
