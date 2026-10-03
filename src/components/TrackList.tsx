import {
  memo,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Clock, DotsThree, Pause, Play } from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { Track } from "../lib/api";
import { api } from "../lib/api";
import { addToPlaylist, playTracks, trackMenu } from "../lib/actions";
import { cn } from "../lib/cn";
import { formatTime, plural } from "../lib/format";
import { ScrollContext } from "../lib/scroll";
import { beginDragGesture, onDrop, useDrag } from "../store/drag";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { Cover } from "./Cover";
import { FormatBadge } from "./FormatBadge";

const ROW = 56;
const COLS = {
  library: "grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_4.5rem_3.5rem_2rem]",
  album: "grid-cols-[2rem_minmax(0,1fr)_4.5rem_3.5rem_2rem]",
};

interface TrackListProps {
  tracks: Track[];
  /** "album" shows track numbers and hides album/cover columns. */
  variant?: "album" | "library";
  playlistId?: number;
  /** Enables drag-to-reorder (playlists). */
  onMove?: (from: number, to: number) => void;
  /** Playlist position of each row, when rows are a filtered view of the playlist. */
  positions?: number[];
}

export function Equalizer({ paused }: { paused?: boolean }) {
  return (
    <span className={cn("eq flex h-3.5 items-end gap-[2px]", paused && "paused")} aria-hidden>
      <span className="h-full w-[3px] rounded-full bg-accent" />
      <span className="h-full w-[3px] rounded-full bg-accent" />
      <span className="h-full w-[3px] rounded-full bg-accent" />
    </span>
  );
}

const Row = memo(function Row({
  track,
  index,
  number,
  variant,
  selected,
  current,
  playing,
  onSelect,
  onPlay,
  onMenu,
  onDragStart,
}: {
  track: Track;
  index: number;
  number: number;
  variant: "album" | "library";
  selected: boolean;
  current: boolean;
  playing: boolean;
  onSelect: (i: number, e: MouseEvent) => void;
  onPlay: (i: number) => void;
  onMenu: (i: number, e: MouseEvent) => void;
  onDragStart?: (i: number, e: PointerEvent) => void;
}) {
  const album = useLibrary((s) => s.albumById.get(track.albumId));
  const navigate = useUi((s) => s.navigate);
  const lib = variant === "library";

  return (
    <div
      role="row"
      aria-selected={selected}
      onClick={(e) => onSelect(index, e)}
      onDoubleClick={() => onPlay(index)}
      onContextMenu={(e) => onMenu(index, e)}
      onPointerDown={onDragStart ? (e) => onDragStart(index, e) : undefined}
      className={cn(
        "group grid h-14 items-center gap-4 rounded-md px-3 text-sm transition-colors",
        COLS[variant],
        selected ? "bg-white/[0.1]" : "hover:bg-white/[0.05]",
      )}
    >
      <div className="relative grid h-full place-items-center text-ink-muted">
        <span className={cn("font-mono text-[13px] tabular-nums group-hover:invisible", current && "invisible")}>
          {number}
        </span>
        {current && (
          <span className="absolute group-hover:invisible">
            <Equalizer paused={!playing} />
          </span>
        )}
        <button
          type="button"
          aria-label={current && playing ? "Pause" : `Play ${track.title}`}
          onClick={(e) => {
            e.stopPropagation();
            if (current) api.toggle();
            else onPlay(index);
          }}
          className="absolute inset-0 hidden place-items-center text-ink group-hover:grid"
        >
          {current && playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-3">
        {lib && <Cover album={album} className="h-10 w-10 rounded-md" />}
        <div className="min-w-0">
          <div className={cn("truncate font-medium", current ? "text-accent" : "text-ink")}>{track.title}</div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigate({ name: "artist", artist: album?.artist ?? track.artist });
            }}
            className="block max-w-full truncate text-left text-[13px] text-ink-muted hover:text-ink hover:underline"
          >
            {track.artist}
          </button>
        </div>
      </div>

      {lib && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (album) navigate({ name: "album", id: album.id });
          }}
          className="truncate text-left text-[13px] text-ink-muted hover:text-ink hover:underline"
        >
          {album?.title}
        </button>
      )}

      <span>
        <FormatBadge track={track} />
      </span>

      <span className="text-right font-mono text-[13px] text-ink-muted tabular-nums">{formatTime(track.duration)}</span>

      <button
        type="button"
        aria-label={`More options for ${track.title}`}
        onClick={(e) => {
          e.stopPropagation();
          onMenu(index, e);
        }}
        className="grid h-8 w-8 place-items-center rounded-full text-ink-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        <DotsThree size={20} weight="bold" />
      </button>
    </div>
  );
});

