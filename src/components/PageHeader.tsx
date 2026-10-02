import type { ReactNode } from "react";

/** Simple header for collection pages (Albums, Songs, Artists). */
export function PageHeader({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6 px-8 pb-6 pt-4">
      <div>
        <h1 className="text-4xl font-semibold tracking-tight">{title}</h1>
        {meta && <p className="mt-2 text-sm text-ink-muted">{meta}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

export function SortPills<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Sort by" className="flex gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={
            value === o.value
              ? "h-8 rounded-full bg-ink px-3.5 text-[13px] font-medium text-bg"
              : "h-8 rounded-full bg-white/[0.07] px-3.5 text-[13px] text-ink transition-colors hover:bg-white/[0.12]"
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
