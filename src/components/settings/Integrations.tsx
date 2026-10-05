import { useState } from "react";
import { DiscordLogo, LastfmLogo } from "@phosphor-icons/react";
import { AnimatePresence } from "motion/react";
import { api } from "../../lib/api";
import { usePrefs } from "../../store/prefs";
import { useSystem } from "../../store/system";
import { PillButton } from "../Buttons";
import { DiscordSetup } from "../setup/DiscordSetup";
import { LastFmSetup, type LastFmStart } from "../setup/LastFmSetup";
import { Group, Row, Toggle } from "./parts";

function TextButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-[13px] font-medium text-ink-muted underline-offset-4 hover:text-ink hover:underline">
      {children}
    </button>
  );
}

function Title({ icon, children }: { icon: React.ReactNode; children: string }) {
  return (
    <span className="flex items-center gap-2">
      {icon}
      {children}
    </span>
  );
}

export function IntegrationSettings() {
  const prefs = usePrefs((s) => s.prefs);
  const set = usePrefs((s) => s.set);
  const lastfm = useSystem((s) => s.lastfm);
  const refresh = useSystem((s) => s.refreshLastfm);
  const [discordOpen, setDiscordOpen] = useState(false);
  const [lastfmOpen, setLastfmOpen] = useState<LastFmStart | null>(null);
  if (!prefs) return null;

  const discordReady = !!prefs.discordAppId;
  const discordTitle = <Title icon={<DiscordLogo size={18} weight="fill" className="text-[#8c9eff]" />}>Discord status</Title>;
  const lastfmTitle = <Title icon={<LastfmLogo size={18} weight="bold" className="text-[#ff5a50]" />}>Last.fm</Title>;

  return (
    <Group title="Sharing">
      {discordReady ? (
        <>
          <Row
            title={discordTitle}
            body={
              <>
                Shows the song you're playing on your Discord profile, with a "Try Reson today" button.{" "}
                <TextButton onClick={() => setDiscordOpen(true)}>Change app</TextButton>
              </>
            }
          >
            <Toggle label="Discord status" checked={prefs.discord} onChange={(v) => set({ discord: v })} />
          </Row>
          <Row
            title="Album art on Discord"
            body="Discord only shows images from the web. Reson finds the cover on iTunes, or uploads your cover to a temporary host (uguu.se or Litterbox) that deletes it within 3 days."
          >
            <Toggle label="Album art on Discord" checked={prefs.discordCovers} disabled={!prefs.discord} onChange={(v) => set({ discordCovers: v })} />
          </Row>
        </>
      ) : (
        <Row title={discordTitle} body="Show the song you're playing on your Discord profile. You connect your own free Discord app in a minute.">
          <PillButton primary onClick={() => setDiscordOpen(true)}>
            Set up
          </PillButton>
        </Row>
      )}

      {lastfm?.user ? (
        <Row
          title={lastfmTitle}
          body={
            <>
              Scrobbling as <span className="text-ink">{lastfm.user}</span>.{" "}
              <TextButton onClick={() => setLastfmOpen("keys")}>Change keys</TextButton>
            </>
          }
        >
          <PillButton onClick={() => api.lastfmDisconnect().then(refresh)}>Disconnect</PillButton>
        </Row>
      ) : lastfm?.configured ? (
        <Row
          title={lastfmTitle}
          body={
            <>
              Your API keys (ending in {lastfm.keyHint}) are saved. Allow Reson on Last.fm to start scrobbling.{" "}
              <TextButton onClick={() => api.lastfmClearKeys().then(refresh)}>Remove keys</TextButton>
            </>
          }
        >
          <PillButton primary onClick={() => setLastfmOpen("allow")}>
            Connect
          </PillButton>
        </Row>
      ) : (
        <Row title={lastfmTitle} body="Scrobble what you play to your Last.fm profile, with your own free API account.">
          <PillButton primary onClick={() => setLastfmOpen("create")}>
            Set up
          </PillButton>
        </Row>
      )}

      <AnimatePresence>
        {discordOpen && <DiscordSetup key="discord" onClose={() => setDiscordOpen(false)} />}
        {lastfmOpen && <LastFmSetup key="lastfm" start={lastfmOpen} onClose={() => setLastfmOpen(null)} />}
      </AnimatePresence>
    </Group>
  );
}
