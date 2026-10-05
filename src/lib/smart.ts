import type { SmartField, SmartOp, SmartRule, SmartRules } from "./api";

export type FieldKind = "text" | "number" | "date";

interface FieldInfo {
  label: string;
  kind: FieldKind;
  /** Shown after number inputs. */
  unit?: string;
  /** Stored value = shown value × scale (e.g. minutes to seconds). */
  scale?: number;
}

export const FIELDS: Record<SmartField, FieldInfo> = {
  title: { label: "Title", kind: "text" },
  artist: { label: "Artist", kind: "text" },
  album: { label: "Album", kind: "text" },
  albumArtist: { label: "Album artist", kind: "text" },
  genre: { label: "Genre", kind: "text" },
  year: { label: "Year", kind: "number" },
  plays: { label: "Play count", kind: "number", unit: "plays" },
  lastPlayed: { label: "Last played", kind: "date" },
  addedAt: { label: "Date added", kind: "date" },
  duration: { label: "Duration", kind: "number", unit: "min", scale: 60 },
  format: { label: "Format", kind: "text" },
  bitDepth: { label: "Bit depth", kind: "number", unit: "bit" },
  sampleRate: { label: "Sample rate", kind: "number", unit: "kHz", scale: 1000 },
  bitrate: { label: "Bitrate", kind: "number", unit: "kbps" },
};

export const FIELD_ORDER = Object.keys(FIELDS) as SmartField[];

export const OPS: Record<FieldKind, { op: SmartOp; label: string }[]> = {
  text: [
    { op: "contains", label: "contains" },
    { op: "notContains", label: "does not contain" },
    { op: "is", label: "is" },
    { op: "isNot", label: "is not" },
    { op: "startsWith", label: "starts with" },
    { op: "endsWith", label: "ends with" },
  ],
  number: [
    { op: "is", label: "is" },
    { op: "isNot", label: "is not" },
    { op: "gt", label: "is more than" },
    { op: "lt", label: "is less than" },
    { op: "between", label: "is between" },
  ],
  date: [
    { op: "inLast", label: "in the last" },
    { op: "notInLast", label: "not in the last" },
    { op: "before", label: "is before" },
    { op: "after", label: "is after" },
  ],
};

export const SORTS: { value: string; label: string; field: SmartField | "random"; desc: boolean }[] = [
  { value: "default", label: "Artist and album", field: "artist", desc: false },
  { value: "plays", label: "Most played", field: "plays", desc: true },
  { value: "playsAsc", label: "Least played", field: "plays", desc: false },
  { value: "lastPlayed", label: "Recently played", field: "lastPlayed", desc: true },
  { value: "addedAt", label: "Recently added", field: "addedAt", desc: true },
  { value: "title", label: "Title", field: "title", desc: false },
  { value: "year", label: "Newest first", field: "year", desc: true },
  { value: "yearAsc", label: "Oldest first", field: "year", desc: false },
  { value: "duration", label: "Longest first", field: "duration", desc: true },
  { value: "random", label: "Random", field: "random", desc: false },
];

export const sortKey = (sort: SmartRules["sort"]) =>
  sort ? (SORTS.find((s) => s.field === sort.field && s.desc === sort.desc)?.value ?? "default") : "default";

/** Unix seconds to a yyyy-mm-dd string for date inputs (local time). */
export function toDateInput(secs: number) {
  const d = new Date(secs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const fromDateInput = (s: string) => Math.floor(new Date(`${s}T00:00:00`).getTime() / 1000);

/** A sensible starting value when the field or operator changes. */
export function defaultValue(field: SmartField, op: SmartOp): SmartRule["value"] {
  const info = FIELDS[field];
  if (info.kind === "text") return "";
  if (op === "inLast" || op === "notInLast") return 30;
  // Start of today in local time, like a date the user picks.
  if (op === "before" || op === "after") return fromDateInput(toDateInput(Date.now() / 1000));
  const base = field === "year" ? 2000 : field === "bitDepth" ? 16 : field === "sampleRate" ? 44100 : field === "duration" ? 300 : 0;
  return op === "between" ? [base, base + (info.scale ?? 1) * (field === "year" ? 9 : 10)] : base;
}

export function newRule(field: SmartField = "artist"): SmartRule {
  const op = OPS[FIELDS[field].kind][0].op;
  return { field, op, value: defaultValue(field, op) };
}

export const emptyRules = (): SmartRules => ({ match: "all", rules: [newRule()], limit: null, sort: null });

/** First problem with the rules, in plain words, or null when they can be saved. */
export function problem(rules: SmartRules): string | null {
  for (const r of rules.rules) {
    if (FIELDS[r.field].kind === "text" && typeof r.value === "string" && !r.value.trim())
      return `Type something for ${FIELDS[r.field].label.toLowerCase()}.`;
    const nums = Array.isArray(r.value) ? r.value : typeof r.value === "number" ? [r.value] : [];
    if (nums.some((n) => !Number.isFinite(n))) return `Enter a number for ${FIELDS[r.field].label.toLowerCase()}.`;
  }
  if (rules.limit != null && (!Number.isFinite(rules.limit) || rules.limit < 1)) return "The limit must be at least 1.";
  return null;
}

function describeRule(r: SmartRule): string {
  const info = FIELDS[r.field];
  const op = OPS[info.kind].find((o) => o.op === r.op)?.label ?? r.op;
  const num = (v: number) => {
    const n = +(v / (info.kind === "date" ? 1 : (info.scale ?? 1))).toFixed(2);
    return n.toLocaleString();
  };
  let value: string;
  if (info.kind === "text") value = `"${String(r.value)}"`;
  else if (r.op === "before" || r.op === "after") value = new Date(Number(r.value) * 1000).toLocaleDateString();
  else if (Array.isArray(r.value)) value = `${num(r.value[0])} and ${num(r.value[1])}`;
  else value = num(Number(r.value));
  const unit = info.kind === "date" && !(r.op === "before" || r.op === "after") ? " days" : info.unit && info.kind === "number" ? ` ${info.unit}` : "";
  return `${info.label.toLowerCase()} ${op} ${value}${unit}`;
}

/** One-line plain summary, e.g. "25 songs where play count is more than 0, most played first". */
export function describeRules(rules: SmartRules): string {
  const parts = rules.rules.map(describeRule);
  const where = parts.length ? ` where ${parts.join(rules.match === "all" ? " and " : " or ")}` : "";
  const head = rules.limit != null ? `Up to ${rules.limit.toLocaleString()} songs` : "Songs";
  const sort = SORTS.find((s) => s.value === sortKey(rules.sort));
  return `${head}${where}${sort && sort.value !== "default" ? `, sorted by ${sort.label.toLowerCase()}` : ""}`;
}
