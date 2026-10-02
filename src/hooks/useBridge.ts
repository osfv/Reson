import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, type PlayerSnapshot, type ScanProgress, type Spectrum } from "../lib/api";
import { startClock } from "../lib/clock";
import { plural } from "../lib/format";
import { useHistory } from "../store/history";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { usePrefs } from "../store/prefs";
import { onSpectrum } from "../store/spectrum";
import { useUi } from "../store/ui";

/** Wires backend events into the stores. Mounted once per window. `onDragChange` enables
 * drag-and-drop importing (main window only). */
export function useBridge(onDragChange?: (over: boolean) => void) {
  useEffect(() => {
    const ui = useUi.getState();
    startClock();
    useLibrary.getState().refresh();
    usePrefs.getState().load().catch(() => {});
    useHistory.getState().refresh();
    api.playerState().then(usePlayer.getState().setSnapshot).catch(() => {});

    const subs: Promise<() => void>[] = [
      listen<PlayerSnapshot>("player:state", (e) => usePlayer.getState().setSnapshot(e.payload)),
      listen<{ position: number; duration: number }>("player:progress", (e) =>
        usePlayer.getState().setProgress(e.payload.position, e.payload.duration),
      ),
      listen<Spectrum>("player:spectrum", (e) => onSpectrum(e.payload)),
      listen<string>("player:error", (e) => ui.toast(e.payload)),
      listen("history:changed", () => useHistory.getState().refresh()),
      listen<ScanProgress>("library:scan", (e) => {
        useLibrary.getState().setScan(e.payload);
        if (!e.payload.active && onDragChange) {
          const { added, total, failed, failedNames } = e.payload;
          ui.toast(
            total === 0
              ? "No supported audio files found"
              : added
                ? `Added ${plural(added, "song")} to your library`
                : failed
                  ? "Nothing new was added"
                  : "Your library is already up to date",
          );
          if (failed) {
            const names = failedNames.join(", ") + (failed > failedNames.length ? ` and ${failed - failedNames.length} more` : "");
            ui.toast(`Couldn't read ${plural(failed, "file")}: ${names}. If it's still downloading, add it again when it's done.`);
          }
        }
      }),
      listen("library:changed", () => useLibrary.getState().refresh()),
    ];
    if (onDragChange) {
      subs.push(
        getCurrentWebview().onDragDropEvent((e) => {
          const p = e.payload;
          if (p.type === "enter" || p.type === "over") onDragChange(true);
          else if (p.type === "leave") onDragChange(false);
          else if (p.type === "drop") {
            onDragChange(false);
            if (p.paths.length) api.importPaths(p.paths).catch((err) => ui.toast(String(err)));
          }
        }),
      );
    }
    const unlisten = Promise.all(subs);
    return () => {
      unlisten.then((fns) => fns.forEach((f) => f()));
    };
  }, [onDragChange]);
}
