// lib/ratelimit.js
// Rate limit per-IP untuk endpoint publik. Helper backend-only (bukan endpoint).
//   - Jika Upstash tersedia (KV_REST_API_URL + KV_REST_API_TOKEN): hitungan dibagi antar-instance.
//   - Jika tidak, atau Upstash error/lambat: pakai memori lokal. Tidak pernah membuat request gagal
//     karena limiter itu sendiri bermasalah (fail-open).
// Pemakaian: if (await rateLimit(req, res, { name: "search", max: 120 })) return;

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const mem = new Map();

function clientIp(req) {
  const h = req.headers || {};
  const v = h["x-real-ip"] || h["x-vercel-forwarded-for"] || h["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  return String(Array.isArray(v) ? v[0] : v).split(",")[0].trim().slice(0, 64) || "unknown";
}

function memCount(key, windowMs) {
  const now = Date.now();
  if (mem.size > 5000) for (const [k, e] of mem) if (now - e.start > e.win) mem.delete(k);
  const e = mem.get(key);
  if (!e || now - e.start > windowMs) { mem.set(key, { start: now, win: windowMs, count: 1 }); return 1; }
  return ++e.count;
}

async function kvCount(key, windowSec) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1200);
  try {
    const r = await fetch(KV_URL.replace(/\/$/, "") + "/pipeline", {
      method: "POST",
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(windowSec), "NX"]]),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const n = Number(data?.[0]?.result);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Return true bila request diblokir (respons 429 sudah dikirim).
export async function rateLimit(req, res, { name, max, windowSec = 60 }) {
  try {
    const bucket = Math.floor(Date.now() / (windowSec * 1000));
    const key = `soundpulse:rl:${name}:${clientIp(req)}:${bucket}`;
    let count = null;
    if (KV_URL && KV_TOKEN) count = await kvCount(key, windowSec + 5);
    if (count === null) count = memCount(key, windowSec * 1000);
    if (count > max) {
      res.setHeader("Retry-After", String(windowSec));
      res.setHeader("Cache-Control", "no-store");
      res.status(429).json({ success: false, error: "Terlalu banyak request, coba lagi sebentar" });
      return true;
    }
  } catch {
    // limiter tidak boleh merusak endpoint
  }
  return false;
}
