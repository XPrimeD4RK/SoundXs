import { rateLimit } from "../lib/ratelimit.js";

const TIMEOUT_MS = 12000;
const MAX_TRACKS = 100;
const MAX_BODY = 4 * 1024 * 1024;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const json = (res, status, body) => res.status(status).json(body);

class ImportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* Link -> { provider, id }. Client tidak pernah mengirim provider atau URL upstream.
   Server hanya fetch host yang ada di sini, id divalidasi regex, jadi tidak bisa diarahkan ke URL sembarang. */
export function parsePlaylistUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  if (host === "open.spotify.com") {
    const m = path.match(/^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{22})\/?$/);
    return m ? { provider: "spotify", id: m[1] } : null;
  }
  if (host === "deezer.com" || host === "www.deezer.com") {
    const m = path.match(/^\/(?:[a-z]{2}\/)?playlist\/(\d{1,20})\/?$/);
    return m ? { provider: "deezer", id: m[1] } : null;
  }
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    const list = u.searchParams.get("list") || "";
    if (path !== "/playlist" || !/^[A-Za-z0-9_-]{8,80}$/.test(list)) return null;
    return { provider: "youtube", id: list };
  }
  if (host === "music.apple.com") {
    const m = path.match(/^\/(?:[a-z]{2}\/)?playlist\/[^/]+\/(pl\.[A-Za-z0-9-]{4,80})\/?$/)
      || path.match(/^\/(?:[a-z]{2}\/)?playlist\/(pl\.[A-Za-z0-9-]{4,80})\/?$/);
    return m ? { provider: "apple", id: m[1] } : null;
  }
  return null;
}

const trustedNext = (next, host) => {
  try { const u = new URL(next); return u.protocol === "https:" && u.hostname === host ? u.href : null; } catch { return null; }
};

async function fetchText(url, signal, headers = {}) {
  const r = await fetch(url, {
    signal,
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...headers },
  });
  if (!r.ok) throw new ImportError(r.status === 404 ? 404 : 502, "Sumber playlist mengembalikan status " + r.status);
  const text = await r.text();
  if (text.length > MAX_BODY) throw new ImportError(502, "Respons sumber terlalu besar");
  return text;
}

const decodeEntities = s => String(s || "")
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/* Spotify Web API (butuh client credentials). Kalau gagal, handler jatuh ke embed. */
async function spotifyApi(id, signal) {
  const cid = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!cid || !secret) return null;
  const tr = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", signal,
    headers: {
      Authorization: "Basic " + Buffer.from(`${cid}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!tr.ok) return null;
  const { access_token: token } = await tr.json();
  if (!token) return null;
  const auth = { Authorization: `Bearer ${token}` };

  let next = `https://api.spotify.com/v1/playlists/${id}?fields=name,tracks.items(track(name,artists(name),is_local)),tracks.next`;
  let name = "Spotify Playlist";
  const tracks = [];
  while (next && tracks.length < MAX_TRACKS) {
    const r = await fetch(next, { signal, headers: auth });
    if (!r.ok) return null;
    const d = await r.json();
    if (d.name) name = d.name;
    const block = d.tracks || d;
    for (const item of block.items || []) {
      const t = item.track;
      if (t?.name && !t.is_local) tracks.push({ title: t.name, artist: (t.artists || []).map(a => a.name).join(", ") });
    }
    next = trustedNext(block.next, "api.spotify.com");
  }
  return { name, tracks: tracks.slice(0, MAX_TRACKS) };
}

/* Fallback tanpa kredensial: halaman embed Spotify menyimpan daftar lagu di __NEXT_DATA__. */
async function spotifyEmbed(id, signal) {
  const html = await fetchText(`https://open.spotify.com/embed/playlist/${id}`, signal);
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new ImportError(404, "Playlist Spotify tidak bisa dibaca. Pastikan playlist publik.");
  const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  const tracks = (entity?.trackList || [])
    .filter(t => t?.title)
    .slice(0, MAX_TRACKS)
    .map(t => ({ title: String(t.title), artist: String(t.subtitle || "") }));
  return { name: entity?.title || entity?.name || "Spotify Playlist", tracks };
}

async function deezer(id, signal) {
  const r = await fetch(`https://api.deezer.com/playlist/${id}`, { signal, headers: { Accept: "application/json" } });
  const d = r.ok ? await r.json() : null;
  if (!d || d.error || !Array.isArray(d.tracks?.data)) throw new ImportError(404, "Playlist Deezer tidak tersedia atau privat");
  const tracks = [];
  let block = d.tracks;
  while (block && tracks.length < MAX_TRACKS) {
    for (const t of block.data || []) if (t.title) tracks.push({ title: t.title, artist: t.artist?.name || "" });
    const next = trustedNext(block.next, "api.deezer.com");
    if (!next) break;
    block = await (await fetch(next, { signal, headers: { Accept: "application/json" } })).json();
  }
  return { name: d.title || "Deezer Playlist", tracks: tracks.slice(0, MAX_TRACKS) };
}

function findVideoRenderers(node, out, depth = 0) {
  if (!node || typeof node !== "object" || depth > 40 || out.length >= MAX_TRACKS) return out;
  if (Array.isArray(node)) { for (const x of node) findVideoRenderers(x, out, depth + 1); return out; }
  if (node.playlistVideoRenderer) out.push(node.playlistVideoRenderer);
  for (const k of Object.keys(node)) findVideoRenderers(node[k], out, depth + 1);
  return out;
}
const runsText = o => o?.simpleText || (o?.runs || []).map(r => r.text).join("") || "";

/* YouTube / YouTube Music: halaman playlist publik menyimpan ytInitialData. Ambil halaman pertama. */
async function youtube(id, signal) {
  const html = await fetchText(`https://www.youtube.com/playlist?list=${encodeURIComponent(id)}&hl=en`, signal);
  const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!m) throw new ImportError(404, "Playlist YouTube tidak bisa dibaca. Pastikan playlist publik.");
  const data = JSON.parse(m[1]);
  const name = data?.metadata?.playlistMetadataRenderer?.title
    || data?.header?.playlistHeaderRenderer?.title?.simpleText || "YouTube Playlist";
  const tracks = findVideoRenderers(data, [])
    .map(r => ({ title: runsText(r.title), artist: runsText(r.shortBylineText) }))
    .filter(t => t.title && !/^\[(Deleted|Private) video\]$/i.test(t.title))
    .slice(0, MAX_TRACKS);
  return { name: String(name), tracks };
}

