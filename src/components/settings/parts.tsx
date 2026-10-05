import type { ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "../../lib/cn";

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40",
        checked ? "bg-accent" : "bg-white/15",
      )}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 700, damping: 35 }}
        className={cn("absolute top-0.5 h-5 w-5 rounded-full shadow", checked ? "right-0.5 bg-on-accent" : "left-0.5 bg-ink")}
      />
    </button>
  );
}

export function Row({ title, body, children }: { title: ReactNode; body?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-8 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {body && <p className="mt-1 max-w-[60ch] text-[13px] leading-relaxed text-ink-muted">{body}</p>}
      </div>
      {children}
    </div>
  );
}

export function Group({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mt-10 first:mt-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {aside}
      </div>
      <div className="mt-2 divide-y divide-line">{children}</div>
    </section>
  );
}

/** A native select styled like the rest of the app. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        "h-10 max-w-72 cursor-pointer truncate rounded-full bg-white/[0.07] px-4 pr-8 text-sm text-ink outline-none transition-colors hover:bg-white/[0.12] focus-visible:ring-2 focus-visible:ring-accent",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-[#1d1d20] text-ink">
          {o.label}
        </option>
      ))}
    </select>
  );
}
