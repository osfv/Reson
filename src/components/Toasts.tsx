import { AnimatePresence, motion } from "motion/react";
import { useUi } from "../store/ui";

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[104px] z-50 flex flex-col items-center gap-2" aria-live="polite">
      <AnimatePresence>
        {toasts.slice(-3).map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className="line-clamp-2 max-w-[min(560px,90vw)] rounded-2xl bg-ink px-4 py-2 text-center text-sm font-medium text-[#141416] shadow-[0_12px_32px_-8px_rgb(0_0_0/0.6)]"
          >
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
