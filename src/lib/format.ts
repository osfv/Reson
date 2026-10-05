export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function formatTotal(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

const LOSSLESS = new Set(["FLAC", "ALAC", "WAV", "AIFF", "APE", "WavPack"]);
const EXTENSIONS: Record<string, string[]> = {
  MP3: ["mp3"],
  FLAC: ["flac"],
  AAC: ["m4a", "mp4", "aac"],
  ALAC: ["m4a", "mp4"],
  OGG: ["ogg", "oga"],
  Opus: ["opus", "ogg"],
  WAV: ["wav"],
  APE: ["ape"],
  WavPack: ["wv"],
};

export const isLossless = (format: string | null | undefined) => !!format && LOSSLESS.has(format);

export const extensionOf = (path: string) => path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";

/** If the file's extension doesn't match what's actually inside, returns the extension. */
export function mislabeled(t: { path: string; format: string | null }): string | null {
  const ext = extensionOf(t.path);
  const expected = t.format ? EXTENSIONS[t.format] : undefined;
  return expected && !expected.includes(ext) ? ext : null;
}

/** "24-bit / 96 kHz" for lossless, "320 kbps" for lossy. */
export function qualityLabel(t: { format: string | null; sampleRate: number | null; bitDepth: number | null; bitrate: number | null }) {
  const khz = t.sampleRate ? `${+(t.sampleRate / 1000).toFixed(1)} kHz` : null;
  if (isLossless(t.format)) return [t.bitDepth ? `${t.bitDepth}-bit` : null, khz].filter(Boolean).join(" / ");
  return [t.bitrate ? `${t.bitrate} kbps` : null, khz].filter(Boolean).join(", ");
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}
