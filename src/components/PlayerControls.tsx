import { useState } from "react";
import {
  Repeat,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerLow,
  SpeakerNone,
  SpeakerX,
} from "@phosphor-icons/react";
import { api, type Repeat as RepeatMode } from "../lib/api";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import { usePlayer } from "../store/player";
import { useMotionValue, useTransform } from "motion/react";
import { clock } from "../lib/clock";
import { IconButton, PlayButton } from "./Buttons";
import { LiveText, Slider } from "./Slider";

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: "all", all: "one", one: "off" };

export function Transport({ size = "md" }: { size?: "md" | "lg" }) {
  const playing = usePlayer((s) => s.playing);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const hasTrack = usePlayer((s) => s.index != null);
  const lg = size === "lg";
  const icon = lg ? 26 : 20;

  return (
    <div className={cn("flex items-center justify-center", lg ? "gap-5" : "gap-2")}>
      <IconButton
        label={shuffle ? "Turn shuffle off" : "Shuffle"}
        active={shuffle}
        onClick={() => api.setShuffle(!shuffle)}
        className={lg ? "h-11 w-11" : undefined}
      >
        <Shuffle size={icon - 2} />
      </IconButton>
      <IconButton label="Previous" onClick={() => api.prev()} disabled={!hasTrack} className={lg ? "h-11 w-11" : undefined}>
        <SkipBack size={icon} weight="fill" />
      </IconButton>
      <PlayButton playing={playing} onClick={() => api.toggle()} size={lg ? 64 : 40} className="mx-1" />
      <IconButton label="Next" onClick={() => api.next()} disabled={!hasTrack} className={lg ? "h-11 w-11" : undefined}>
        <SkipForward size={icon} weight="fill" />
      </IconButton>
      <IconButton
        label={repeat === "off" ? "Repeat all" : repeat === "all" ? "Repeat one" : "Turn repeat off"}
        active={repeat !== "off"}
        onClick={() => api.setRepeat(NEXT_REPEAT[repeat])}
        className={lg ? "h-11 w-11" : undefined}
      >
        {repeat === "one" ? <RepeatOnce size={icon - 2} /> : <Repeat size={icon - 2} />}
      </IconButton>
    </div>
  );
}

const REMAINING_KEY = "reson.remaining";

export function Progress({ thick, compact }: { thick?: boolean; compact?: boolean }) {
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const [remaining, setRemaining] = useState(() => localStorage.getItem(REMAINING_KEY) === "1");
  // While scrubbing, the time labels follow the thumb instead of playback.
  const scrub = useMotionValue<number | null>(null);
  const shown = useTransform(() => scrub.get() ?? clock.get());
  return (
    <div className={cn("flex w-full items-center font-mono text-[11px] text-ink-muted tabular-nums", compact ? "gap-2" : "gap-3")}>
      {!compact && <LiveText value={shown} format={formatTime} className="w-10 text-right" />}
      <Slider
        label="Seek"
        value={position}
        live={clock}
        max={duration}
        step={5}
        thick={thick}
        format={formatTime}
        onLive={(v) => scrub.set(v)}
        onCommit={(v) => {
          usePlayer.getState().seekLocal(v);
          api.seek(v);
        }}
        className="flex-1"
      />
      {!compact && (
        <button
          type="button"
          title={remaining ? "Show total length" : "Show time remaining"}
          onClick={() => {
            localStorage.setItem(REMAINING_KEY, remaining ? "0" : "1");
            setRemaining(!remaining);
          }}
          className="w-11 text-left transition-colors hover:text-ink"
        >
          {remaining ? (
            <LiveText value={shown} format={(t) => `-${formatTime(Math.max(0, duration - t))}`} />
          ) : (
            formatTime(duration)
          )}
        </button>
      )}
    </div>
  );
}

export function Volume({ className }: { className?: string }) {
  const volume = usePlayer((s) => s.volume);
  const [beforeMute, setBeforeMute] = useState(0.8);
  const set = (v: number) => {
    usePlayer.setState({ volume: v });
    api.setVolume(v);
  };
  const Icon = volume === 0 ? SpeakerX : volume < 0.34 ? SpeakerNone : volume < 0.67 ? SpeakerLow : SpeakerHigh;
  return (
    <div
      className={cn("flex items-center gap-1", className)}
      onWheel={(e) => set(Math.round(Math.min(1, Math.max(0, volume + (e.deltaY < 0 ? 0.05 : -0.05))) * 100) / 100)}
      title={`Volume ${Math.round(volume * 100)}%`}
    >
      <IconButton
        label={volume === 0 ? "Unmute" : "Mute"}
        onClick={() => {
          if (volume > 0) {
            setBeforeMute(volume);
            set(0);
          } else set(beforeMute || 0.8);
        }}
      >
        <Icon size={18} />
      </IconButton>
      <Slider
        label="Volume"
        value={volume}
        max={1}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onCommit={set}
        onLive={(v) => v != null && set(v)}
        className="w-24"
      />
    </div>
  );
}
