import { useState } from "react";
import { LastfmLogo } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { api } from "../../lib/api";
import { useSystem } from "../../store/system";
import { BackButton, CopyValue, ExternalLink, Field, Instruction, PrimaryButton, SetupDialog, StepTitle } from "./SetupDialog";

const BRAND = { name: "Last.fm", color: "#d51007", icon: <LastfmLogo size={26} weight="bold" /> };
const STEPS = ["API account", "Keys", "Allow", "Done"];
const CREATE = "https://www.last.fm/api/account/create";

export type LastFmStart = "create" | "keys" | "allow";

export function LastFmSetup({ onClose, start = "create" }: { onClose: () => void; start?: LastFmStart }) {
  const refresh = useSystem((s) => s.refreshLastfm);
  const [step, setStep] = useState({ create: 0, keys: 1, allow: 2 }[start]);
  const [dir, setDir] = useState(1);
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: "key" | "secret" | "allow"; text: string } | null>(null);
  const [user, setUser] = useState("");

  const go = (to: number) => {
    setDir(to > step ? 1 : -1);
    setError(null);
    setStep(to);
  };

  const checkKeys = async () => {
    const [k, s] = [key.trim(), secret.trim()];
    if (!/^[0-9a-f]{32}$/i.test(k)) return setError({ field: "key", text: "The API key is 32 letters and numbers." });
    if (!/^[0-9a-f]{32}$/i.test(s)) return setError({ field: "secret", text: "The shared secret is 32 letters and numbers." });
    setBusy(true);
    setError(null);
    try {
      await api.lastfmSetKeys(k, s);
      await refresh();
      go(2);
    } catch (e) {
      const text = String(e);
      setError({ field: /secret/i.test(text) ? "secret" : "key", text });
    } finally {
      setBusy(false);
    }
  };

  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      const name = await api.lastfmConnect();
      await refresh();
      if (name) {
        setUser(name);
        go(3);
      } else {
        setError({ field: "allow", text: "Last.fm didn't confirm in time. Open it again and click Yes, allow access." });
      }
    } catch (e) {
      setError({ field: "allow", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const body = [
    <div key="create">
      <StepTitle
        title="Create a Last.fm API account"
        body="Reson scrobbles through your own free API account, so your listens go straight from your PC to Last.fm."
      />
      <ol className="mt-5 flex flex-col gap-4">
        <Instruction n={1}>
          Log in to Last.fm, then open the form.
          <br />
          <ExternalLink href={CREATE}>Open the API account form</ExternalLink>
        </Instruction>
        <Instruction n={2}>
          Fill it in like this. Leave the callback URL and homepage empty.
          <div className="mt-2.5 grid gap-2">
            <CopyValue label="Application name" value="Reson" />
            <CopyValue label="Application description" value="Scrobbles from my desktop music player" />
          </div>
        </Instruction>
        <Instruction n={3}>Submit. Last.fm shows your API key and shared secret.</Instruction>
      </ol>
    </div>,
    <div key="keys">
      <StepTitle title="Add your keys" body="Copy both from the page Last.fm showed you. They stay on this PC." />
      <div className="mt-5 grid gap-4">
        <Field
          id="lastfm-key"
          label="API key"
          value={key}
          onChange={(v) => {
            setKey(v.trim());
            setError(null);
          }}
          placeholder="32 letters and numbers"
          error={error?.field === "key" ? error.text : null}
          autoFocus
        />
        <Field
          id="lastfm-secret"
          label="Shared secret"
          value={secret}
          onChange={(v) => {
            setSecret(v.trim());
            setError(null);
          }}
          placeholder="32 letters and numbers"
          error={error?.field === "secret" ? error.text : null}
          secret
          onEnter={checkKeys}
        />
      </div>
    </div>,
    <div key="allow">
      <StepTitle
        title="Allow Reson to scrobble"
        body={
          <>
            Last.fm opens in your browser and asks to connect your account. Click <b>Yes, allow access</b>, then come back here.
          </>
        }
      />
      <div className="mt-6 rounded-2xl bg-white/[0.04] p-5">
        {busy ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="relative grid h-3 w-3 place-items-center" aria-hidden>
              <motion.span
                className="absolute h-3 w-3 rounded-full bg-[var(--brand)]"
                animate={{ scale: [1, 2.2], opacity: [0.6, 0] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              />
              <span className="h-2 w-2 rounded-full bg-[var(--brand)]" />
            </span>
            Waiting for you to allow access in the browser
          </div>
        ) : (
          <p className="text-sm text-ink-muted">Your keys are saved. One more click on Last.fm and you're scrobbling.</p>
        )}
        {error?.field === "allow" && <p className="mt-3 text-[13px] text-[#fca5a5]">{error.text}</p>}
      </div>
    </div>,
    <div key="done">
      <StepTitle
        title={`Scrobbling as ${user}`}
        body="Songs count once you've heard half of them, or 4 minutes. If you're offline, Reson keeps your listens and sends them later."
      />
      <div className="mt-5">
        <ExternalLink href={`https://www.last.fm/user/${encodeURIComponent(user)}`}>See your profile</ExternalLink>
      </div>
    </div>,
  ][step];

  const footer = (
    <>
      {step === 1 || (step === 2 && !busy) ? <BackButton onClick={() => go(step - 1)} /> : <span />}
      {step === 0 && <PrimaryButton onClick={() => go(1)}>Next</PrimaryButton>}
      {step === 1 && (
        <PrimaryButton onClick={checkKeys} busy={busy}>
          {busy ? "Checking" : "Check keys"}
        </PrimaryButton>
      )}
      {step === 2 && (
        <PrimaryButton onClick={allow} busy={busy}>
          {busy ? "Waiting" : error ? "Open Last.fm again" : "Open Last.fm"}
        </PrimaryButton>
      )}
      {step === 3 && <PrimaryButton onClick={onClose}>Done</PrimaryButton>}
    </>
  );

  return (
    <SetupDialog brand={BRAND} steps={STEPS} step={step} direction={dir} onClose={onClose} footer={footer}>
      {body}
    </SetupDialog>
  );
}
