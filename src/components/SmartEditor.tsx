import { useEffect, useRef, useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { api, type SmartRules } from "../lib/api";
import { saveSmartPlaylist } from "../lib/actions";
import { cn } from "../lib/cn";
import { plural } from "../lib/format";
import { SORTS, emptyRules, newRule, problem, sortKey } from "../lib/smart";
import { useLibrary } from "../store/library";
import { useUi } from "../store/ui";
import { IconButton, PillButton } from "./Buttons";
import { Select, SmartRuleRow, fieldClass } from "./SmartRuleRow";

export function SmartEditor({ id }: { id: number | null }) {
  const existing = useLibrary((s) => (id == null ? undefined : s.smartPlaylists.find((p) => p.id === id)));
  const close = useUi((s) => s.closeSmartEditor);
  const [name, setName] = useState(existing?.name ?? "");
  const [rules, setRules] = useState<SmartRules>(() => (existing ? structuredClone(existing.rules) : emptyRules()));
  const [matches, setMatches] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const issue = problem(rules);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  // Live match count while editing.
  useEffect(() => {
    if (issue) {
      setMatches(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api
        .smartPreview(rules)
        .then((ids) => !stale && setMatches(ids.length))
        .catch(() => !stale && setMatches(null));
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [rules, issue]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const update = (patch: Partial<SmartRules>) => setRules((r) => ({ ...r, ...patch }));
  const save = async () => {
    if (issue || saving) return;
    setSaving(true);
    const ok = await saveSmartPlaylist(id, name, rules);
    setSaving(false);
    if (ok) close();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <motion.form
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-editor-title"
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex max-h-full w-full max-w-2xl flex-col rounded-2xl border border-white/10 bg-[color-mix(in_oklab,var(--bg)_70%,#2a2a2e)] shadow-[0_32px_80px_-20px_rgb(0_0_0/0.7)]"
      >
        <div className="flex items-start justify-between gap-4 p-6 pb-0">
          <div>
            <h2 id="smart-editor-title" className="text-lg font-semibold tracking-tight">
              {existing ? "Edit smart playlist" : "New smart playlist"}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">Songs that match the rules are added automatically as your library changes.</p>
          </div>
          <IconButton label="Close" onClick={close} className="-mr-2 -mt-1">
            <X size={18} />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <label className="block">
            <span className="text-xs text-ink-muted">Name</span>
            <input
              ref={nameRef}
              value={name}
              maxLength={100}
              placeholder="Smart playlist"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className={cn(fieldClass, "mt-1.5 w-full rounded-md placeholder:text-ink-faint")}
            />
          </label>

          <div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
            <span>Match</span>
            <Select
              label="Match"
              value={rules.match}
              onChange={(match) => update({ match })}
              options={[
                { value: "all", label: "all" },
                { value: "any", label: "any" },
              ]}
            />
            <span>of these rules</span>
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            {rules.rules.map((r, i) => (
              <SmartRuleRow
                key={i}
                rule={r}
                canRemove={rules.rules.length > 1}
                onChange={(next) => update({ rules: rules.rules.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => update({ rules: rules.rules.filter((_, j) => j !== i) })}
              />
            ))}
          </div>
          <PillButton className="mt-3 h-9 px-4" onClick={() => update({ rules: [...rules.rules, newRule()] })}>
            <Plus size={16} />
            Add rule
          </PillButton>

          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-5 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={rules.limit != null}
                onChange={(e) => update({ limit: e.target.checked ? 25 : null })}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Limit to
            </label>
            <span className={cn("-ml-4 flex items-center gap-2", rules.limit == null && "opacity-40")}>
              <input
                type="number"
                aria-label="Song limit"
                min={1}
                max={10000}
                disabled={rules.limit == null}
                value={rules.limit ?? 25}
                onChange={(e) => update({ limit: e.target.value === "" ? NaN : Math.round(Number(e.target.value)) })}
                className={cn(fieldClass, "w-20 font-mono tabular-nums")}
              />
              songs
            </span>
            <span className="flex items-center gap-2">
              Sorted by
              <Select
                label="Sort by"
                value={sortKey(rules.sort)}
                onChange={(v) => {
                  const s = SORTS.find((x) => x.value === v)!;
                  update({
                    sort: v === "default" ? null : { field: s.field, desc: s.desc, seed: s.field === "random" ? Math.floor(Math.random() * 1e9) : 0 },
                  });
                }}
                options={SORTS.map((s) => ({ value: s.value, label: s.label }))}
              />
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-line px-6 py-4">
          <p className="text-sm text-ink-muted" role="status" aria-live="polite">
            {issue ?? (matches == null ? "Counting songs…" : matches ? `${plural(matches, "song")} match right now` : "No songs match right now")}
          </p>
          <div className="flex gap-2">
            <PillButton onClick={close}>Cancel</PillButton>
            <PillButton primary type="submit" disabled={!!issue || saving} className="disabled:opacity-40">
              {existing ? "Save" : "Create"}
            </PillButton>
          </div>
        </div>
      </motion.form>
    </motion.div>
  );
}
