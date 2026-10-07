import { useMemo, useRef } from "react";
import { ArrowCounterClockwise, FileArrowUp, Headphones, X } from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { EqSettings } from "../../lib/api";
import { cn } from "../../lib/cn";
import { bandLabel, EQ_FREQS, MAX_GAIN, parseAutoEq, PRESETS, presetOf, response } from "../../lib/eq";
import { usePrefs } from "../../store/prefs";
import { useUi } from "../../store/ui";
import { PillButton } from "../Buttons";
import { Group, Select, Toggle } from "./parts";

const W = 600;
const H = 140;
const RANGE = 15;
const xOf = (hz: number) => (Math.log10(hz / 20) / 3) * W;
const yOf = (db: number) => H / 2 - (Math.max(-RANGE, Math.min(RANGE, db)) / RANGE) * (H / 2 - 8);

/** The combined frequency response of everything the EQ will do. */
function Curve({ eq }: { eq: EqSettings }) {
  const pts = useMemo(() => response(eq), [eq]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${xOf(p.hz).toFixed(1)},${yOf(p.db).toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H / 2} L0,${H / 2} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-36 w-full" aria-hidden>
      <defs>
        <linearGradient id="eq-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.32" />
          <stop offset="0.5" stopColor="var(--accent)" stopOpacity="0.04" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0.32" />
        </linearGradient>
      </defs>
      {EQ_FREQS.map((f) => (
        <line key={f} x1={xOf(f)} x2={xOf(f)} y1={0} y2={H} stroke="rgb(255 255 255 / 0.05)" />
      ))}
      {[-12, -6, 6, 12].map((db) => (
        <line key={db} x1={0} x2={W} y1={yOf(db)} y2={yOf(db)} stroke="rgb(255 255 255 / 0.04)" strokeDasharray="3 5" />
      ))}
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="rgb(255 255 255 / 0.14)" />
      <path d={area} fill="url(#eq-fill)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function EqualizerSettings() {
  const eq = usePrefs((s) => s.prefs?.eq);
  const set = usePrefs((s) => s.set);
  const toast = useUi((s) => s.toast);
  const file = useRef<HTMLInputElement>(null);
  if (!eq) return null;

  const update = (patch: Partial<EqSettings>) => set({ eq: { ...eq, enabled: true, ...patch } });
  const setBand = (i: number, gain: number) => update({ bands: eq.bands.map((g, j) => (j === i ? gain : g)) });
  const preset = presetOf(eq.bands);

  const importProfile = async (f: File | undefined) => {
    if (!f) return;
    const profile = parseAutoEq(await f.text(), f.name);
    if (!profile) {
      toast("That file isn't an AutoEQ ParametricEQ.txt profile");
      return;
    }
    update({ profile });
    toast(`Using ${profile.name}`);
  };

  return (
    <Group
      title="Equalizer"
      aside={<Toggle label="Equalizer" checked={eq.enabled} onChange={(v) => set({ eq: { ...eq, enabled: v } })} />}
    >
      <div className={cn("py-4 transition-opacity duration-300", !eq.enabled && "opacity-50")}>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            label="Preset"
            value={preset}
            onChange={(name) => {
              const p = PRESETS.find((x) => x.name === name);
              if (p) update({ bands: [...p.bands] });
            }}
            options={[...PRESETS.map((p) => ({ value: p.name, label: p.name })), ...(preset === "Custom" ? [{ value: "Custom", label: "Custom" }] : [])]}
          />
          <PillButton onClick={() => update({ bands: Array(10).fill(0), preamp: 0 })}>
            <ArrowCounterClockwise size={16} />
            Reset
          </PillButton>
          <PillButton onClick={() => file.current?.click()} title="Headphone corrections from autoeq.app">
            <FileArrowUp size={16} />
            Import AutoEQ profile
          </PillButton>
          <input
            ref={file}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            onChange={(e) => {
              importProfile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>

        {eq.profile && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 flex items-center gap-3 rounded-md bg-white/[0.05] py-2 pl-3 pr-2 text-sm"
          >
            <Headphones size={18} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate">
              {eq.profile.name}
              <span className="text-ink-muted">, {eq.profile.filters.length} filters, applied before the bands below</span>
            </span>
            <button
              type="button"
              aria-label="Remove headphone profile"
              onClick={() => set({ eq: { ...eq, profile: null } })}
              className="grid h-7 w-7 place-items-center rounded-full text-ink-muted hover:bg-white/10 hover:text-ink"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}

        <div className="mt-4 rounded-xl bg-black/20 px-2 pt-2">
          <Curve eq={eq} />
        </div>

        <div className="mt-4 grid grid-cols-10 gap-1">
          {EQ_FREQS.map((f, i) => {
            const g = eq.bands[i] ?? 0;
            return (
              <div key={f} className="flex flex-col items-center gap-2">
                <span className={cn("font-mono text-[11px] tabular-nums", g ? "text-ink" : "text-ink-faint")}>
                  {g > 0 ? "+" : ""}
                  {g.toFixed(g % 1 ? 1 : 0)}
                </span>
                <input
                  type="range"
                  min={-MAX_GAIN}
                  max={MAX_GAIN}
                  step={0.5}
                  value={g}
                  aria-label={`${bandLabel(f)} Hz`}
                  onChange={(e) => setBand(i, Number(e.target.value))}
                  onDoubleClick={() => setBand(i, 0)}
                  className="h-32 w-6 cursor-pointer accent-[var(--accent)] [direction:rtl] [writing-mode:vertical-lr]"
                />
                <span className="font-mono text-[11px] text-ink-muted">{bandLabel(f)}</span>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex items-center gap-4">
          <span className="w-16 text-sm text-ink-muted">Preamp</span>
          <input
            type="range"
            min={-12}
            max={6}
            step={0.5}
            value={eq.preamp}
            aria-label="Preamp"
            onChange={(e) => update({ preamp: Number(e.target.value) })}
            className="h-1 flex-1 cursor-pointer accent-[var(--accent)]"
          />
          <span className="w-14 text-right font-mono text-xs tabular-nums text-ink-muted">
            {eq.preamp > 0 ? "+" : ""}
            {eq.preamp.toFixed(1)} dB
          </span>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-faint">
          Boosted bands lower the volume by the same amount, so the EQ never clips. Double-click a slider to reset it.
        </p>
      </div>
    </Group>
  );
}
