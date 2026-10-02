import { motionValue } from "motion/react";

/**
 * Playback position in seconds, updated every animation frame.
 *
 * The audio engine reports its position ~5 times a second. Between reports we extrapolate from
 * the last one; when a report arrives we fold small drift in gradually (so lyrics and the seek
 * bar never jitter) and only snap on real jumps (seek, track change). This is a motion value, not
 * React state, so consumers update without re-rendering.
 */
export const clock = motionValue(0);

let base = 0;
let baseAt = performance.now();
let playing = false;
let duration = 0;
let started = false;

function now() {
  return performance.now();
}

function predicted(at = now()) {
  const t = playing ? base + (at - baseAt) / 1000 : base;
  return duration > 0 ? Math.min(t, duration) : t;
}

/** Hard reset: track change, seek, play/pause. */
export function setClock(position: number, dur: number, isPlaying: boolean) {
  base = position;
  baseAt = now();
  duration = dur;
  playing = isPlaying;
  clock.set(predicted());
}

/** Gentle correction from a periodic progress report. */
export function nudgeClock(position: number, dur: number) {
  const at = now();
  const guess = predicted(at);
  const drift = position - guess;
  duration = dur;
  base = Math.abs(drift) > 0.35 ? position : guess + drift * 0.25;
  baseAt = at;
}

export function clockPlaying() {
  return playing;
}

export function startClock() {
  if (started) return;
  started = true;
  const frame = () => {
    const t = predicted();
    if (t !== clock.get()) clock.set(t);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
