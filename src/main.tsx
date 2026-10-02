import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "motion/react";
import { IconContext } from "@phosphor-icons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { MiniPlayer } from "./views/MiniPlayer";
import "./index.css";

// The mini player is a second window running the same bundle; its label picks the UI.
const isMini = getCurrentWindow().label === "mini";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <IconContext.Provider value={{ size: 20, weight: "regular" }}>{isMini ? <MiniPlayer /> : <App />}</IconContext.Provider>
    </MotionConfig>
  </React.StrictMode>,
);
