import { DownloadSimple } from "@phosphor-icons/react";
import { motion } from "motion/react";

export function DropOverlay() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-[color-mix(in_oklab,var(--bg)_80%,transparent)] p-3 backdrop-blur-md"
    >
      <motion.div
        initial={{ scale: 0.97 }}
        animate={{ scale: 1 }}
        className="grid h-full w-full place-items-center rounded-2xl border-2 border-dashed border-[color-mix(in_oklab,var(--accent)_70%,transparent)]"
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-accent text-on-accent">
            <DownloadSimple size={28} weight="bold" />
          </span>
          <p className="text-2xl font-semibold tracking-tight">Drop to add to your library</p>
          <p className="text-sm text-ink-muted">Folders are scanned for MP3, FLAC, M4A, OGG and WAV files.</p>
        </div>
      </motion.div>
    </motion.div>
  );
}
