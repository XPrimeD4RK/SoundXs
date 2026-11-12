import { rateLimit } from "../lib/ratelimit.js";
// api/dl.js  (file BARU, tidak menggantikan apa pun)
// Proxy byte-stream untuk unduhan offline: dipakai hanya kalau browser tidak bisa mengambil
// segmen audio langsung dari CDN SoundCloud (CORS). Hanya host SoundCloud yang diizinkan.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const first = v => Array.isArray(v) ? v[0] : v;

function allowed(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    if (/(^|\.)(sndcdn\.com|soundcloud\.cloud)$/i.test(u.hostname)) return u;
    return null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://soundxs.web.id");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (await rateLimit(req, res, { name: "dl", max: 120 })) return;
  if (!["GET", "HEAD"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });

  const target = allowed(first(req.query.url));
  if (!target) return res.status(400).json({ error: "URL tidak diizinkan" });

  try {
    const up = await fetch(target.toString(), {
      method: req.method,
      headers: { "User-Agent": UA, Referer: "https://soundcloud.com/", ...(req.headers.range ? { Range: req.headers.range } : {}) },
    });
    if (!up.ok && up.status !== 206) return res.status(502).json({ error: "CDN menolak permintaan", upstream_status: up.status });

    res.status(up.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("Cache-Control", "private, no-store");
    if (req.method === "HEAD" || !up.body) return res.end();

    const reader = up.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(r => res.once("drain", r));
    }
    return res.end();
  } catch (err) {
    console.error("[dl]", err.message);
    if (res.headersSent) return res.end();
    return res.status(502).json({ error: "Gagal mengambil file dari CDN" });
  }
}
