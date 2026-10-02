import { create } from "zustand";
import { api, type History } from "../lib/api";

interface HistoryState {
  history: History | null;
  refresh: () => void;
}

export const useHistory = create<HistoryState>((set) => ({
  history: null,
  refresh: () => {
    api
      .history()
      .then((history) => set({ history }))
      .catch(() => {});
  },
}));
