import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowSquareOut, Check, ClipboardText, Copy, Eye, EyeSlash, WarningCircle, X } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useUi } from "../../store/ui";

const ease = [0.16, 1, 0.3, 1] as const;

export interface Brand {
  name: string;
  /** Brand color; used for the icon tile, progress and primary button (white text on it). */
  color: string;
  icon: ReactNode;
}

/**
 * A guided, multi-step setup window for connecting an outside service. The brand color is scoped
 * to the dialog as `--brand`, so every step picks it up.
 */
export function SetupDialog({
  brand,
  steps,
  step,
  direction,
  onClose,
  children,
  footer,
}: {
  brand: Brand;
  steps: string[];
  step: number;
  /** 1 when moving forward, -1 when going back; picks the slide direction. */
  direction: number;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const reduce = useReducedMotion();
  const setCaptureKeys = useUi((s) => s.setCaptureKeys);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setCaptureKeys(true);
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      setCaptureKeys(false);
    };
  }, [onClose, setCaptureKeys]);

  // Portaled to <body>: animated (transformed) ancestors would otherwise trap the fixed overlay.
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6 backdrop-blur-md"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{ "--brand": brand.color } as CSSProperties}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={`Set up ${brand.name}`}
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 340, damping: 30 }}
        className="relative w-full max-w-[560px] overflow-hidden rounded-3xl bg-[#18181b] shadow-[0_40px_120px_-30px_rgb(0_0_0/0.9)] ring-1 ring-white/10"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -left-24 -top-32 h-72 w-96 rounded-full opacity-30 blur-3xl"
          style={{ background: "var(--brand)" }}
        />
        <div className="relative px-8 pb-6 pt-7">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3.5">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--brand)] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]">
                {brand.icon}
              </span>
              <div>
                <p className="text-sm font-semibold">{brand.name}</p>
                <p className="text-xs text-ink-muted">Connect to Reson</p>
              </div>
            </div>
            <button
              ref={closeRef}
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="-mr-2 -mt-1 grid h-9 w-9 place-items-center rounded-full text-ink-muted transition-colors hover:bg-white/[0.08] hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <ol className="mt-7 grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
            {steps.map((label, i) => (
              <li key={label} className="min-w-0">
                <div className="h-1 overflow-hidden rounded-full bg-white/10">
                  <motion.div
                    className="h-full origin-left rounded-full bg-[var(--brand)]"
                    initial={false}
                    animate={{ scaleX: i <= step ? 1 : 0, opacity: i < step ? 0.55 : 1 }}
                    transition={{ duration: reduce ? 0 : 0.5, ease }}
                  />
                </div>
                <p className={cn("mt-2 truncate text-xs transition-colors", i === step ? "text-ink" : "text-ink-faint")}>
                  {i < step && <Check size={11} weight="bold" className="mr-1 inline -translate-y-px text-[var(--brand)]" />}
                  {label}
                </p>
              </li>
            ))}
          </ol>

          <div className="relative mt-6 min-h-[248px]">
            <AnimatePresence mode="wait" initial={false} custom={direction}>
              <motion.div
                key={step}
                custom={direction}
                initial={reduce ? { opacity: 0 } : { opacity: 0, x: 28 * direction, filter: "blur(6px)" }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, x: -20 * direction, filter: "blur(6px)" }}
                transition={{ duration: 0.32, ease }}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <div className="relative flex items-center justify-between gap-3 border-t border-white/[0.06] bg-black/20 px-8 py-4">{footer}</div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

export function StepTitle({ title, body }: { title: string; body: ReactNode }) {
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 max-w-[48ch] text-sm leading-relaxed text-ink-muted">{body}</p>
    </>
  );
}

/** A numbered instruction. */
export function Instruction({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3.5">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_22%,transparent)] font-mono text-xs font-medium text-ink">
        {n}
      </span>
      <div className="min-w-0 pt-0.5 text-sm leading-relaxed text-ink">{children}</div>
    </li>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => api.openLink(href)}
      className="mt-2 inline-flex h-9 items-center gap-2 rounded-full bg-white/[0.08] px-4 text-sm font-medium text-ink transition-[background-color,scale] hover:bg-white/[0.13] active:scale-[0.97]"
    >
      {children}
      <ArrowSquareOut size={15} />
    </button>
  );
}

/** A value to type into the other site's form, with a one-click copy. */
export function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.05] py-2 pl-3.5 pr-2">
      <div className="min-w-0">
        <p className="text-[11px] text-ink-muted">{label}</p>
        <p className="truncate text-sm">{value}</p>
      </div>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-ink-muted transition-colors hover:bg-white/[0.08] hover:text-ink"
      >
        {copied ? <Check size={14} weight="bold" className="text-[var(--brand)]" /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Labeled text field with an optional paste button and a reveal toggle for secrets. */
export function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  helper,
  error,
  secret,
  autoFocus,
  onEnter,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  helper?: string;
  error?: string | null;
  secret?: boolean;
  autoFocus?: boolean;
  onEnter?: () => void;
}) {
  const [shown, setShown] = useState(!secret);
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onChange(text.trim());
    } catch {
      document.getElementById(id)?.focus();
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div
        className={cn(
          "flex h-12 items-center gap-1 rounded-xl bg-white/[0.06] pl-4 pr-1.5 ring-1 transition-shadow focus-within:ring-2",
          error ? "ring-[#f87171] focus-within:ring-[#f87171]" : "ring-white/10 focus-within:ring-[var(--brand)]",
        )}
      >
        <input
          id={id}
          value={value}
          type={shown ? "text" : "password"}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={`${id}-help`}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        {secret && (
          <button
            type="button"
            aria-label={shown ? "Hide" : "Show"}
            onClick={() => setShown((s) => !s)}
            className="grid h-9 w-9 place-items-center rounded-lg text-ink-muted hover:bg-white/[0.08] hover:text-ink"
          >
            {shown ? <EyeSlash size={17} /> : <Eye size={17} />}
          </button>
        )}
        <button
          type="button"
          onClick={paste}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-ink-muted hover:bg-white/[0.08] hover:text-ink"
        >
          <ClipboardText size={15} />
          Paste
        </button>
      </div>
      <AnimatePresence initial={false} mode="wait">
        {error ? (
          <motion.p
            key="error"
            id={`${id}-help`}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: [0, -4, 4, -2, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="flex gap-1.5 text-[13px] leading-snug text-[#fca5a5]"
          >
            <WarningCircle size={16} className="mt-px shrink-0" />
            {error}
          </motion.p>
        ) : helper ? (
          <motion.p key="help" id={`${id}-help`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[13px] text-ink-muted">
            {helper}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function PrimaryButton({ children, onClick, busy, disabled }: { children: ReactNode; onClick: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      whileTap={{ scale: 0.97 }}
      className="relative inline-flex h-11 min-w-32 items-center justify-center gap-2 overflow-hidden rounded-full bg-[var(--brand)] px-6 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.22)] transition-[filter,opacity] hover:brightness-110 disabled:opacity-60"
    >
      {busy && (
        <motion.span
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.22),transparent)]"
          initial={{ x: "-100%" }}
          animate={{ x: "100%" }}
          transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <span className="relative">{children}</span>
    </motion.button>
  );
}

export function BackButton({ onClick, label = "Back" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 items-center rounded-full px-5 text-sm font-medium text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
    >
      {label}
    </button>
  );
}
