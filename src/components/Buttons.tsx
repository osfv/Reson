import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Pause, Play } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "../lib/cn";

type Btn = ButtonHTMLAttributes<HTMLButtonElement>;

export const IconButton = forwardRef<HTMLButtonElement, Btn & { label: string; active?: boolean }>(
  function IconButton({ label, active, className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={active}
        title={label}
        className={cn(
          "relative grid h-9 w-9 shrink-0 place-items-center rounded-full transition-[color,background-color,scale] duration-150 active:scale-[0.92] disabled:pointer-events-none disabled:opacity-35",
          active ? "text-accent" : "text-ink-muted hover:text-ink",
          "hover:bg-white/[0.06]",
          className,
        )}
        {...rest}
      >
        {children}
        {/* Toggle state shouldn't rely on color alone: muted covers make accent and gray look alike. */}
        <AnimatePresence>
          {active && (
            <motion.span
              aria-hidden
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 600, damping: 30 }}
              className="absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent"
            />
          )}
        </AnimatePresence>
      </button>
    );
  },
);

/** Round play/pause button. The icon morphs between states; the play triangle is nudged right
 * because a geometrically centered triangle looks off-center. */
export function PlayButton({
  playing,
  onClick,
  size = 48,
  className,
  label,
}: {
  playing: boolean;
  onClick: () => void;
  size?: number;
  className?: string;
  label?: string;
}) {
  const Icon = playing ? Pause : Play;
  const text = label ?? (playing ? "Pause" : "Play");
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={text}
      title={text}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.9 }}
      transition={{ type: "spring", stiffness: 500, damping: 26 }}
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-accent text-on-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_6px_18px_-8px_rgb(0_0_0/0.65)]",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={playing ? "pause" : "play"}
          initial={{ scale: 0.3, opacity: 0, rotate: playing ? -90 : 90 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          exit={{ scale: 0.3, opacity: 0, rotate: playing ? 90 : -90 }}
          transition={{ type: "spring", stiffness: 520, damping: 28 }}
          className="grid place-items-center"
        >
          <Icon size={Math.round(size * (playing ? 0.36 : 0.4))} weight="fill" />
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

export function PillButton({ children, className, primary, ...rest }: Btn & { primary?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full px-5 text-sm font-medium transition-[background-color,scale,color] duration-150 active:scale-[0.97]",
        primary
          ? "bg-accent text-on-accent hover:brightness-110"
          : "bg-white/[0.07] text-ink hover:bg-white/[0.12]",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
