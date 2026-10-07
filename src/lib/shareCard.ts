import { api, type Album, type Palette, type Track, type YearStats } from "./api";

const W = 1080;
const H = 1350;
const FONT = "'Geist Variable', 'Segoe UI', sans-serif";
const MONO = "'Geist Mono Variable', ui-monospace, monospace";

async function coverImage(album: Album | undefined): Promise<ImageBitmap | null> {
  if (!album?.cover) return null;
  try {
    const bytes = await api.coverBytes(album.id);
    return await createImageBitmap(new Blob([bytes]));
  } catch {
    return null;
  }
}

/** Shortens text to fit `max` px, adding an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Renders the shareable "year in music" card as PNG bytes. */
export async function renderShareCard(
  stats: YearStats,
  palette: Palette,
  trackById: Map<number, Track>,
  albumById: Map<number, Album>,
): Promise<Uint8Array> {
  await Promise.all([document.fonts.load(`600 64px ${FONT}`), document.fonts.load(`500 28px ${MONO}`)]).catch(() => {});
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // Background: the top album's colors, as soft light pools on its darkest tone.
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, W, H);
  const sw = palette.swatches?.length ? palette.swatches : [palette.surface, palette.accent];
  const pools: [number, number, number, string, number][] = [
    [W * 0.15, H * 0.12, 700, sw[0], 0.75],
    [W * 0.95, H * 0.35, 650, sw[1] ?? sw[0], 0.55],
    [W * 0.3, H * 0.95, 750, palette.accent, 0.22],
  ];
  for (const [x, y, r, c, a] of pools) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    ctx.globalAlpha = a;
    g.addColorStop(0, c);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalAlpha = 1;
  const shade = ctx.createLinearGradient(0, 0, 0, H);
  shade.addColorStop(0, "rgba(0,0,0,0.05)");
  shade.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);

  const ink = "#f2f1ee";
  const muted = "rgba(242,241,238,0.66)";
  const pad = 84;

  ctx.fillStyle = muted;
  ctx.font = `500 26px ${MONO}`;
  ctx.fillText("MY YEAR IN MUSIC", pad, 128);
  ctx.fillStyle = ink;
  ctx.font = `650 196px ${FONT}`;
  ctx.fillText(String(stats.year), pad - 8, 300);

  // Headline numbers.
  const nums: [string, string][] = [
    [Math.round(stats.minutes).toLocaleString(), "minutes"],
    [stats.songs.toLocaleString(), stats.songs === 1 ? "song" : "songs"],
    [stats.artists.toLocaleString(), stats.artists === 1 ? "artist" : "artists"],
  ];
  nums.forEach(([n, label], i) => {
    const x = pad + i * 310;
    ctx.fillStyle = ink;
    ctx.font = `600 64px ${FONT}`;
    ctx.fillText(n, x, 410);
    ctx.fillStyle = muted;
    ctx.font = `500 28px ${FONT}`;
    ctx.fillText(label, x, 452);
  });

  // Top songs with covers.
  ctx.fillStyle = muted;
  ctx.font = `500 26px ${MONO}`;
  ctx.fillText("TOP SONGS", pad, 540);
  const top = stats.topTracks.slice(0, 5).map(([id, plays]) => ({ t: trackById.get(id), plays })).filter((x) => x.t);
  const covers = await Promise.all(top.map((x) => coverImage(albumById.get(x.t!.albumId))));
  top.forEach(({ t, plays }, i) => {
    const y = 576 + i * 112;
    ctx.fillStyle = muted;
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText(String(i + 1), pad, y + 60);
    const cx = pad + 64;
    ctx.save();
    roundRect(ctx, cx, y, 92, 92, 14);
    ctx.clip();
    if (covers[i]) ctx.drawImage(covers[i]!, cx, y, 92, 92);
    else {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(cx, y, 92, 92);
    }
    ctx.restore();
    const tx = cx + 120;
    const maxW = W - pad - tx - 140;
    ctx.fillStyle = ink;
    ctx.font = `600 38px ${FONT}`;
    ctx.fillText(fit(ctx, t!.title, maxW), tx, y + 40);
    ctx.fillStyle = muted;
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText(fit(ctx, t!.artist, maxW), tx, y + 80);
    ctx.font = `500 26px ${MONO}`;
    const p = `${plays} ${plays === 1 ? "play" : "plays"}`;
    ctx.fillText(p, W - pad - ctx.measureText(p).width, y + 58);
  });

  // Top artist and genre.
  const footY = 1252;
  const facts: [string, string][] = [];
  if (stats.topArtists[0]) facts.push(["TOP ARTIST", stats.topArtists[0][0]]);
  if (stats.topGenres[0]) facts.push(["TOP GENRE", stats.topGenres[0][0]]);
  facts.forEach(([label, value], i) => {
    const x = pad + i * 470;
    ctx.fillStyle = muted;
    ctx.font = `500 24px ${MONO}`;
    ctx.fillText(label, x, footY - 70);
    ctx.fillStyle = ink;
    ctx.font = `600 44px ${FONT}`;
    ctx.fillText(fit(ctx, value, 430), x, footY - 18);
  });

  ctx.fillStyle = muted;
  ctx.font = `500 24px ${MONO}`;
  const credit = "Reson  ·  github.com/osfv/Reson";
  ctx.fillText(credit, W - pad - ctx.measureText(credit).width, H - 44);

  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't draw the image"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
