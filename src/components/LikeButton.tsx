import { useState } from "react";
import { Heart } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { likeTracks } from "../lib/actions";
import { cn } from "../lib/cn";
import { useLibrary } from "../store/library";

const SPARKS = 6;

/** Heart toggle for one track. Liking pops the heart and throws a few sparks. */
export function LikeButton({ trackId, size = 18, className }: { trackId: number; size?: number; className?: string }) {
  const liked = useLibrary((s) => s.likedSet.has(trackId));
  const reduce = useReducedMotion();
  const [burst, setBurst] = useState(0);
  const label = liked ? "Remove from Liked songs" : "Save to Liked songs";

  return (
    <button
      type="button"
      aria-pressed={liked}
      aria-label={label}
      title={label}
      data-no-drag
      onClick={(e) => {
        e.stopPropagation();
        if (!liked) setBurst((b) => b + 1);
        likeTracks([trackId], !liked);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        "relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors",
        liked ? "text-accent" : "text-ink-muted hover:text-ink",
        className,
      )}
    >
      <motion.span
        key={liked ? "on" : "off"}
        initial={liked && !reduce && burst > 0 ? { scale: 0.4 } : false}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 700, damping: 14 }}
        className="grid place-items-center"
      >
        <Heart size={size} weight={liked ? "fill" : "regular"} />
      </motion.span>
      <AnimatePresence>
        {burst > 0 && liked && !reduce && (
          <span key={burst} aria-hidden className="pointer-events-none absolute inset-0">
            {Array.from({ length: SPARKS }, (_, i) => {
              const a = (i / SPARKS) * Math.PI * 2 - Math.PI / 2;
              return (
                <motion.span
                  key={i}
                  className="absolute left-1/2 top-1/2 h-1 w-1 rounded-full bg-accent"
                  initial={{ x: "-50%", y: "-50%", opacity: 1, scale: 1 }}
                  animate={{ x: `calc(-50% + ${Math.cos(a) * size * 0.95}px)`, y: `calc(-50% + ${Math.sin(a) * size * 0.95}px)`, opacity: 0, scale: 0.3 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                />
              );
            })}
          </span>
        )}
      </AnimatePresence>
    </button>
  );
}