export function TrackList({ tracks, variant = "library", playlistId, positions, onMove }: TrackListProps) {
  const scrollRef = useContext(ScrollContext);
  const listRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef(0);
  const listId = useId();
  const openMenu = useUi((s) => s.openMenu);

  const currentId = usePlayer((s) => (s.index != null ? s.queue[s.index]?.id : undefined));
  const playing = usePlayer((s) => s.playing);

  useLayoutEffect(() => {
    const el = listRef.current;
    const sc = scrollRef.current;
    if (el && sc) setOffset(el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop);
  });

  useLayoutEffect(() => {
    setSelected(new Set());
  }, [tracks]);

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 12,
    scrollMargin: offset,
  });

  const ids = () => tracks.map((t) => t.id);
  const onPlay = (i: number) => playTracks(ids(), i);

  const onSelect = (i: number, e: MouseEvent) => {
    setSelected((prev) => {
      if (e.shiftKey) {
        const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
        return new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k));
      }
      anchor.current = i;
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(i)) next.delete(i);
        else next.add(i);
        return next;
      }
      return new Set([i]);
    });
  };

  const onMenu = (i: number, e: MouseEvent) => {
    e.preventDefault();
    const rows = selected.has(i) ? [...selected].sort((a, b) => a - b) : [i];
    if (!selected.has(i)) {
      setSelected(new Set([i]));
      anchor.current = i;
    }
    openMenu(
      e.clientX,
      e.clientY,
      trackMenu(
        rows.map((r) => tracks[r].id),
        { playlistId, positions: playlistId != null ? rows.map((r) => positions?.[r] ?? r) : undefined },
      ),
    );
  };

  const onDragStart = (i: number, e: PointerEvent) =>
    beginDragGesture(e, () => {
      const rows = selected.has(i) ? [...selected].sort((a, b) => a - b) : [i];
      return {
        trackIds: rows.map((r) => tracks[r].id),
        label: rows.length > 1 ? plural(rows.length, "song") : tracks[i].title,
        source: onMove ? { kind: "list", listId, index: i } : { kind: "tracks" },
      };
    });

  // Rows of a reorderable list are drop targets: same list = move, anything else = add here.
  useEffect(() => {
    if (!onMove && playlistId == null) return;
    return onDrop((target, payload) => {
      const prefix = `row:${listId}:`;
      if (!target.startsWith(prefix)) return;
      const to = Number(target.slice(prefix.length));
      if (payload.source.kind === "list" && payload.source.listId === listId) {
        if (onMove && payload.source.index !== to) onMove(payload.source.index, to);
      } else if (playlistId != null) {
        addToPlaylist(playlistId, payload.trackIds);
      }
    });
  }, [listId, onMove, playlistId]);

  const dragSource = useDrag((s) => (s.payload?.source.kind === "list" && s.payload.source.listId === listId ? s.payload.source.index : null));
  const dropRow = useDrag((s) => (s.over?.startsWith(`row:${listId}:`) ? Number(s.over.split(":")[2]) : null));
  const reorderable = onMove != null || playlistId != null;

  const items = virtualizer.getVirtualItems();

  return (
    <div role="grid" aria-rowcount={tracks.length} className="px-6">
      <div
        role="row"
        className={cn(
          "grid h-9 items-center gap-4 border-b border-line px-3 text-xs font-medium text-ink-muted",
          COLS[variant],
        )}
      >
        <span className="text-center">#</span>
        <span>Title</span>
        {variant === "library" && <span>Album</span>}
        <span>Format</span>
        <span className="flex justify-end" aria-label="Duration">
          <Clock size={16} />
        </span>
        <span />
      </div>
      <div ref={listRef} className="relative mt-2" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((v) => {
          const t = tracks[v.index];
          return (
            <div
              key={v.key}
              data-drop={reorderable ? `row:${listId}:${v.index}` : undefined}
              className={cn("absolute inset-x-0 top-0", dragSource === v.index && "opacity-40")}
              style={{ transform: `translateY(${v.start - virtualizer.options.scrollMargin}px)` }}
            >
              <Row
                track={t}
                index={v.index}
                number={variant === "album" ? (t.trackNo ?? v.index + 1) : v.index + 1}
                variant={variant}
                selected={selected.has(v.index)}
                current={t.id === currentId}
                playing={playing}
                onSelect={onSelect}
                onPlay={onPlay}
                onMenu={onMenu}
                onDragStart={onDragStart}
              />
            </div>
          );
        })}
        {dropRow != null && (
          <motion.div
            layout
            className="pointer-events-none absolute inset-x-3 h-0.5 rounded-full bg-accent"
            // The moved song takes the hovered row's place: line above when moving up, below when moving down.
            style={{ top: (dragSource != null && dragSource < dropRow ? dropRow + 1 : dropRow) * ROW - 1 }}
            transition={{ type: "spring", stiffness: 600, damping: 40 }}
          />
        )}
      </div>
    </div>
  );
}
