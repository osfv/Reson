export interface LyricWord {
  text: string;
  start: number;
  end: number;
}

export interface LyricLine {
  time: number;
  /** When the line is considered finished (next line, or the end of its last word). */
  end: number;
  text: string;
  words: LyricWord[];
  /** True when word timings came from the file; false when they're estimated. */
  wordTimed: boolean;
}

const STAMP = /\[(\d+):(\d{1,2}(?:[.:]\d+)?)\]/y;
const WORD = /<(\d+):(\d{1,2}(?:[.:]\d+)?)>/g;

const seconds = (m: string, s: string) => Number(m) * 60 + parseFloat(s.replace(":", "."));

/** Splits text into words, keeping trailing spaces with each word so wrapping stays natural. */
function splitWords(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/** Estimates word timings for a line from its length, for the karaoke sweep. */
function estimateWords(text: string, start: number, nextStart: number): LyricWord[] {
  const parts = splitWords(text);
  const chars = parts.reduce((n, p) => n + p.trim().length, 0) || 1;
  // People sing about 12-16 characters per second; don't stretch a short line across a long gap.
  const span = Math.max(0.6, Math.min(nextStart - start - 0.15, chars * 0.075 + 0.5));
  let t = start;
  return parts.map((p) => {
    const d = (span * Math.max(1, p.trim().length)) / chars;
    const w = { text: p, start: t, end: t + d };
    t += d;
    return w;
  });
}

/** Parses LRC text. Handles multiple timestamps per line, `[offset:]`, and enhanced `<mm:ss>` word stamps. */
export function parseLrc(src: string): LyricLine[] {
  let offset = 0;
  const raw: { time: number; body: string }[] = [];
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    const off = /^\[offset:\s*([+-]?\d+)\s*\]/i.exec(line);
    if (off) {
      offset = Number(off[1]) / 1000;
      continue;
    }
    const times: number[] = [];
    let end = 0;
    let m: RegExpExecArray | null;
    STAMP.lastIndex = 0;
    while ((m = STAMP.exec(line))) {
      times.push(seconds(m[1], m[2]));
      end = STAMP.lastIndex;
    }
    if (!times.length) continue;
    for (const t of times) raw.push({ time: Math.max(0, t - offset), body: line.slice(end) });
  }
  raw.sort((a, b) => a.time - b.time);

  const lines: LyricLine[] = raw.map(({ time, body }, i) => {
    const nextStart = raw[i + 1]?.time ?? time + 6;
    const marks = [...body.matchAll(WORD)];
    if (marks.length) {
      const words: LyricWord[] = [];
      let lastEnd: number | undefined;
      marks.forEach((mark, k) => {
        const start = seconds(mark[1], mark[2]) - offset;
        const from = mark.index! + mark[0].length;
        const to = marks[k + 1]?.index ?? body.length;
        const text = body.slice(from, to);
        if (text.length) words.push({ text, start, end: start });
        else lastEnd = start; // a trailing stamp marks when the last word ends
      });
      words.forEach((w, k) => (w.end = words[k + 1]?.start ?? lastEnd ?? Math.min(nextStart, w.start + 0.6)));
      const text = words.map((w) => w.text).join("").trim();
      return { time, end: lastEnd ?? nextStart, text, words, wordTimed: true };
    }
    const text = body.trim();
    return { time, end: nextStart, text, words: estimateWords(text, time, nextStart), wordTimed: false };
  });

  // Give long intros a placeholder so the view has something to sit on before the first line.
  if (lines.length && lines[0].time > 4) lines.unshift({ time: 0, end: lines[0].time, text: "", words: [], wordTimed: false });
  return lines;
}

/** Index of the line being sung at `t`, or -1 before the first line. */
export function activeLine(lines: LyricLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function stamp(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Builds LRC text from (time, text) pairs. */
export function toLrc(lines: { time: number; text: string }[]): string {
  return lines.map((l) => `[${stamp(l.time)}]${l.text}`).join("\n");
}
