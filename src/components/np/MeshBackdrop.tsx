import { motion, useReducedMotion, useTransform } from "motion/react";
import type { Palette } from "../../lib/api";
import { cn } from "../../lib/cn";
import { bass, kick } from "../../store/spectrum";

/**
 * Now Playing background: large soft blobs in the cover's own colors drifting slowly, like a
 * lava lamp. Colors cross-fade when the track changes; the whole field breathes with the bass
 * when beat-reactive visuals are on.
 */
export function MeshBackdrop({ palette, playing, reactive }: { palette: Palette; playing: boolean; reactive: boolean }) {
  const reduce = useReducedMotion();
  const sw = palette.swatches?.length ? palette.swatches : [palette.surface, palette.bg, palette.surface];
  const colors = [sw[0], sw[1] ?? sw[0], sw[2] ?? sw[0], palette.accent];
  const breathe = useTransform(() => (reactive && !reduce ? 1 + bass.get() * 0.07 + kick.get() * 0.035 : 1));

  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", !playing && "np-paused")}>
      <motion.div className="absolute inset-0" style={{ scale: breathe }}>
        {colors.map((c, i) => (
          <div key={i} className={`np-blob np-blob-${i + 1}`} style={{ backgroundColor: c }} />
        ))}
      </motion.div>
      {/* Keep text readable: darken toward the edges and the bottom. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 30% 35%, transparent, color-mix(in oklab, var(--bg) 70%, transparent) 75%), linear-gradient(180deg, transparent 55%, color-mix(in oklab, var(--bg) 85%, transparent))",
        }}
      />
    </div>
  );
}
