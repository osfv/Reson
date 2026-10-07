import type { Track } from "./api";
import { isLossless } from "./format";

export interface Verdict {
  /** "likely" and "upsampled" are flagged on the format badge; "maybe" only in Song info. */
  level: "clean" | "maybe" | "likely" | "upsampled" | "pending" | "unknown";
  title: string;
  body: string;
}

const khz = (hz: number) => `${(hz / 1000).toFixed(1)} kHz`;

/** The usual lossy bitrate behind a given low-pass, from LAME and AAC encoder defaults. */
function bitrateFor(hz: number) {
  if (hz < 15_500) return "96 kbps or less";
  if (hz < 17_000) return "128 kbps";
  if (hz < 18_500) return "160 kbps";
  if (hz < 19_500) return "192 kbps";
  return "256 to 320 kbps";
}

/** What the spectral check says about a lossless file, or null for lossy formats. */
export function qualityVerdict(t: Pick<Track, "format" | "sampleRate" | "cutoffHz">): Verdict | null {
  if (!isLossless(t.format)) return null;
  const c = t.cutoffHz;
  if (c == null) return { level: "pending", title: "Checking the audio", body: "Reson checks lossless files for signs of a lossy source in the background." };
  if (c < 0) return { level: "unknown", title: "Couldn't check this file", body: "It's too short or too quiet to judge." };
  const hiRes = (t.sampleRate ?? 0) > 48_000;
  if (c > 0 && c < 19_500) {
    return {
      level: "likely",
      title: "Likely made from a lossy file",
      body: `The audio stops at ${khz(c)}, typical of a ${bitrateFor(c)} MP3 or AAC. Real lossless masters usually reach 20 kHz or more. Some recordings are naturally dull, so treat this as a strong hint, not proof.`,
    };
  }
  if (hiRes && c > 0 && c <= 24_500) {
    return {
      level: "upsampled",
      title: "Looks upsampled from CD quality",
      body: `This ${khz(t.sampleRate!)} file has no audio above ${khz(c)}, which is where a 44.1 or 48 kHz source ends. A true hi-res master usually goes higher.`,
    };
  }
  if (c > 0 && c < 20_600) {
    return {
      level: "maybe",
      title: "Possibly from a high-bitrate lossy file",
      body: `The audio stops at ${khz(c)}. That's where 256 to 320 kbps encoders cut off, but some masters are filtered there too.`,
    };
  }
  return { level: "clean", title: "Full frequency range", body: "No sign of lossy compression." };
}

export const flagged = (v: Verdict | null) => v?.level === "likely" || v?.level === "upsampled";
