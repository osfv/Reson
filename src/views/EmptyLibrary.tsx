import { FilePlus, FolderSimplePlus } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { PillButton } from "../components/Buttons";
import { importFiles, importFolders } from "../lib/actions";
import { useLibrary } from "../store/library";

export function EmptyLibrary() {
  const reduce = useReducedMotion();
  const scanning = useLibrary((s) => s.scan?.active);
  return (
    <div className="flex min-h-[calc(100%-4rem)] items-center px-8 pb-24 lg:px-16">
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="max-w-2xl"
      >
        <h1 className="text-5xl font-semibold leading-[1.05] tracking-tighter lg:text-6xl">
          {scanning ? "Reading your music…" : "Bring your music in."}
        </h1>
        <p className="mt-5 max-w-[52ch] text-base leading-relaxed text-ink-muted">
          Add a folder or drop audio files anywhere in this window. Reson reads tags and artwork, then colors itself to
          match what you play.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <PillButton primary onClick={importFolders} disabled={scanning}>
            <FolderSimplePlus size={18} />
            Add folder
          </PillButton>
          <PillButton onClick={importFiles} disabled={scanning}>
            <FilePlus size={18} />
            Add files
          </PillButton>
        </div>
        <p className="mt-10 font-mono text-xs text-ink-faint">MP3, FLAC, M4A/AAC, OGG Vorbis, WAV</p>
      </motion.div>
    </div>
  );
}
