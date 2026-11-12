import { rateLimit } from "../lib/ratelimit.js";
// api/get-credentials.js
// Ambil client_id SoundCloud: env var dulu, lalu scrape bundle JS SoundCloud.
// Catatan: bundle JS SoundCloud di-host di *.sndcdn.com (bukan soundcloud.com),
// dan client_id biasanya ada di bundle TERAKHIR.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const CLIENT_ID_RE = /client_id["']?\s*[:=]\s*["'`]([A-Za-z0-9]{30,40})["'`]/i;
const SCRIPT_HOST_RE = /^https:\/\/([a-z0-9-]+\.)*(soundcloud\.com|sndcdn\.com)\//i;
const CACHE_MS = 60 * 60 * 1000;

// cache di memori (bertahan selama instance serverless masih hangat)
let cached = { id: null, at: 0 };

async function fetchText(url, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "text/html,application/javascript,*/*" }
    });
    if (!r.ok) return "";
    return await r.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function absolutize(src) {
  if (src.startsWith("//")) return "https:" + src;
  if (src.startsWith("/")) return "https://soundcloud.com" + src;
  return src;
}

async function scrapeClientId() {
  const html = await fetchText("https://soundcloud.com/");
  if (!html) return null;

  const direct = html.match(CLIENT_ID_RE);
  if (direct?.[1]) return direct[1];

  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']/gi)]
    .map(m => absolutize(m[1]))
    .filter(u => SCRIPT_HOST_RE.test(u));

  // client_id biasanya di bundle paling belakang -> cek dari belakang, paralel
  const candidates = scripts.reverse().slice(0, 8);
  const results = await Promise.all(candidates.map(async (u) => {
    const src = await fetchText(u, 6000);
    return src.match(CLIENT_ID_RE)?.[1] || null;
  }));
  return results.find(Boolean) || null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://soundxs.web.id");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (await rateLimit(req, res, { name: "cred", max: 60 })) return;
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });

  const configured = process.env.SOUNDCLOUD_CLIENT_ID || process.env.SC_CLIENT_ID;
  if (configured && /^[A-Za-z0-9]{30,40}$/.test(configured)) {
    res.setHeader("Cache-Control", "public, s-maxage=3600");
    return res.status(200).json({ success: true, client_id: configured, source: "env" });
  }

  if (cached.id && Date.now() - cached.at < CACHE_MS) {
    res.setHeader("Cache-Control", "public, s-maxage=600");
    return res.status(200).json({ success: true, client_id: cached.id, source: "cache" });
  }

  try {
    const id = await scrapeClientId();
    if (id) {
      cached = { id, at: Date.now() };
      res.setHeader("Cache-Control", "public, s-maxage=600");
      return res.status(200).json({ success: true, client_id: id, source: "scrape" });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({
      success: false,
      error: "Client ID SoundCloud belum tersedia. Atur SOUNDCLOUD_CLIENT_ID di environment Vercel."
    });
  } catch (err) {
    console.error("[get-credentials]", err.message);
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ success: false, error: "Gagal mengambil kredensial SoundCloud" });
  }
}
