import type { PointerEvent as ReactPointerEvent } from "react";
import { motionValue } from "motion/react";
import { create } from "zustand";

/**
 * In-app drag and drop for songs. Tauri's file-drop importing disables the browser's native
 * drag-and-drop on Windows, so this is pointer-based: sources call `beginDragGesture` on
 * pointerdown, targets mark themselves with `data-drop="..."`, and the DragLayer resolves drops.
 */
export type DragSource =
  | { kind: "tracks" }
  | { kind: "list"; listId: string; index: number }
  | { kind: "queue"; uid: number };

export interface DragPayload {
  trackIds: number[];
  label: string;
  source: DragSource;
}

interface DragState {
  payload: DragPayload | null;
  /** The `data-drop` value under the pointer. */
  over: string | null;
  setOver: (over: string | null) => void;
  end: () => void;
}

export const pointerX = motionValue(0);
export const pointerY = motionValue(0);

export const useDrag = create<DragState>((set) => ({
  payload: null,
  over: null,
  setOver: (over) => set((s) => (s.over === over ? s : { over })),
  end: () => set({ payload: null, over: null }),
}));

/** Set right after a drag ends so the click that follows the pointerup doesn't also fire. */
let suppressClickUntil = 0;
export const clickSuppressed = () => performance.now() < suppressClickUntil;

const THRESHOLD = 6;

/** Starts tracking a potential drag. It only becomes a drag once the pointer moves a few pixels,
 * so ordinary clicks and double-clicks keep working. */
export function beginDragGesture(e: ReactPointerEvent, make: () => DragPayload | null) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("input, textarea, [data-no-drag]")) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let started = false;
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      const payload = make();
      if (!payload) return cleanup();
      started = true;
      document.body.classList.add("dragging");
      useDrag.setState({ payload, over: null });
    }
    pointerX.set(ev.clientX);
    pointerY.set(ev.clientY);
    const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-drop]");
    useDrag.getState().setOver(hit?.dataset.drop ?? null);
  };
  const up = () => {
    if (started) {
      suppressClickUntil = performance.now() + 250;
      document.body.classList.remove("dragging");
      const { payload, over } = useDrag.getState();
      useDrag.getState().end();
      if (payload && over) dropHandlers.forEach((h) => h(over, payload));
    }
    cleanup();
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

type DropHandler = (target: string, payload: DragPayload) => void;
const dropHandlers = new Set<DropHandler>();

/** Registers a handler for drops; returns an unregister function. */
export function onDrop(handler: DropHandler) {
  dropHandlers.add(handler);
  return () => {
    dropHandlers.delete(handler);
  };
}
