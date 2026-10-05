import { X } from "@phosphor-icons/react";
import type { SmartField, SmartOp, SmartRule } from "../lib/api";
import { cn } from "../lib/cn";
import { FIELD_ORDER, FIELDS, OPS, defaultValue, fromDateInput, toDateInput } from "../lib/smart";
import { IconButton } from "./Buttons";

export const fieldClass =
  "h-9 rounded-full bg-white/[0.07] px-3.5 text-sm text-ink outline-none ring-1 ring-transparent transition-colors hover:bg-white/[0.1] focus-visible:ring-accent";

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(fieldClass, "cursor-pointer appearance-none pr-8", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none' stroke='%23f2f1ee' stroke-opacity='.6' stroke-width='1.5'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 0.85rem center",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-[#2a2a2e]">
          {o.label}
        </option>
      ))}
    </select>
  );
}

function NumberInput({ value, onChange, label, scale = 1 }: { value: number; onChange: (v: number) => void; label: string; scale?: number }) {
  return (
    <input
      type="number"
      aria-label={label}
      value={Number.isFinite(value) ? +(value / scale).toFixed(2) : ""}
      step="any"
      min={0}
      onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value) * scale)}
      className={cn(fieldClass, "w-24 font-mono tabular-nums")}
    />
  );
}

function ValueInput({ rule, onChange }: { rule: SmartRule; onChange: (v: SmartRule["value"]) => void }) {
  const info = FIELDS[rule.field];
  const name = info.label.toLowerCase();
  if (info.kind === "text") {
    return (
      <input
        type="text"
        aria-label={`${info.label} value`}
        placeholder={rule.field === "format" ? "FLAC" : rule.field === "genre" ? "Jazz" : "Type to match"}
        value={String(rule.value)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(fieldClass, "min-w-0 flex-1 placeholder:text-ink-faint")}
      />
    );
  }
  if (rule.op === "before" || rule.op === "after") {
    return (
      <input
        type="date"
        aria-label={`${info.label} date`}
        value={toDateInput(Number(rule.value))}
        onChange={(e) => e.target.value && onChange(fromDateInput(e.target.value))}
        className={cn(fieldClass, "font-mono [color-scheme:dark]")}
      />
    );
  }
  const unit = info.kind === "date" ? "days" : info.unit;
  if (rule.op === "between") {
    const [lo, hi] = Array.isArray(rule.value) ? rule.value : [Number(rule.value), Number(rule.value)];
    return (
      <span className="flex items-center gap-2 text-sm text-ink-muted">
        <NumberInput label={`Lowest ${name}`} value={lo} scale={info.scale} onChange={(v) => onChange([v, hi])} />
        and
        <NumberInput label={`Highest ${name}`} value={hi} scale={info.scale} onChange={(v) => onChange([lo, v])} />
        {unit && <span>{unit}</span>}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-sm text-ink-muted">
      <NumberInput label={`${info.label} value`} value={Number(rule.value)} scale={info.kind === "date" ? 1 : info.scale} onChange={onChange} />
      {unit && <span>{unit}</span>}
    </span>
  );
}

const valueShape = (op: SmartOp) => (op === "between" ? "pair" : op === "before" || op === "after" ? "date" : "single");

export function SmartRuleRow({
  rule,
  onChange,
  onRemove,
  canRemove,
}: {
  rule: SmartRule;
  onChange: (r: SmartRule) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const setField = (field: SmartField) => {
    const sameKind = FIELDS[field].kind === FIELDS[rule.field].kind;
    const op = sameKind ? rule.op : OPS[FIELDS[field].kind][0].op;
    onChange({ field, op, value: sameKind && FIELDS[field].kind === "text" ? rule.value : defaultValue(field, op) });
  };
  const setOp = (op: SmartOp) => {
    const keep = FIELDS[rule.field].kind === "text" || valueShape(op) === valueShape(rule.op);
    onChange({ ...rule, op, value: keep ? rule.value : defaultValue(rule.field, op) });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-white/[0.03] p-2">
      <Select
        label="Field"
        value={rule.field}
        onChange={setField}
        options={FIELD_ORDER.map((f) => ({ value: f, label: FIELDS[f].label }))}
      />
      <Select label="Condition" value={rule.op} onChange={setOp} options={OPS[FIELDS[rule.field].kind].map((o) => ({ value: o.op, label: o.label }))} />
      <ValueInput rule={rule} onChange={(value) => onChange({ ...rule, value })} />
      <IconButton label="Remove rule" onClick={onRemove} disabled={!canRemove} className="ml-auto">
        <X size={16} />
      </IconButton>
    </div>
  );
}
