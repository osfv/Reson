import { useEffect } from "react";
import { api } from "../lib/api";
import { useUi } from "../store/ui";

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if (ui.captureKeys) return;
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === "Escape") {
        if (ui.menu) ui.closeMenu();
        else if (ui.info != null) ui.showInfo(null);
        else if (ui.nowPlaying) ui.setNowPlaying(false);
        else if (typing) t.blur();
        return;
      }
      if (mod && (e.key === "k" || e.key === "f")) {
        e.preventDefault();
        document.getElementById("search")?.focus();
        return;
      }
      if (typing) return;
      if (e.key === " " && !(t instanceof HTMLButtonElement)) {
        e.preventDefault();
        api.toggle();
      } else if (mod && e.key === "ArrowRight") {
        e.preventDefault();
        api.next();
      } else if (mod && e.key === "ArrowLeft") {
        e.preventDefault();
        api.prev();
      } else if (!mod && e.key.toLowerCase() === "l" && ui.nowPlaying) {
        ui.toggleLyrics();
      } else if (e.altKey && e.key === "ArrowLeft") {
        ui.goBack();
      } else if (e.altKey && e.key === "ArrowRight") {
        ui.goForward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
