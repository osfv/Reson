import { X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { api, type QueueEntry } from "../lib/api";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import { beginDragGesture, useDrag } from "../store/drag";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { IconButton } from "./Buttons";
import { Cover } from "./Cover";
import { Equalizer } from "./TrackList";

const MAX_UPCOMING = 120;

/** `at` is this row's absolute queue index; dropping on it inserts before it. */
function QueueRow({ entry, current, at }: { entry: QueueEntry; current?: boolean; at: number }) {
  const track = useLibrary((s) => s.trackById.get(entry.id));
  const album = useLibrary((s) => (track ? s.albumById.get(track.albumId) : undefined));
  const playing = usePlayer((s) => s.playing);
  const over = useDrag((s) => s.over === `queue:${at}`);
  const dragging = useDrag((s) => s.payload?.source.kind === "queue" && s.payload.source.uid === entry.uid);
  if (!track) return null;
  return (
    <div
      data-drop={current ? undefined : `queue:${at}`}
      onDoubleClick={() => !current && api.jump(entry.uid)}
      onPointerDown={
        current
          ? undefined
          : (e) => beginDragGesture(e, () => ({ trackIds: [track.id], label: track.title, source: { kind: "queue", uid: entry.uid } }))
      }
      className={cn(
        "group relative flex items-center gap-3 rounded-md p-1.5 pr-2 transition-opacity",
        !current && "hover:bg-white/[0.05]",
        dragging && "opacity-40",
      )}
    >
      {over && <span className="pointer-events-none absolute inset-x-2 -top-px h-0.5 rounded-full bg-accent" />}
      <button
        type="button"
        onClick={() => (current ? api.toggle() : api.jump(entry.uid))}
        aria-label={current ? "Play or pause" : `Play ${track.title}`}
        className="shrink-0"
      >
        <Cover album={album} className="h-11 w-11 rounded-md" />
      </button>
      <div className="min-w-0 flex-1">
        <div className={cn("flex items-center gap-2 truncate text-sm font-medium", current ? "text-accent" : "text-ink")}>
          {current && <Equalizer paused={!playing} />}
          <span className="truncate">{track.title}</span>
        </div>
        <div className="truncate text-xs text-ink-muted">{track.artist}</div>
      </div>
      {current ? null : (
        <>
          <span className="font-mono text-xs text-ink-faint tabular-nums group-hover:hidden">{formatTime(track.duration)}</span>
          <button
            type="button"
            data-no-drag
            aria-label={`Remove ${track.title} from queue`}
            onClick={() => api.removeFromQueue(entry.uid)}
            className="hidden h-7 w-7 place-items-center rounded-full text-ink-muted hover:bg-white/10 hover:text-ink group-hover:grid"
          >
            <X size={14} />
          </button>
        </>
      )}
    </div>
  );
}

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const shuffle = usePlayer((s) => s.shuffle);
  const toggleQueue = useUi((s) => s.toggleQueue);
  const dragActive = useDrag((s) => s.payload != null);
  const overEnd = useDrag((s) => s.over === `queue:${queue.length}`);
  const current = index != null ? queue[index] : undefined;
  const first = index != null ? index + 1 : 0;
  const upcoming = queue.slice(first);

  return (
    <motion.aside
      initial={{ opacity: 0, x: 24, width: 0 }}
      animate={{ opacity: 1, x: 0, width: 340 }}
      exit={{ opacity: 0, x: 24, width: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 34 }}
      className="shrink-0 overflow-hidden"
      aria-label="Queue"
    >
      <div className={cn("panel flex h-full w-[340px] flex-col rounded-2xl transition-shadow", dragActive && "ring-1 ring-white/10")}>
        <div className="flex h-14 items-center justify-between pl-5 pr-2">
          <h2 className="text-base font-semibold">Queue</h2>
          <IconButton label="Close queue" onClick={toggleQueue}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {!current && upcoming.length === 0 ? (
            <div data-drop="queue:0" className="mx-1 rounded-xl px-3 py-8 text-center">
              <p className="text-sm font-medium">Nothing queued</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">Play an album, or drag songs here.</p>
            </div>
          ) : (
            <>
              {current && (
                <section>
                  <h3 className="px-2 pb-1.5 pt-1 text-[13px] font-medium text-ink-muted">Now playing</h3>
                  <QueueRow entry={current} current at={index!} />
                </section>
              )}
              <section className="mt-5">
                <div className="flex items-center justify-between px-2 pb-1.5">
                  <h3 className="text-[13px] font-medium text-ink-muted">Next up{shuffle ? ", shuffled" : ""}</h3>
                  {upcoming.length > 0 && (
                    <button
                      type="button"
                      onClick={() => api.clearUpcoming()}
                      className="rounded-full px-2 py-0.5 text-xs text-ink-muted transition-colors hover:bg-white/[0.08] hover:text-ink"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <AnimatePresence initial={false}>
                  {upcoming.slice(0, MAX_UPCOMING).map((e, i) => (
                    <motion.div
                      key={e.uid}
                      layout
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -12, transition: { duration: 0.15 } }}
                      transition={{ type: "spring", stiffness: 420, damping: 36 }}
                    >
                      <QueueRow entry={e} at={first + i} />
                    </motion.div>
                  ))}
                </AnimatePresence>
                {upcoming.length > MAX_UPCOMING && (
                  <p className="px-2 pt-2 text-xs text-ink-faint">and {(upcoming.length - MAX_UPCOMING).toLocaleString()} more</p>
                )}
                {/* Drop zone for "add to the end". */}
                <div
                  data-drop={`queue:${queue.length}`}
                  className={cn(
                    "mt-1 grid h-12 place-items-center rounded-md text-xs text-ink-faint transition-colors",
                    dragActive ? "border border-dashed border-white/15" : "border border-transparent",
                    overEnd && "border-accent text-ink",
                  )}
                >
                  {dragActive ? "Drop to add at the end" : ""}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </motion.aside>
  );
}
