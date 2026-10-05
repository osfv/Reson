import { useEffect } from "react";
import { Heart, MusicNotesSimple, Plus, Queue } from "@phosphor-icons/react";
import { AnimatePresence, motion, useSpring } from "motion/react";
import { api } from "../lib/api";
import { addToPlaylist, createPlaylist, likeTracks } from "../lib/actions";
import { onDrop, pointerX, pointerY, useDrag } from "../store/drag";
import { useLibrary } from "../store/library";
import { useUi } from "../store/ui";

/** Routes drops on app-wide targets: playlists, "new playlist", and the queue. */
function useGlobalDrops() {
  useEffect(
    () =>
      onDrop((target, payload) => {
        const [kind, arg] = target.split(":");
        if (kind === "playlist") addToPlaylist(Number(arg), payload.trackIds);
        else if (kind === "new-playlist") createPlaylist(payload.trackIds);
        else if (kind === "liked") likeTracks(payload.trackIds, true);
        else if (kind === "queue") {
          const at = Number(arg);
          if (payload.source.kind === "queue") api.move(payload.source.uid, at);
          else api.insert(payload.trackIds, at).then(() => useUi.getState().toast("Added to queue"));
        }
      }),
    [],
  );
}

export function DragLayer() {
  useGlobalDrops();
  const payload = useDrag((s) => s.payload);
  const over = useDrag((s) => s.over);
  // A slightly soft spring so the ghost trails the cursor instead of being glued to it.
  const x = useSpring(pointerX, { stiffness: 900, damping: 55, mass: 0.6 });
  const y = useSpring(pointerY, { stiffness: 900, damping: 55, mass: 0.6 });
  const playlistName = useLibrary((s) =>
    over?.startsWith("playlist:") ? s.playlists.find((p) => p.id === Number(over.split(":")[1]))?.name : undefined,
  );

  const hint = !over
    ? null
    : over.startsWith("playlist:")
      ? { icon: <Plus size={14} weight="bold" />, text: `Add to ${playlistName ?? "playlist"}` }
      : over === "new-playlist"
        ? { icon: <Plus size={14} weight="bold" />, text: "New playlist" }
        : over === "liked"
          ? { icon: <Heart size={14} weight="fill" />, text: "Add to Liked songs" }
        : over.startsWith("queue:")
          ? { icon: <Queue size={14} />, text: payload?.source.kind === "queue" ? "Move here" : "Add to queue" }
          : null;

  return (
    <AnimatePresence>
      {payload && (
        <motion.div
          key="ghost"
          aria-hidden
          className="pointer-events-none fixed left-0 top-0 z-[60]"
          style={{ x, y }}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.12 } }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
        >
          <div className="ml-4 mt-3 flex max-w-72 items-center gap-2 rounded-full bg-ink py-1.5 pl-2 pr-3.5 text-sm font-medium text-[#141416] shadow-[0_12px_32px_-8px_rgb(0_0_0/0.6)]">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#141416] text-ink">
              {hint?.icon ?? <MusicNotesSimple size={14} />}
            </span>
            <span className="truncate">{hint?.text ?? payload.label}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
