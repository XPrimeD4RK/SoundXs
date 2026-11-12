import { rateLimit } from "../lib/ratelimit.js";
// api/stream.js
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const first = v => Array.isArray(v) ? v[0] : v;

function allowed(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    if (/(^|\.)(soundcloud\.com|sndcdn\.com|soundcloud\.cloud)$/i.test(u.hostname)) return u;
    return null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://soundxs.web.id");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, If-Range");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (await rateLimit(req, res, { name: "stream", max: 180 })) return;
  if (!["GET", "HEAD"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });

  const raw = first(req.query.url), clientId = first(req.query.client_id);
  const auth = first(req.query.track_authorization);
  if (!raw || !clientId) return res.status(400).json({ error: "Missing url or client_id" });
  const parsed = allowed(raw);
  if (!parsed) return res.status(400).json({ error: "URL tidak diizinkan" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    let target = parsed.toString();

    // Media transcoding endpoints return JSON with the actual signed CDN URL.
    if (/\/media\/soundcloud:/i.test(parsed.pathname)) {
      parsed.searchParams.set("client_id", clientId);
      if (auth) parsed.searchParams.set("track_authorization", auth);
      const r = await fetch(parsed.toString(), {
        signal: controller.signal, redirect: "follow",
        headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://soundcloud.com/", Origin: "https://soundcloud.com" }
      });
      if (!r.ok) return res.status(r.status === 401 || r.status === 403 ? 502 : r.status).json({ error: "Gagal mengambil stream", upstream_status: r.status });
      const type = r.headers.get("content-type") || "";
      if (type.includes("application/json")) {
        const data = await r.json();
        target = data?.url;
      } else {
        // Some SoundCloud endpoints redirect directly to the audio CDN.
        target = r.url;
      }
    } else if (/\/tracks\/\d+\/stream/.test(parsed.pathname)) {
      parsed.searchParams.set("client_id", clientId);
      if (auth) parsed.searchParams.set("track_authorization", auth);
      const r = await fetch(parsed.toString(), {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        signal: controller.signal, redirect: "manual",
        headers: { "User-Agent": UA, Referer: "https://soundcloud.com/", ...(req.headers.range ? { Range: req.headers.range } : {}) }
      });
      const location = r.headers.get("location");
      if (location && allowed(location)) target = location;
      else if (r.ok && (r.headers.get("content-type") || "").startsWith("audio/")) target = r.url;
      else return res.status(r.status || 502).json({ error: "Gagal resolve stream", upstream_status: r.status });
    }

    const safeTarget = allowed(target);
    if (!safeTarget) {
      let host = null;
      try { host = new URL(target).hostname; } catch {}
      return res.status(502).json({ error: "URL stream dari SoundCloud tidak valid", host });
    }
    res.setHeader("Cache-Control", "private, max-age=120");
    return res.redirect(302, safeTarget.toString());
  } catch (err) {
    console.error("[stream]", err.message);
    return res.status(err.name === "AbortError" ? 504 : 502).json({
      error: err.name === "AbortError" ? "Timeout saat mengambil stream" : "Stream gagal diambil"
    });
  } finally {
    clearTimeout(timer);
  }
}
