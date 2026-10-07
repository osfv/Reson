import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { DownloadSimple, Play, Sparkle } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { PillButton } from "../components/Buttons";
import { Cover } from "../components/Cover";
import { MeshBackdrop } from "../components/np/MeshBackdrop";
import { CountUp, formatDay, monthName, MonthChart, useYearData } from "../components/year/shared";
import { YearStory } from "../components/YearStory";
import { api, type YearStats } from "../lib/api";
import { playTracks } from "../lib/actions";
import { cn } from "../lib/cn";
import { plural } from "../lib/format";
import { renderShareCard } from "../lib/shareCard";
import { paletteOf } from "../lib/theme";
import { useUi } from "../store/ui";

function Stat({ value, label, delay = 0 }: { value: number; label: string; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl bg-white/[0.05] p-5"
    >
      <CountUp value={value} className="block text-4xl font-semibold tracking-tight tabular-nums" />
      <span className="mt-1 block text-sm text-ink-muted">{label}</span>
    </motion.div>
  );
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("mt-12", className)}>
      <h2 className="mb-4 text-xl font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

export function YearView({ year }: { year: number }) {
  const [stats, setStats] = useState<YearStats | null>(null);
  const [story, setStory] = useState(false);
  const [saving, setSaving] = useState(false);
  const navigate = useUi((s) => s.navigate);
  const toast = useUi((s) => s.toast);
  const data = useYearData(stats);

  useEffect(() => {
    let alive = true;
    setStats(null);
    api
      .yearStats(year)
      .then((s) => alive && setStats(s))
      .catch((e) => toast(String(e)));
    return () => {
      alive = false;
    };
  }, [year, toast]);

  const heroAlbum = data?.topAlbums[0]?.album;
  const palette = paletteOf(heroAlbum);
  const scope = { "--accent": palette.accent, "--on-accent": palette.onAccent } as CSSProperties;

  const save = async () => {
    if (!stats || !data) return;
    setSaving(true);
    try {
      const png = await renderShareCard(stats, palette, data.trackById, data.albumById);
      if (await api.saveImage(png, `Reson-${year}-in-music.png`)) toast("Saved your year as an image");
    } catch (e) {
      toast(String(e));
    } finally {
      setSaving(false);
    }
  };

  const title = <h1 className="text-4xl font-semibold tracking-tight">Statistics</h1>;
  if (!stats || !data) {
    return (
      <div className="px-8 pt-2">
        {title}
        <p className="mt-6 text-sm text-ink-muted">Adding up your plays…</p>
      </div>
    );
  }
  const empty = stats.plays === 0;

  return (
    <div className="px-8 pb-16 pt-2" style={scope}>
      {title}
      <div className="relative mt-6 overflow-hidden rounded-3xl px-8 pb-10 pt-10 md:px-12">
        <MeshBackdrop palette={palette} playing reactive={false} />
        <div className="relative">
          <motion.p
            initial={{ opacity: 0, y: 20, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="text-8xl font-semibold leading-none tracking-[-0.04em] md:text-9xl"
          >
            {year}
          </motion.p>
          {stats.years.length > 1 && (
            <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="Year">
              {stats.years.map((y) => (
                <button
                  key={y}
                  type="button"
                  role="tab"
                  aria-selected={y === year}
                  onClick={() => navigate({ name: "year", year: y })}
                  className={cn(
                    "h-8 rounded-full px-4 font-mono text-xs transition-colors",
                    y === year ? "bg-ink text-[#141416]" : "bg-black/25 text-ink hover:bg-white/10",
                  )}
                >
                  {y}
                </button>
              ))}
            </div>
          )}
          {empty ? (
            <p className="mt-6 max-w-[48ch] text-ink-muted">
              Nothing played in {year} yet. Songs count once you've heard half of them (or 30 seconds), and your year builds
              up from there.
            </p>
          ) : (
            <div className="mt-8 flex flex-wrap gap-3">
              <PillButton primary onClick={() => setStory(true)}>
                <Sparkle size={16} weight="fill" />
                Watch your recap
              </PillButton>
              <PillButton onClick={() => playTracks(data.topTracks.map((t) => t.track.id))} className="bg-black/25 hover:bg-white/10">
                <Play size={16} weight="fill" />
                Play your top songs
              </PillButton>
              <PillButton onClick={save} disabled={saving} className="bg-black/25 hover:bg-white/10 disabled:opacity-60">
                <DownloadSimple size={16} weight="bold" />
                {saving ? "Drawing" : "Save as image"}
              </PillButton>
            </div>
          )}
        </div>
      </div>

      {!empty && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat value={Math.round(stats.minutes)} label="minutes listened" />
            <Stat value={stats.songs} label={stats.songs === 1 ? "song" : "different songs"} delay={0.05} />
            <Stat value={stats.artists} label={stats.artists === 1 ? "artist" : "artists"} delay={0.1} />
            <Stat value={stats.longestStreak} label={stats.longestStreak === 1 ? "day streak" : "days in a row, your best streak"} delay={0.15} />
          </div>

          <div className="grid gap-x-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <Section title="Top songs">
              <ol className="flex flex-col">
                {data.topTracks.slice(0, 10).map(({ track, plays }, i) => (
                  <li key={track.id}>
                    <button
                      type="button"
                      onClick={() => playTracks(data.topTracks.map((t) => t.track.id), i)}
                      className="group -mx-2 flex w-full items-center gap-4 rounded-lg p-2 text-left transition-colors hover:bg-white/[0.05]"
                    >
                      <span className={cn("w-7 text-right text-2xl font-semibold tabular-nums", i === 0 ? "text-accent" : "text-ink-faint")}>
                        {i + 1}
                      </span>
                      <Cover album={data.albumById.get(track.albumId)} className="h-12 w-12 rounded-md" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{track.title}</span>
                        <span className="block truncate text-sm text-ink-muted">{track.artist}</span>
                      </span>
                      <span className="font-mono text-xs text-ink-faint tabular-nums">{plural(plays, "play")}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </Section>

            <Section title="Top artists">
              <ol className="flex flex-col gap-1">
                {stats.topArtists.map(([name, , minutes], i) => (
                  <li key={name}>
                    <button
                      type="button"
                      onClick={() => navigate({ name: "artist", artist: name })}
                      className="-mx-2 flex w-full items-center gap-4 rounded-lg p-2 text-left transition-colors hover:bg-white/[0.05]"
                    >
                      <span className={cn("w-7 text-right text-2xl font-semibold tabular-nums", i === 0 ? "text-accent" : "text-ink-faint")}>
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-lg font-medium">{name}</span>
                      <span className="font-mono text-xs text-ink-faint tabular-nums">{Math.round(minutes).toLocaleString()} min</span>
                    </button>
                  </li>
                ))}
              </ol>
            </Section>
          </div>

          <Section title="Top albums">
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 xl:grid-cols-6">
              {data.topAlbums.map(({ album, minutes }, i) => (
                <motion.button
                  key={album.id}
                  type="button"
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.05, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  onClick={() => navigate({ name: "album", id: album.id })}
                  className="group min-w-0 text-left"
                >
                  <Cover album={album} className="aspect-square w-full shadow-[0_18px_40px_-18px_rgb(0_0_0/0.7)] transition-transform duration-300 ease-out-expo group-hover:-translate-y-1" />
                  <span className="mt-3 block truncate text-sm font-medium">{album.title}</span>
                  <span className="block truncate text-xs text-ink-muted">{Math.round(minutes).toLocaleString()} minutes</span>
                </motion.button>
              ))}
            </div>
          </Section>

          <Section title={`Your biggest month was ${monthName(data.topMonth)}`}>
            <div className="rounded-2xl bg-white/[0.04] p-6">
              <MonthChart months={stats.months} highlight={data.topMonth} />
            </div>
          </Section>

          <Section title="Also">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {data.first && stats.firstTrack && (
                <Fact label={`First song, ${formatDay(stats.firstTrack[1])}`} value={data.first.title} sub={data.first.artist} />
              )}
              {stats.topDay && (
                <Fact label="Your biggest day" value={formatDay(stats.topDay[0])} sub={`${Math.round(stats.topDay[1]).toLocaleString()} minutes`} />
              )}
              {stats.topGenres[0] && <Fact label="Top genre" value={stats.topGenres[0][0]} sub={plural(stats.topGenres[0][1], "play")} />}
              <Fact label="New this year" value={plural(stats.newSongs, "song")} sub={`${plural(stats.liked, "like")}`} />
            </div>
          </Section>
        </>
      )}

      <AnimatePresence>
        {story && <YearStory key="story" stats={stats} onClose={() => setStory(false)} onSave={save} />}
      </AnimatePresence>
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl bg-white/[0.04] p-5">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1.5 truncate text-lg font-semibold tracking-tight">{value}</p>
      {sub && <p className="truncate text-sm text-ink-muted">{sub}</p>}
    </div>
  );
}
