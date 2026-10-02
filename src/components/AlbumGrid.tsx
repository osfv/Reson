import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import type { Album } from "../lib/api";
import { playTracks, trackMenu } from "../lib/actions";
import { paletteOf } from "../lib/theme";
import { beginDragGesture, clickSuppressed } from "../store/drag";
import { useLibrary } from "../store/library";
import { useUi } from "../store/ui";
import { Cover } from "./Cover";
import { IconButton, PlayButton } from "./Buttons";

/** Cards animate in only the first time they're shown, not on every library refresh or revisit. */
const seen = new Set<string>();
export function firstAppearance(key: string) {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/** Shared-element id so an album cover can morph between the grid and the album page. */
export const albumCoverId = (id: number) => `album-cover-${id}`;

/**
 * `morph` enables the shared cover animation to/from the album page. Cards inside scrolling rows
 * turn it off: the row clips its overflow, so a cover flying in from the album header would be
 * invisible (and could land in the wrong spot while the row is still sizing its cards).
 */
export function AlbumCard({ album, index = 0, morph = true }: { album: Album; index?: number; morph?: boolean }) {
  const navigate = useUi((s) => s.navigate);
  const openMenu = useUi((s) => s.openMenu);
  const reduce = useReducedMotion();
  const p = paletteOf(album);
  const trackIds = () => (useLibrary.getState().albumTracks.get(album.id) ?? []).map((t) => t.id);
  const animateIn = !reduce && firstAppearance(`album:${album.id}`);
  const shared = useUi((s) => morph && s.morphAlbum === album.id);
  const open = () => {
    if (clickSuppressed()) return;
    if (!morph || reduce) return navigate({ name: "album", id: album.id });
    // Tag this card as the morph source for one frame first, so the album page cover can
    // animate out of it (the card is gone by the time the new page renders).
    useUi.setState({ morphAlbum: album.id });
    requestAnimationFrame(() => navigate({ name: "album", id: album.id }));
  };

  return (
    <motion.div
      initial={animateIn ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: Math.min(index, 18) * 0.025, ease: [0.16, 1, 0.3, 1] }}
      className="group min-w-0"
      style={{ "--accent": p.accent, "--on-accent": p.onAccent } as CSSProperties}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, trackMenu(trackIds()).filter((i) => !i.label.startsWith("Go to album")));
      }}
      onPointerDown={(e) => beginDragGesture(e, () => ({ trackIds: trackIds(), label: album.title, source: { kind: "tracks" } }))}
    >
      <div className="relative">
        <button
          type="button"
          onClick={open}
          aria-label={`Open ${album.title}`}
          className="block w-full transition-transform duration-300 ease-out-expo group-hover:-translate-y-1"
        >
          <motion.div
            layoutId={shared ? albumCoverId(album.id) : undefined}
            transition={{ type: "spring", stiffness: 300, damping: 34 }}
          >
            <Cover album={album} className="aspect-square w-full shadow-[0_18px_40px_-18px_rgb(0_0_0/0.7)]" />
          </motion.div>
        </button>
        {/* Tailwind v4 translate/scale utilities are separate CSS properties, so list them explicitly. */}
        <div className="pointer-events-none absolute bottom-2.5 right-2.5 translate-y-3 scale-90 opacity-0 transition-[opacity,translate,scale] duration-[400ms] ease-out-expo group-hover:pointer-events-auto group-hover:-translate-y-1 group-hover:scale-100 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:scale-100 group-focus-within:opacity-100">
          <PlayButton playing={false} label={`Play ${album.title}`} onClick={() => playTracks(trackIds())} size={44} />
        </div>
      </div>
      <button type="button" onClick={open} className="mt-3 block w-full truncate text-left text-sm font-medium text-ink">
        {album.title}
      </button>
      <button
        type="button"
        onClick={() => !clickSuppressed() && navigate({ name: "artist", artist: album.artist })}
        className="mt-0.5 block max-w-full truncate text-left text-[13px] text-ink-muted hover:text-ink hover:underline"
      >
        {album.artist}
        {album.year ? <span className="text-ink-faint"> · {album.year}</span> : null}
      </button>
    </motion.div>
  );
}

export function AlbumGrid({ albums }: { albums: Album[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-6 gap-y-8">
      {albums.map((a, i) => (
        <AlbumCard key={a.id} album={a} index={i} />
      ))}
    </div>
  );
}

const ROW_GAP = 24;
const MIN_CARD = 160;

/**
 * A titled row of album cards for the Home screen. Cards are sized so a whole number fit the
 * width exactly (no half-cut card at the edge). When there are more than fit, arrows page through
 * them; otherwise the row is static. It never scrolls vertically.
 */
export function AlbumRow({ title, albums }: { title: string; albums: Album[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [edges, setEdges] = useState({ left: false, right: false });

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const perView = Math.max(2, Math.floor((width + ROW_GAP) / (MIN_CARD + ROW_GAP)));
  const cardWidth = width ? (width - (perView - 1) * ROW_GAP) / perView : MIN_CARD;

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  };
  useLayoutEffect(() => {
    measure();
  }, [width, albums.length]);

  const page = (dir: 1 | -1) =>
    ref.current?.scrollBy({ left: dir * (cardWidth + ROW_GAP) * perView, behavior: reduce ? "auto" : "smooth" });
  const scrollable = edges.left || edges.right;

  return (
    <section className="mt-10 first:mt-2">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {scrollable && (
          <div className="flex gap-1">
            <IconButton label="Scroll left" onClick={() => page(-1)} disabled={!edges.left} className="bg-white/[0.06]">
              <CaretLeft size={16} weight="bold" />
            </IconButton>
            <IconButton label="Scroll right" onClick={() => page(1)} disabled={!edges.right} className="bg-white/[0.06]">
              <CaretRight size={16} weight="bold" />
            </IconButton>
          </div>
        )}
      </div>
      <div
        ref={ref}
        onScroll={measure}
        // pt-2 leaves room for the hover lift; overflow-y-hidden stops the row scrolling vertically.
        className="flex snap-x snap-mandatory overflow-x-auto overflow-y-hidden pt-2 [scrollbar-width:none]"
        style={{
          gap: ROW_GAP,
          // Fade whichever side has more cards hidden behind it.
          maskImage: scrollable
            ? `linear-gradient(90deg, ${edges.left ? "transparent" : "black"}, black 40px, black calc(100% - 40px), ${edges.right ? "transparent" : "black"})`
            : undefined,
        }}
      >
        {albums.map((a, i) => (
          <div key={a.id} className="shrink-0 snap-start" style={{ width: cardWidth }}>
            <AlbumCard album={a} index={i} morph={false} />
          </div>
        ))}
      </div>
    </section>
  );
}
