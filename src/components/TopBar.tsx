import { CaretLeft, CaretRight, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useUi } from "../store/ui";
import { IconButton } from "./Buttons";

export function TopBar() {
  const query = useUi((s) => s.query);
  const setQuery = useUi((s) => s.setQuery);
  const canBack = useUi((s) => s.back.length > 0);
  const canForward = useUi((s) => s.forward.length > 0);
  const goBack = useUi((s) => s.goBack);
  const goForward = useUi((s) => s.goForward);

  return (
    <header className="topbar sticky top-0 z-20 flex h-16 items-center gap-2 px-6">
      <IconButton label="Back" onClick={goBack} disabled={!canBack} className="bg-black/20">
        <CaretLeft size={18} />
      </IconButton>
      <IconButton label="Forward" onClick={goForward} disabled={!canForward} className="bg-black/20">
        <CaretRight size={18} />
      </IconButton>
      <label className="group relative ml-2 flex h-10 w-full max-w-sm items-center">
        <span className="sr-only">Search your library</span>
        <MagnifyingGlass size={18} className="pointer-events-none absolute left-3.5 text-ink-muted" />
        <input
          id="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search songs, albums, artists"
          spellCheck={false}
          autoComplete="off"
          className="h-full w-full rounded-full bg-white/[0.07] pl-10 pr-16 text-sm text-ink outline-none ring-1 ring-transparent transition-[background-color,box-shadow] placeholder:text-ink-muted hover:bg-white/[0.1] focus:bg-white/[0.1] focus:ring-white/20"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery("")}
            className="absolute right-2 grid h-7 w-7 place-items-center rounded-full text-ink-muted hover:text-ink"
          >
            <X size={16} />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-3.5 font-mono text-[11px] text-ink-faint">Ctrl K</kbd>
        )}
      </label>
    </header>
  );
}