/* Apple Music: JSON-LD MusicPlaylist dulu, lalu serialized-server-data sebagai cadangan. */
function collectSongs(node, out, seen, depth = 0) {
  if (!node || typeof node !== "object" || depth > 30 || out.length >= MAX_TRACKS) return;
  if (Array.isArray(node)) { for (const x of node) collectSongs(x, out, seen, depth + 1); return; }
  if (typeof node.title === "string" && typeof node.artistName === "string" && node.title) {
    const key = node.title + "\u0000" + node.artistName;
    if (!seen.has(key)) { seen.add(key); out.push({ title: node.title, artist: node.artistName }); }
  }
  for (const k of Object.keys(node)) collectSongs(node[k], out, seen, depth + 1);
}
async function apple(id, signal) {
  const html = await fetchText(`https://music.apple.com/us/playlist/_/${id}`, signal);
  const og = html.match(/<meta property="og:title" content="([^"]*)"/);
  const name = decodeEntities(og?.[1]) || "Apple Music Playlist";
  const tracks = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let obj; try { obj = JSON.parse(m[1]); } catch { continue; }
    for (const it of Array.isArray(obj) ? obj : [obj]) {
      for (const t of it?.track || []) {
        const by = Array.isArray(t.byArtist) ? t.byArtist[0] : t.byArtist;
        if (t.name) tracks.push({ title: String(t.name), artist: String(by?.name || "") });
      }
    }
  }
  if (!tracks.length) {
    const sm = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
    if (sm) { try { collectSongs(JSON.parse(sm[1]), tracks, new Set()); } catch {} }
  }
  return { name: decodeEntities(name), tracks: tracks.slice(0, MAX_TRACKS) };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://soundxs.web.id");
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return json(res, 405, { success: false, error: "Method not allowed" });
  if (await rateLimit(req, res, { name: "playlist-import", max: 20 })) return;

  const target = parsePlaylistUrl(req.query.url);
  if (!target) {
    return json(res, 400, { success: false, error: "Link playlist tidak didukung. Gunakan link publik dari Spotify, Deezer, YouTube Music, atau Apple Music." });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let result = null;
    if (target.provider === "spotify") {
      result = await spotifyApi(target.id, controller.signal).catch(() => null);
      if (!result?.tracks?.length) result = await spotifyEmbed(target.id, controller.signal);
    } else if (target.provider === "deezer") {
      result = await deezer(target.id, controller.signal);
    } else if (target.provider === "youtube") {
      result = await youtube(target.id, controller.signal);
    } else if (target.provider === "apple") {
      result = await apple(target.id, controller.signal);
    }
    if (!result?.tracks?.length) {
      return json(res, 404, { success: false, error: "Playlist kosong atau tidak bisa dibaca. Pastikan playlist bersifat publik." });
    }
    return json(res, 200, { success: true, name: result.name, tracks: result.tracks });
  } catch (e) {
    if (e instanceof ImportError) return json(res, e.status, { success: false, error: e.message });
    return json(res, e.name === "AbortError" ? 504 : 502, { success: false, error: "Gagal mengambil playlist. Coba lagi nanti." });
  } finally {
    clearTimeout(timer);
  }
}
