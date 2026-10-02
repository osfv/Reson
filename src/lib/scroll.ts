import { createContext, type RefObject } from "react";

/** The main content scroller; virtualized lists measure against it. */
export const ScrollContext = createContext<RefObject<HTMLDivElement | null>>({ current: null });
