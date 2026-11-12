import { rateLimit } from "../lib/ratelimit.js";
// api/lyrics.js
//   GET /api/lyrics?title=&artist=&duration=<detik>[&q=<pencarian manual>]
//
// Sumber: LRCLIB (gratis, tanpa API key, ada lirik tersinkron per baris),
// cadangan: lyrics.ovh (teks biasa). Judul SoundCloud biasanya berantakan
// ("Artis - Judul (Official Video) ft. X"), jadi dibersihkan dan dicoba
// dengan beberapa kombinasi artis/judul sebelum menyerah.

const UA = "SoundXs/2.0 (https://soundxs.web.id)";
const TIMEOUT = 6000;

const NOISE = /\b(official|video|audio|lyrics?|lirik|mv|m\/v|hd|hq|4k|visuali[sz]er|remaster(ed)?|clip|music video|full version|explicit|prod\.?|karaoke|cover|sub(title)?s?|terjemahan|subtitle indonesia|with lyrics)\b/i;

const first = (v) => (Array.isArray(v) ? v[0] : v);

function decodeText(value) {
  const text = String(value || "");
  if (!/%(?:[0-9a-f]{2})/i.test(text)) return text;
  try { return decodeURIComponent(text.replace(/\+/g, "%20")); }
  catch { return text.replace(/%[0-9a-f]{0,1}(?![0-9a-f])/ig, "%"); }
}

