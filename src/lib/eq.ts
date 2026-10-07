import type { EqFilter, EqProfile, EqSettings } from "./api";

/** Must match `EQ_FREQS` in src-tauri/src/dsp.rs. */
export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const GRAPHIC_Q = 1.41;
export const MAX_GAIN = 12;

export const PRESETS: { name: string; bands: number[] }[] = [
  { name: "Flat", bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Bass boost", bands: [6, 5, 4, 2, 0.5, 0, 0, 0, 0, 0] },
  { name: "Bass reducer", bands: [-6, -5, -4, -2, -0.5, 0, 0, 0, 0, 0] },
  { name: "Treble boost", bands: [0, 0, 0, 0, 0, 0.5, 2, 3.5, 5, 6] },
  { name: "Vocal", bands: [-2, -2, -1, 0, 2, 3.5, 3.5, 2, 0, -1] },
  { name: "Loudness", bands: [5, 4, 2, 0, -1, -1, 0, 1.5, 3.5, 4.5] },
  { name: "Hip-hop", bands: [5, 4.5, 2, 3, -1, -1, 1, -0.5, 2, 3] },
  { name: "Electronic", bands: [4.5, 4, 1, 0, -2, 2, 1, 1, 4, 5] },
  { name: "Rock", bands: [4, 3, 2, 0.5, -1, -0.5, 1, 2.5, 3.5, 4] },
  { name: "Acoustic", bands: [3, 3, 2.5, 1, 1.5, 1, 2, 2.5, 2, 1.5] },
  { name: "Late night", bands: [2, 1.5, 1, 0, 0, 0, -1, -2, -3, -4] },
];

export const presetOf = (bands: number[]) =>
  PRESETS.find((p) => p.bands.every((g, i) => Math.abs(g - (bands[i] ?? 0)) < 0.05))?.name ?? "Custom";

export const bandLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);

/**
 * Parses an AutoEQ `ParametricEQ.txt`:
 *   Preamp: -6.2 dB
 *   Filter 1: ON LSC Fc 105 Hz Gain 6.0 dB Q 0.70
 */
export function parseAutoEq(text: string, fileName: string): EqProfile | null {
  const preamp = Number(/Preamp:\s*(-?[\d.]+)\s*dB/i.exec(text)?.[1] ?? 0);
  const filters: EqFilter[] = [];
  const kinds: Record<string, EqFilter["kind"]> = { PK: "peak", PEQ: "peak", LSC: "lowShelf", LS: "lowShelf", HSC: "highShelf", HS: "highShelf" };
  for (const m of text.matchAll(/Filter\s*\d*:\s*ON\s+([A-Z]+)\s+Fc\s+([\d.]+)\s*Hz\s+Gain\s+(-?[\d.]+)\s*dB(?:\s+Q\s+([\d.]+))?/gi)) {
    const kind = kinds[m[1].toUpperCase()];
    if (!kind) continue;
    filters.push({ kind, freq: Number(m[2]), gain: Number(m[3]), q: Number(m[4] ?? 0.71) });
  }
  if (!filters.length) return null;
  const name = fileName.replace(/\.txt$/i, "").replace(/\s*ParametricEQ$/i, "").trim() || "Imported profile";
  return { name, preamp, filters };
}

type Coeffs = [number, number, number, number, number];

/** RBJ cookbook biquad, normalized. Same math as `design()` in dsp.rs. */
function design(f: EqFilter, rate: number): Coeffs | null {
  if (f.freq <= 0 || f.freq >= rate * 0.49 || f.q <= 0) return null;
  const a = 10 ** (f.gain / 40);
  const w0 = (2 * Math.PI * f.freq) / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * f.q);
  const sa = 2 * Math.sqrt(a) * alpha;
  let c: [number, number, number, number, number, number];
  if (f.kind === "peak") c = [1 + alpha * a, -2 * cos, 1 - alpha * a, 1 + alpha / a, -2 * cos, 1 - alpha / a];
  else if (f.kind === "lowShelf")
    c = [
      a * (a + 1 - (a - 1) * cos + sa),
      2 * a * (a - 1 - (a + 1) * cos),
      a * (a + 1 - (a - 1) * cos - sa),
      a + 1 + (a - 1) * cos + sa,
      -2 * (a - 1 + (a + 1) * cos),
      a + 1 + (a - 1) * cos - sa,
    ];
  else
    c = [
      a * (a + 1 + (a - 1) * cos + sa),
      -2 * a * (a - 1 + (a + 1) * cos),
      a * (a + 1 + (a - 1) * cos - sa),
      a + 1 - (a - 1) * cos + sa,
      2 * (a - 1 - (a + 1) * cos),
      a + 1 - (a - 1) * cos - sa,
    ];
  const a0 = c[3];
  return [c[0] / a0, c[1] / a0, c[2] / a0, c[4] / a0, c[5] / a0];
}

function magnitudeDb([b0, b1, b2, a1, a2]: Coeffs, hz: number, rate: number) {
  const w = (2 * Math.PI * hz) / rate;
  const [c1, s1, c2, s2] = [Math.cos(w), -Math.sin(w), Math.cos(2 * w), -Math.sin(2 * w)];
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = b1 * s1 + b2 * s2;
  const dr = 1 + a1 * c1 + a2 * c2;
  const di = a1 * s1 + a2 * s2;
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Everything the engine will run, mirroring `EqSettings::plan` in dsp.rs. */
export function eqFilters(eq: EqSettings): { filters: EqFilter[]; preampDb: number } {
  const filters: EqFilter[] = [...(eq.profile?.filters ?? [])];
  EQ_FREQS.forEach((freq, i) => {
    const gain = eq.bands[i] ?? 0;
    if (Math.abs(gain) > 0.01) filters.push({ kind: "peak", freq, gain, q: GRAPHIC_Q });
  });
  const boost = Math.max(0, ...eq.bands);
  return { filters, preampDb: eq.preamp + (eq.profile?.preamp ?? 0) - boost };
}

/** Combined response in dB at log-spaced points from 20 Hz to 20 kHz. */
export function response(eq: EqSettings, points = 160, rate = 48_000): { hz: number; db: number }[] {
  const { filters, preampDb } = eqFilters(eq);
  const designed = filters.map((f) => design(f, rate)).filter((c): c is Coeffs => c != null);
  return Array.from({ length: points }, (_, i) => {
    const hz = 20 * 1000 ** (i / (points - 1));
    return { hz, db: preampDb + designed.reduce((s, c) => s + magnitudeDb(c, hz, rate), 0) };
  });
}
