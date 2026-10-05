import { useState } from "react";
import { DiscordLogo } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { api } from "../../lib/api";
import { usePrefs } from "../../store/prefs";
import { useCurrentTrack } from "../../store/player";
import { Cover } from "../Cover";
import { Toggle } from "../settings/parts";
import { BackButton, ExternalLink, Field, Instruction, PrimaryButton, SetupDialog, StepTitle } from "./SetupDialog";

const BRAND = { name: "Discord", color: "#5865F2", icon: <DiscordLogo size={26} weight="fill" /> };
const STEPS = ["Create app", "Connect", "Live"];
const PORTAL = "https://discord.com/developers/applications";

/** What your status will look like, using the song that's playing now. */
function Preview({ user }: { user: string }) {
  const { track, album } = useCurrentTrack();
  const covers = usePrefs((s) => s.prefs?.discordCovers ?? true);
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="mt-5 rounded-2xl bg-[#232428] p-4 ring-1 ring-white/[0.06]"
    >
      <p className="text-xs font-semibold text-[#dbdee1]">{user} is listening</p>
      <div className="mt-3 flex items-center gap-3.5">
        <Cover album={covers ? album : undefined} className="h-16 w-16 rounded-lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{track?.title ?? "Your song"}</p>
          <p className="truncate text-[13px] text-[#b5bac1]">{track?.artist ?? "The artist"}</p>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/15">
            <motion.div className="h-full w-1/3 rounded-full bg-white" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} style={{ originX: 0 }} transition={{ delay: 0.4, duration: 1.2 }} />
          </div>
        </div>
      </div>
      <div className="mt-3 rounded-md bg-white/[0.07] py-1.5 text-center text-[13px] font-medium text-white">Try Reson today</div>
    </motion.div>
  );
}

export function DiscordSetup({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs((s) => s.prefs);
  const set = usePrefs((s) => s.set);
  const [step, setStep] = useState(prefs?.discordAppId ? 1 : 0);
  const [dir, setDir] = useState(1);
  const [appId, setAppId] = useState(prefs?.discordAppId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState("");

  const go = (to: number) => {
    setDir(to > step ? 1 : -1);
    setError(null);
    setStep(to);
  };

  const connect = async () => {
    const id = appId.trim();
    if (!/^\d{17,20}$/.test(id)) {
      setError("An Application ID is a long number, 17 to 20 digits. Use the Copy button on the General Information page.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const name = await api.discordTest(id);
      setUser(name);
      set({ discordAppId: id, discord: true });
      go(2);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const body = [
    <div key="create">
      <StepTitle
        title="Make your own Discord app"
        body={<>Discord shows your app's name after "Listening to". It's free and takes about a minute.</>}
      />
      <ol className="mt-6 flex flex-col gap-4">
        <Instruction n={1}>
          Open the Discord Developer Portal and sign in.
          <br />
          <ExternalLink href={PORTAL}>Open Developer Portal</ExternalLink>
        </Instruction>
        <Instruction n={2}>
          Click <b>New Application</b>, name it what your friends should see (Reson works), accept the terms, and click{" "}
          <b>Create</b>.
        </Instruction>
      </ol>
    </div>,
    <div key="connect">
      <StepTitle
        title="Paste your Application ID"
        body={
          <>
            It's on your app's <b>General Information</b> page, under Application ID. Click <b>Copy</b> there, then paste it
            here. Keep the Discord app open on this PC.
          </>
        }
      />
      <div className="mt-6">
        <Field
          id="discord-app-id"
          label="Application ID"
          value={appId}
          onChange={(v) => {
            setAppId(v.replace(/\s/g, ""));
            setError(null);
          }}
          placeholder="1234567890123456789"
          helper="Reson only uses this to set your status."
          error={error}
          autoFocus
          onEnter={connect}
        />
      </div>
    </div>,
    <div key="live">
      <StepTitle title="You're live on Discord" body={<>Connected as {user}. Play a song and it shows on your profile.</>} />
      <Preview user={user} />
      <div className="mt-5 flex items-center justify-between gap-6">
        <div>
          <p className="text-sm font-medium">Show album art</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">
            Found on iTunes, or your cover is uploaded for a few hours, since Discord only shows images from the web.
          </p>
        </div>
        <Toggle label="Show album art" checked={prefs?.discordCovers ?? true} onChange={(v) => set({ discordCovers: v })} />
      </div>
    </div>,
  ][step];

  const footer = (
    <>
      {step === 1 ? <BackButton onClick={() => go(0)} /> : <span />}
      {step === 0 && <PrimaryButton onClick={() => go(1)}>I made it</PrimaryButton>}
      {step === 1 && (
        <PrimaryButton onClick={connect} busy={busy}>
          {busy ? "Connecting" : "Connect"}
        </PrimaryButton>
      )}
      {step === 2 && <PrimaryButton onClick={onClose}>Done</PrimaryButton>}
    </>
  );

  return (
    <SetupDialog brand={BRAND} steps={STEPS} step={step} direction={dir} onClose={onClose} footer={footer}>
      {body}
    </SetupDialog>
  );
}