export function cleanTitle(raw) {
  let s = String(raw || "");
  // buang isi kurung yang berisi kata "sampah"
  s = s.replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, (m) => (NOISE.test(m) || /\b(feat|ft)\b/i.test(m) ? " " : m));
  s = s.split(/\s[|｜•]\s/)[0];                     // "Judul | Channel"
  s = s.replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, ""); // "Judul ft. X"
  s = s.replace(NOISE, " ");
  s = s.replace(/["“”]/g, "").replace(/\s{2,}/g, " ").trim();
  s = s.replace(/[\s\-–—_:]+$/g, "").replace(/^[\s\-–—_:]+/g, "");
  return s;
}

export function cleanArtist(raw) {
  return String(raw || "")
    .replace(/\s*-\s*topic$/i, "")
    .replace(/\b(official|vevo|music|records?|channel|entertainment|label)\b/gi, " ")
    .replace(/[_|]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Kumpulkan kandidat {artist, title} dari judul + nama uploader
export function buildCandidates(title, uploader) {
  const out = [];
  const seen = new Set();
  const add = (artist, t) => {
    t = (t || "").trim();
    artist = (artist || "").trim();
    if (!t) return;
    const k = (artist + "|" + t).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ artist, title: t });
  };

  const cleaned = cleanTitle(title);
  const up = cleanArtist(uploader);
  const parts = cleaned.split(/\s+[-–—]\s+/);

  if (parts.length >= 2) {
    const a = parts[0].trim();
    const t = parts.slice(1).join(" - ").trim();
    add(a, cleanTitle(t));
    add(cleanTitle(t), a);          // kadang formatnya terbalik: "Judul - Artis"
    add("", cleanTitle(t));
  }
  add(up, cleaned);
  add("", cleaned);
  return out;
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function overlap(a, b) {
  const A = new Set(norm(a).split(" ").filter(Boolean));
  const B = new Set(norm(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

function score(item, cand, duration, relaxed) {
  if (!item || item.instrumental) return -1;
  if (!item.syncedLyrics && !item.plainLyrics) return -1;
  const tSim = cand ? overlap(cand.title, item.trackName) : 1;
  if (!relaxed && tSim < 0.6) return -1;
  let sc = tSim * 3;
  if (cand && cand.artist) {
    const aSim = Math.max(overlap(cand.artist, item.artistName), overlap(cand.artist, item.trackName));
    sc += aSim * 2;
  }
  if (item.syncedLyrics) sc += 2;
  if (duration && item.duration) {
    const d = Math.abs(item.duration - duration);
    sc += d <= 3 ? 3 : d <= 8 ? 1.5 : d <= 20 ? 0 : -2;
  }
  return sc;
}

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const LRCLIB = "https://lrclib.net/api";

export function parseLrc(lrc) {
  const entries = [];
  for (const raw of String(lrc || "").split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) {
      const frac = m[3] ? Number("0." + m[3]) : 0;
      entries.push({ t: Number(m[1]) * 60 + Number(m[2]) + frac, text: decodeText(text) });
    }
  }
  entries.sort((x, y) => x.t - y.t);

  // Baris LRC tanpa teks = penanda penyanyi berhenti (awal jeda/instrumental).
  // Disimpan sebagai `end` pada baris sebelumnya supaya jeda bisa dideteksi akurat.
  const lines = [];
  for (const e of entries) {
    if (e.text) lines.push({ t: e.t, text: e.text });
    else if (lines.length) {
      const prev = lines[lines.length - 1];
      if (prev.end == null && e.t > prev.t) prev.end = e.t;
    }
  }
  return lines;
}

function toResult(item, source) {
  if (item.syncedLyrics) {
    const lines = parseLrc(item.syncedLyrics);
    if (lines.length >= 3) {
      return { success: true, synced: true, source, title: item.trackName, artist: item.artistName, lines };
    }
  }
  if (item.plainLyrics) {
    const lines = String(item.plainLyrics).split(/\r?\n/).map(s => decodeText(s.trim())).filter(Boolean).map(text => ({ text }));
    if (lines.length) return { success: true, synced: false, source, title: item.trackName, artist: item.artistName, lines };
  }
  return null;
}

async function viaLrclib(cands, duration) {
  // 1) cocokkan persis (paling akurat) untuk tiap kandidat berartis
  for (const c of cands) {
    if (!c.artist) continue;
    const qs = new URLSearchParams({ artist_name: c.artist, track_name: c.title });
    if (duration) qs.set("duration", String(duration));
    const hit = await getJson(`${LRCLIB}/get?${qs}`);
    if (hit && score(hit, c, duration, false) >= 0) {
      const r = toResult(hit, "lrclib");
      if (r) return r;
    }
  }

  // 2) pencarian: kumpulkan hasil dari semua kandidat, ambil skor terbaik
  let best = null, bestScore = -1;
  for (const c of cands) {
    const qs = new URLSearchParams({ track_name: c.title });
    if (c.artist) qs.set("artist_name", c.artist);
    const list = await getJson(`${LRCLIB}/search?${qs}`);
    if (!Array.isArray(list)) continue;
    for (const it of list.slice(0, 15)) {
      const sc = score(it, c, duration, false);
      if (sc > bestScore) { best = it; bestScore = sc; }
    }
    if (bestScore >= 7) break; // sudah sangat cocok, tak perlu cari lagi
  }
  if (best) {
    const r = toResult(best, "lrclib");
    if (r) return r;
  }

  // 3) pencarian bebas "artis judul" (menangani judul yang tidak bisa dipisah)
  const free = [cands[0] && `${cands[0].artist} ${cands[0].title}`.trim(), cands[cands.length - 1]?.title]
    .filter(Boolean);
  for (const q of free) {
    const list = await getJson(`${LRCLIB}/search?q=${encodeURIComponent(q)}`);
    if (!Array.isArray(list)) continue;
    let b = null, bs = -1;
    for (const it of list.slice(0, 15)) {
      const sc = score(it, { artist: "", title: q }, duration, true) + overlap(q, `${it.artistName} ${it.trackName}`) * 3;
      if (sc > bs) { b = it; bs = sc; }
    }
    if (b && overlap(q, `${b.artistName} ${b.trackName}`) >= 0.5) {
      const r = toResult(b, "lrclib");
      if (r) return r;
    }
  }
  return null;
}

async function viaOvh(cands) {
  for (const c of cands) {
    if (!c.artist) continue;
    const d = await getJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(c.artist)}/${encodeURIComponent(c.title)}`);
    if (d && typeof d.lyrics === "string" && d.lyrics.trim()) {
      const lines = d.lyrics.split(/\r?\n/).map(s => decodeText(s.trim())).filter(Boolean).map(text => ({ text }));
      if (lines.length >= 3) return { success: true, synced: false, source: "lyrics.ovh", title: c.title, artist: c.artist, lines };
    }
  }
  return null;
}

// Pencarian manual dari pengguna: "artis judul" bebas
async function viaManual(q, duration) {
  const list = await getJson(`${LRCLIB}/search?q=${encodeURIComponent(q)}`);
  if (!Array.isArray(list)) return null;
  let best = null, bs = -1;
  for (const it of list.slice(0, 20)) {
    const sc = score(it, null, duration, true);
    if (sc > bs) { best = it; bs = sc; }
  }
  return best ? toResult(best, "lrclib") : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://soundxs.web.id");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (await rateLimit(req, res, { name: "lyrics", max: 90 })) return;
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });

  const title = String(first(req.query.title) || "").slice(0, 200);
  const artist = String(first(req.query.artist) || "").slice(0, 100);
  const manual = String(first(req.query.q) || "").slice(0, 150).trim();
  const duration = Math.round(Number(first(req.query.duration)) || 0);

  if (!title && !manual) return res.status(400).json({ success: false, error: "title wajib diisi" });

  try {
    let result = null;
    if (manual) {
      result = await viaManual(manual, 0);
    } else {
      const cands = buildCandidates(title, artist);
      result = (await viaLrclib(cands, duration)) || (await viaOvh(cands));
    }

    if (!result) {
      res.setHeader("Cache-Control", "public, s-maxage=300");
      return res.status(200).json({ success: false, error: "Lirik tidak ditemukan" });
    }
    res.setHeader("Cache-Control", manual ? "no-store" : "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json(result);
  } catch (err) {
    console.error("[lyrics]", err);
    return res.status(500).json({ success: false, error: "Terjadi kesalahan di server" });
  }
}
