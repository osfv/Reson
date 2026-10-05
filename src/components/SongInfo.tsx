import { useEffect, useRef } from "react";
import { CheckCircle, CircleNotch, Info, Question, WarningCircle, X } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { cn } from "../lib/cn";
import { extensionOf, formatBytes, formatTime, isLossless, mislabeled } from "../lib/format";
import { qualityVerdict, type Verdict } from "../lib/quality";
import { useLibrary } from "../store/library";
import { useUi } from "../store/ui";
import { IconButton } from "./Buttons";
import { Cover } from "./Cover";
import { FormatBadge } from "./FormatBadge";

const channelLabel = (n: number) => (n === 1 ? "Mono" : n === 2 ? "Stereo" : `${n} channels`);

function VerdictIcon({ level }: { level: Verdict["level"] }) {
  const cls = "mt-px shrink-0";
  switch (level) {
    case "likely":
    case "upsampled":
      return <WarningCircle size={20} className={cn(cls, "text-accent")} />;
    case "maybe":
      return <Info size={20} className={cn(cls, "text-ink-muted")} />;
    case "clean":
      return <CheckCircle size={20} className={cn(cls, "text-accent")} />;
    case "pending":
      return <CircleNotch size={20} className={cn(cls, "animate-spin text-ink-muted")} />;
    default:
      return <Question size={20} className={cn(cls, "text-ink-muted")} />;
  }
}

export function SongInfo({ id }: { id: number }) {
  const track = useLibrary((s) => s.trackById.get(id));
  const album = useLibrary((s) => (track ? s.albumById.get(track.albumId) : undefined));
  const close = () => useUi.getState().showInfo(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  if (!track) return null;
  const wrongExt = mislabeled(track);
  const verdict = qualityVerdict(track);
  const facts: [string, string | null][] = [
    ["Format", track.format ? `${track.format}, ${isLossless(track.format) ? "lossless" : "lossy"}` : null],
    ["Bit depth", track.bitDepth ? `${track.bitDepth}-bit` : null],
    ["Sample rate", track.sampleRate ? `${+(track.sampleRate / 1000).toFixed(1)} kHz` : null],
    ["Bitrate", track.bitrate ? `${track.bitrate.toLocaleString()} kbps` : null],
    ["Channels", track.channels ? channelLabel(track.channels) : null],
    ["Duration", formatTime(track.duration)],
    ["File size", track.size != null ? formatBytes(track.size) : null],
    ["Extension", `.${extensionOf(track.path)}`],
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="song-info-title"
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-[color-mix(in_oklab,var(--bg)_70%,#2a2a2e)] p-6 shadow-[0_32px_80px_-20px_rgb(0_0_0/0.7)]"
      >
        <div className="flex items-start gap-4">
          <Cover album={album} className="h-16 w-16" />
          <div className="min-w-0 flex-1 pt-1">
            <div className="flex items-center gap-2">
              <h2 id="song-info-title" className="truncate text-lg font-semibold tracking-tight">
                {track.title}
              </h2>
              <FormatBadge track={track} />
            </div>
            <p className="truncate text-sm text-ink-muted">
              {track.artist}
              {album ? `, ${album.title}` : ""}
            </p>
          </div>
          <IconButton ref={closeRef} label="Close" onClick={close} className="-mr-2 -mt-1">
            <X size={18} />
          </IconButton>
        </div>

        {wrongExt && (
          <div className="mt-5 flex gap-3 rounded-md bg-white/[0.05] p-3 text-sm">
            <WarningCircle size={20} className="shrink-0 text-accent" />
            <p className="leading-relaxed text-ink-muted">
              This file is named <span className="font-mono text-ink">.{wrongExt}</span>, but the audio inside is{" "}
              <span className="font-medium text-ink">{track.format}</span>.
            </p>
          </div>
        )}

        {verdict && (
          <div className="mt-5 flex gap-3 rounded-md bg-white/[0.05] p-3 text-sm">
            <VerdictIcon level={verdict.level} />
            <div>
              <p className="font-medium text-ink">{verdict.title}</p>
              <p className="mt-0.5 leading-relaxed text-ink-muted">{verdict.body}</p>
            </div>
          </div>
        )}

        {track.format ? (
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-ink-muted">{label}</dt>
                <dd className={cn("mt-0.5 text-sm", value ? "text-ink" : "text-ink-faint")}>{value ?? "Not reported"}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-6 text-sm text-ink-muted">Reading file details…</p>
        )}

        <dl className="mt-6 border-t border-line pt-4">
          <dt className="text-xs text-ink-muted">Location</dt>
          <dd className="mt-1 select-text break-all font-mono text-xs leading-relaxed text-ink">{track.path}</dd>
        </dl>
      </motion.div>
    </motion.div>
  );
}
