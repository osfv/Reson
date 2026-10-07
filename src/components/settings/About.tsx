import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ArrowClockwise, DownloadSimple, GithubLogo } from "@phosphor-icons/react";
import { api } from "../../lib/api";
import { usePrefs } from "../../store/prefs";
import { useSystem } from "../../store/system";
import { useUi } from "../../store/ui";
import { PillButton } from "../Buttons";
import { Group, Row, Toggle } from "./parts";

const REPO = "https://github.com/osfv/Reson";

export function UpdateButton({ className }: { className?: string }) {
  const update = useSystem((s) => s.update);
  const installing = useSystem((s) => s.installing);
  const install = useSystem((s) => s.install);
  const toast = useUi((s) => s.toast);
  if (!update) return null;
  const pct = installing?.total ? Math.round((installing.downloaded / installing.total) * 100) : null;
  return (
    <PillButton
      primary
      className={className}
      disabled={!!installing}
      onClick={() => install().catch((e) => toast(String(e)))}
    >
      <DownloadSimple size={16} weight="bold" />
      {installing ? (pct != null ? `Downloading ${pct}%` : "Starting download") : `Update to ${update.version}`}
    </PillButton>
  );
}

export function AboutSettings() {
  const prefs = usePrefs((s) => s.prefs);
  const set = usePrefs((s) => s.set);
  const update = useSystem((s) => s.update);
  const setUpdate = useSystem((s) => s.setUpdate);
  const toast = useUi((s) => s.toast);
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);
  if (!prefs) return null;

  const check = async () => {
    setChecking(true);
    try {
      const found = await api.updateCheck();
      setUpdate(found);
      if (!found) toast("You're on the latest version");
    } catch (e) {
      toast(String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Group title="About">
      <Row
        title={`Reson ${version}`}
        body={
          update
            ? `Version ${update.version} is available. Reson downloads it, checks its signature, and restarts.`
            : "Free and open source under the MIT license."
        }
      >
        <div className="flex gap-2">
          {update ? (
            <UpdateButton />
          ) : (
            <PillButton onClick={check} disabled={checking} className="disabled:opacity-60">
              <ArrowClockwise size={16} className={checking ? "animate-spin" : undefined} />
              {checking ? "Checking" : "Check for updates"}
            </PillButton>
          )}
          <PillButton onClick={() => api.openLink(REPO)} title="Open on GitHub">
            <GithubLogo size={16} weight="fill" />
            GitHub
          </PillButton>
        </div>
      </Row>
      {update?.notes && (
        <div className="py-4">
          <p className="text-sm font-medium">What's new in {update.version}</p>
          <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-ink-muted">{update.notes.slice(0, 800)}</p>
        </div>
      )}
      <Row title="Check for updates automatically" body="Looks at Reson's GitHub releases a couple of times a day. Updates only install when you say so.">
        <Toggle label="Check for updates automatically" checked={prefs.autoUpdate} onChange={(v) => set({ autoUpdate: v })} />
      </Row>
    </Group>
  );
}
