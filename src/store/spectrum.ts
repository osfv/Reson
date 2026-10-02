import { animate, motionValue } from "motion/react";
import type { Spectrum } from "../lib/api";

/** Latest band levels (0..1) from the engine, ~40 per second. Canvas readers interpolate. */
export const bands = new Float32Array(48);
/** Smoothed bass energy, 0..1. */
export const bass = motionValue(0);
/** Spikes to 1 on each detected beat and decays; drives the "pulse" effects. */
export const kick = motionValue(0);

let lastEvent = 0;

export function onSpectrum(s: Spectrum) {
  lastEvent = performance.now();
  for (let i = 0; i < bands.length && i < s.bands.length; i++) bands[i] = s.bands[i] / 255;
  bass.set(s.bass);
  if (s.beat) {
    kick.set(1);
    animate(kick, 0, { duration: 0.4, ease: [0.2, 0.7, 0.3, 1] });
  }
}

/** Fades everything to rest when events stop (paused, or analysis turned off). */
export function spectrumStale() {
  return performance.now() - lastEvent > 300;
}

export function resetSpectrum() {
  bands.fill(0);
  bass.set(0);
  kick.set(0);
}
