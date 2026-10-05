import { useEffect, useState } from "react";
import { api, type AudioDevice } from "../../lib/api";
import { usePlayer } from "../../store/player";
import { usePrefs } from "../../store/prefs";
import { Row, Select, Toggle } from "./parts";

const DEFAULT = "__default__";

/** Output device and WASAPI exclusive mode (rows for the Playback group). */
export function OutputSettings() {
  const prefs = usePrefs((s) => s.prefs);
  const set = usePrefs((s) => s.set);
  const output = usePlayer((s) => s.output);
  const [devices, setDevices] = useState<AudioDevice[]>([]);

  useEffect(() => {
    api.audioDevices().then(setDevices).catch(() => {});
  }, []);
  if (!prefs) return null;

  const missing = prefs.outputDevice != null && devices.length > 0 && !devices.some((d) => d.id === prefs.outputDevice);
  const status = output
    ? output.bitPerfect
      ? `Bit-perfect right now: ${output.bits}-bit / ${+(output.rate / 1000).toFixed(1)} kHz straight to the device.`
      : `Exclusive at ${output.bits}-bit / ${+(output.rate / 1000).toFixed(1)} kHz. Not bit-perfect: set the volume to 100% and turn off the equalizer and volume normalization.`
    : null;

  return (
    <>
      <Row
        title="Output device"
        body={missing ? "That device isn't connected, so Reson is using the Windows default." : "Where Reson plays. The system default follows Windows when you switch devices."}
      >
        <Select
          label="Output device"
          value={prefs.outputDevice ?? DEFAULT}
          onChange={(v) => set({ outputDevice: v === DEFAULT ? null : v })}
          options={[
            { value: DEFAULT, label: "System default" },
            ...devices.map((d) => ({ value: d.id, label: d.name + (d.default ? " (default)" : "") })),
            ...(missing ? [{ value: prefs.outputDevice!, label: "Disconnected device" }] : []),
          ]}
        />
      </Row>
      <Row
        title="Exclusive mode"
        body={
          <>
            Reson takes over the device and plays each song at its own sample rate, skipping the Windows mixer. Other apps
            can't play sound on that device meanwhile.
            {status && <span className="mt-1 block text-ink">{status}</span>}
          </>
        }
      >
        <Toggle label="Exclusive mode" checked={prefs.exclusive} onChange={(v) => set({ exclusive: v })} />
      </Row>
    </>
  );
}
