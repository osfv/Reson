import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowCounterClockwise, CheckCircle, CircleNotch, Rewind } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { api, type Track } from "../../lib/api";
import { clock } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { formatTime } from "../../lib/format";
import { toLrc } from "../../lib/lrc";
import { useLyrics } from "../../store/lyrics";
import { usePlayer } from "../../store/player";
import { useUi } from "../../store/ui";
import { PillButton } from "../Buttons";

type Step = "write" | "sync" | "review";
type Publish = { stage: "idle" | "challenge" | "solving" | "uploading" | "done" | "error"; hashes?: number; error?: string };

/** Tap-to-sync: play the song and tap Space at the start of each line. */
export function LyricsSync({ track, initialText, onDone }: { track: Track; initialText: string; onDone: () => void }) {
  const [step, setStep] = useState<Step>(initialText.trim() ? "sync" : "write");
  const [text, setText] = useState(initialText);
  const lines = useMemo(() => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), [text]);
  const [stamps, setStamps] = useState<number[]>([]);
  const [flash, setFlash] = useState(0);
  const [writeFile, setWriteFile] = useState(false);
  const [publish, setPublish] = useState<Publish>({ stage: "idle" });
  const put = useLyrics((s) => s.put);
  const playing = usePlayer((s) => s.playing);
  const listRef = useRef<HTMLDivElement>(null);

  const current = stamps.length;
  const lrc = useMemo(() => toLrc(stamps.map((time, i) => ({ time, text: lines[i] }))), [stamps, lines]);

  const tap = () => {
    if (current >= lines.length) return;
    const t = clock.get();
    // Stamps must move forward; a tap before the previous one is almost certainly a double tap.
    if (current > 0 && t <= stamps[current - 1]) return;
    const next = [...stamps, t];
    setStamps(next);
    setFlash((f) => f + 1);
    if (next.length === lines.length) setStep("review");
  };
  const undo = () => setStamps((s) => s.slice(0, -1));
  const restart = () => {
    setStamps([]);
    usePlayer.getState().seekLocal(0);
    api.seek(0);
    if (!usePlayer.getState().playing) api.toggle();
  };

  // While syncing, Space/Backspace belong to the editor, not the global shortcuts.
  useEffect(() => {
    if (step !== "sync") return;
    useUi.getState().setCaptureKeys(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        tap();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        undo();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDone();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      useUi.getState().setCaptureKeys(false);
    };
  });

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>("[data-current]");
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [current, step]);

  useEffect(() => {
    const sub = listen<{ stage: Publish["stage"]; hashes: number }>("lyrics:publish", (e) =>
      setPublish((p) => (p.stage === "error" ? p : { stage: e.payload.stage, hashes: e.payload.hashes })),
    );
    return () => {
      sub.then((f) => f());
    };
  }, []);

  const save = async (share: boolean) => {
    try {
      const saved = await api.lyricsSaveUser(track.id, lrc, lines.join("\n"), writeFile);
      put(track.id, saved);
      if (share) {
        setPublish({ stage: "challenge" });
        await api.lyricsPublish(track.id, lrc, lines.join("\n"));
        setPublish({ stage: "done" });
        useUi.getState().toast("Shared on LRCLIB. Thank you!");
      } else {
        useUi.getState().toast("Lyrics saved");
      }
      onDone();
    } catch (e) {
      setPublish({ stage: "error", error: String(e) });
    }
  };

  if (step === "write") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Header title="Add lyrics" onCancel={onDone} />
        <p className="mt-2 text-sm text-ink-muted">Paste or type the lyrics, one line per sung line. You'll time them next.</p>
        <label htmlFor="lyrics-text" className="sr-only">
          Lyrics
        </label>
        <textarea
          id="lyrics-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          autoFocus
          spellCheck={false}
          className="mt-4 min-h-0 flex-1 resize-none rounded-xl bg-white/[0.06] p-4 text-base leading-relaxed text-ink outline-none ring-1 ring-white/10 focus:ring-white/30"
        />
        <div className="mt-4 flex justify-end">
          <PillButton primary disabled={!lines.length} onClick={() => setStep("sync")}>
            Continue to timing
          </PillButton>
        </div>
      </div>
    );
  }

  if (step === "sync") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Header title="Time the lyrics" onCancel={onDone} />
        <p className="mt-2 text-sm text-ink-muted">
          Press <Kbd>Space</Kbd> as each line starts. <Kbd>Backspace</Kbd> undoes the last one.
        </p>
        <div
          ref={listRef}
          className="relative mt-4 min-h-0 flex-1 overflow-y-auto pr-2 [scrollbar-width:none]"
          style={{ maskImage: "linear-gradient(transparent, black 12%, black 85%, transparent)" }}
        >
          <div className="h-[30%]" />
          {lines.map((l, i) => (
            <div
              key={i}
              data-current={i === current || undefined}
              className={cn(
                "flex items-baseline gap-4 py-1.5 transition-[opacity,scale] duration-300",
                i === current ? "scale-100 opacity-100" : i < current ? "opacity-35" : "opacity-55",
              )}
            >
              <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-ink-faint">
                {stamps[i] != null ? formatTime(stamps[i]) : ""}
              </span>
              <span className={cn("font-semibold tracking-tight", i === current ? "text-2xl text-ink" : "text-lg")}>
                {i === current ? (
                  <motion.span key={flash} initial={{ opacity: 0.4, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25 }}>
                    {l}
                  </motion.span>
                ) : (
                  l
                )}
              </span>
            </div>
          ))}
          <div className="h-[40%]" />
        </div>
        <div className="mt-4 flex items-center gap-2">
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            onClick={tap}
            className="h-12 flex-1 rounded-full bg-accent text-base font-semibold text-on-accent"
          >
            Tap ({current}/{lines.length})
          </motion.button>
          <PillButton onClick={undo} disabled={!current} title="Undo last tap">
            <ArrowCounterClockwise size={16} />
          </PillButton>
          <PillButton onClick={restart} title="Start over from the beginning of the song">
            <Rewind size={16} />
            Restart
          </PillButton>
        </div>
        {!playing && <p className="mt-2 text-xs text-ink-faint">Playback is paused. Press Restart or play the song to start timing.</p>}
      </div>
    );
  }

  const busy = publish.stage !== "idle" && publish.stage !== "error" && publish.stage !== "done";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header title="Looks good?" onCancel={onDone} />
      <p className="mt-2 text-sm text-ink-muted">Every line is timed. Save them for yourself, or share them so everyone gets synced lyrics for this song.</p>
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-xl bg-white/[0.04] p-4">
        {stamps.map((t, i) => (
          <div key={i} className="flex gap-4 py-0.5 text-sm">
            <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-ink-faint">{formatTime(t)}</span>
            <span className="text-ink/85">{lines[i]}</span>
          </div>
        ))}
      </div>
      <label className="mt-4 flex items-center gap-2.5 text-sm text-ink-muted">
        <input type="checkbox" checked={writeFile} onChange={(e) => setWriteFile(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
        Also save a .lrc file next to the song
      </label>
      <AnimatePresence>
        {publish.stage !== "idle" && (
          <motion.p initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
            {busy ? <CircleNotch size={16} className="animate-spin" /> : publish.stage === "done" ? <CheckCircle size={16} className="text-accent" /> : null}
            {publish.stage === "challenge" && "Asking LRCLIB for an upload ticket"}
            {publish.stage === "solving" && `Solving LRCLIB's anti-spam puzzle (${((publish.hashes ?? 0) / 1e6).toFixed(1)}M tries)`}
            {publish.stage === "uploading" && "Uploading"}
            {publish.stage === "done" && "Shared"}
            {publish.stage === "error" && publish.error}
          </motion.p>
        )}
      </AnimatePresence>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <PillButton onClick={() => setStep("sync")} disabled={busy}>
          Back
        </PillButton>
        <PillButton onClick={() => save(false)} disabled={busy}>
          Save
        </PillButton>
        <PillButton primary onClick={() => save(true)} disabled={busy} title="Publishes these lyrics publicly on lrclib.net">
          Save and share on LRCLIB
        </PillButton>
      </div>
    </div>
  );
}

function Header({ title, onCancel }: { title: string; onCancel: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <button type="button" onClick={onCancel} className="rounded-full px-3 py-1 text-sm text-ink-muted hover:bg-white/10 hover:text-ink">
        Cancel
      </button>
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-ink">{children}</kbd>;
}
