import type { ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowClockwise, FolderSimple, FolderSimplePlus, PictureInPicture, X } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { PillButton } from "../components/Buttons";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { usePrefs, watchFolders } from "../store/prefs";
import { useUi } from "../store/ui";

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
        checked ? "bg-accent" : "bg-white/15",
      )}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 700, damping: 35 }}
        className={cn("absolute top-0.5 h-5 w-5 rounded-full shadow", checked ? "right-0.5 bg-on-accent" : "left-0.5 bg-ink")}
      />
    </button>
  );
}

function Row({ title, body, children }: { title: string; body?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-8 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {body && <p className="mt-1 max-w-[60ch] text-[13px] leading-relaxed text-ink-muted">{body}</p>}
      </div>
      {children}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10 first:mt-6">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="mt-2 divide-y divide-line">{children}</div>
    </section>
  );
}

export function SettingsView() {
  const prefs = usePrefs((s) => s.prefs);
  const ui = usePrefs((s) => s.ui);
  const set = usePrefs((s) => s.set);
  const setUi = usePrefs((s) => s.setUi);
  const toast = useUi((s) => s.toast);

  const addFolder = async () => {
    const picked = await open({ directory: true, multiple: true, title: "Watch music folders" });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!paths.length) return;
    watchFolders(paths);
    api.importPaths(paths);
  };

  if (!prefs) return <div className="px-8 pt-4 text-sm text-ink-muted">Loading settings…</div>;
  const cf = prefs.crossfade;

  return (
    <div className="max-w-3xl px-8 pb-16 pt-2">
      <h1 className="text-4xl font-semibold tracking-tight">Settings</h1>

      <Group title="Playback">
        <Row
          title="Crossfade"
          body={cf === 0 ? "Off. Songs play back to back with no gap." : `The next song fades in over ${cf} seconds as the current one ends.`}
        >
          <div className="flex w-56 items-center gap-3">
            <input
              type="range"
              min={0}
              max={12}
              step={1}
              value={cf}
              aria-label="Crossfade seconds"
              onChange={(e) => set({ crossfade: Number(e.target.value) })}
              className="h-1 flex-1 cursor-pointer accent-[var(--accent)]"
            />
            <span className="w-10 text-right font-mono text-xs tabular-nums text-ink-muted">{cf === 0 ? "Off" : `${cf}s`}</span>
          </div>
        </Row>
        <Row
          title="Normalize volume"
          body="Plays every song at a similar loudness so quiet and loud masters don't jump. Uses ReplayGain tags, or measures songs in the background."
        >
          <Toggle label="Normalize volume" checked={prefs.normalize} onChange={(v) => set({ normalize: v })} />
        </Row>
      </Group>

      <Group title="Lyrics">
        <Row title="Karaoke highlighting" body="Fills each word as it's sung. Uses word timing when the lyrics have it, and estimates it otherwise.">
          <Toggle label="Karaoke highlighting" checked={ui.karaoke} onChange={(v) => setUi({ karaoke: v })} />
        </Row>
        <Row
          title="Current line in the player bar"
          body="Shows the line being sung under the song title. Looks up lyrics on LRCLIB for each song you play."
        >
          <Toggle label="Current line in the player bar" checked={ui.barLyrics} onChange={(v) => setUi({ barLyrics: v })} />
        </Row>
      </Group>

      <Group title="Visuals">
        <Row title="Beat pulse" body="In Now Playing, the cover and background pulse gently with the kick drum.">
          <Toggle label="Beat pulse" checked={ui.beatPulse} onChange={(v) => setUi({ beatPulse: v })} />
        </Row>
        <Row title="Spectrum bars" body="Moving frequency bars along the bottom of Now Playing.">
          <Toggle label="Spectrum bars" checked={ui.visualizer} onChange={(v) => setUi({ visualizer: v })} />
        </Row>
      </Group>

      <Group title="Library">
        <div className="py-4">
          <p className="text-sm font-medium">Watched folders</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
            New and changed songs in these folders appear in your library automatically, even while Reson is closed.
          </p>
          <div className="mt-3 flex flex-col gap-1">
            {prefs.watchFolders.length === 0 && <p className="text-[13px] text-ink-faint">No folders yet.</p>}
            {prefs.watchFolders.map((f) => (
              <div key={f} className="group flex items-center gap-3 rounded-md bg-white/[0.04] px-3 py-2">
                <FolderSimple size={18} className="shrink-0 text-ink-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f}</span>
                <button
                  type="button"
                  aria-label={`Stop watching ${f}`}
                  onClick={() => set({ watchFolders: prefs.watchFolders.filter((x) => x !== f) })}
                  className="grid h-7 w-7 place-items-center rounded-full text-ink-muted opacity-0 transition-opacity hover:bg-white/10 hover:text-ink group-hover:opacity-100"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <PillButton onClick={addFolder}>
              <FolderSimplePlus size={16} />
              Add folder
            </PillButton>
            {prefs.watchFolders.length > 0 && (
              <PillButton
                onClick={() => {
                  api.importPaths(prefs.watchFolders);
                  toast("Rescanning your folders");
                }}
              >
                <ArrowClockwise size={16} />
                Rescan now
              </PillButton>
            )}
          </div>
        </div>
      </Group>

      <Group title="Window">
        <Row title="Close to tray" body="Closing the window keeps the music playing. Reopen Reson from the tray icon.">
          <Toggle label="Close to tray" checked={prefs.closeToTray} onChange={(v) => set({ closeToTray: v })} />
        </Row>
        <Row title="Mini player" body="A small always-on-top player. Also in the tray menu.">
          <PillButton onClick={() => api.miniPlayer(true)}>
            <PictureInPicture size={16} />
            Open mini player
          </PillButton>
        </Row>
      </Group>
    </div>
  );
}
