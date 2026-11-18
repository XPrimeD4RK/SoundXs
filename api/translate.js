import { rateLimit } from "../lib/ratelimit.js";
// api/translate.js
//   POST /api/translate   body: { "lines": ["...", ...], "to": "id" }
//   -> { success: true, lines: ["...", ...] }   (urutan & jumlah sama dengan input)
//
// Sumber: endpoint terjemahan publik (tanpa API key), bahasa asal dideteksi otomatis.
// Baris dikirim sebagai satu blok dipisah \n supaya banyak baris cukup satu request.
// Kalau jumlah baris hasil tidak cocok (sumber kadang menggabung/memecah baris),
// baris itu diterjemahkan satu-satu. Ada batas waktu total supaya tidak kena timeout.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const LANGS = new Set(["id", "en", "ms", "ja", "ko", "zh-CN", "es", "ar"]);
const MAX_LINES = 400;
const MAX_LINE_CHARS = 300;
const CHUNK_CHARS = 1200;
const FALLBACK_LIMIT = 40;
const REQ_TIMEOUT = 8000;
const BUDGET_MS = 9000;

async function gtx(text, to) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT);
  try {
    const qs = new URLSearchParams({ client: "gtx", sl: "auto", tl: to, dt: "t", q: text });
    const r = await fetch(`https://translate.googleapis.com/translate_a/single?${qs}`, {
      signal: ctl.signal,
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
    return data[0].map(seg => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : "")).join("");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Kelompokkan baris jadi potongan yang muat dalam satu request
function chunkLines(items) {
  const chunks = [];
  let cur = [], len = 0;
  for (const it of items) {
    if (cur.length && len + it.text.length + 1 > CHUNK_CHARS) { chunks.push(cur); cur = []; len = 0; }
    cur.push(it);
    len += it.text.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function translateAll(items, to, out, deadline) {
  for (const chunk of chunkLines(items)) {
    if (Date.now() > deadline) break;
    const res = await gtx(chunk.map(c => c.text).join("\n"), to);
    if (res === null) continue;
    const parts = res.split("\n").map(s => s.trim());
    if (parts.length === chunk.length) {
      chunk.forEach((c, k) => { out[c.i] = parts[k]; });
      continue;
    }
    for (const c of chunk.slice(0, FALLBACK_LIMIT)) {
      if (Date.now() > deadline) break;
      out[c.i] = (await gtx(c.text, to)) || "";
    }
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://soundxs.web.id");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });
  if (await rateLimit(req, res, { name: "translate", max: 30 })) return;

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const to = typeof body?.to === "string" ? body.to : "id";
  if (!LANGS.has(to)) return res.status(400).json({ success: false, error: "Bahasa tujuan tidak didukung" });
  if (!Array.isArray(body?.lines) || !body.lines.length) {
    return res.status(400).json({ success: false, error: "lines wajib berupa array" });
  }

  const lines = body.lines.slice(0, MAX_LINES).map(v =>
    String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, MAX_LINE_CHARS)
  );
  const out = new Array(lines.length).fill("");
  const items = lines.map((text, i) => ({ i, text })).filter(x => x.text);

  try {
    await translateAll(items, to, out, Date.now() + BUDGET_MS);
    if (items.length && !out.some(Boolean)) {
      return res.status(502).json({ success: false, error: "Sumber terjemahan tidak merespons" });
    }
    return res.status(200).json({ success: true, lines: out });
  } catch (err) {
    console.error("[translate]", err.message);
    return res.status(500).json({ success: false, error: "Terjemahan gagal" });
  }
}
