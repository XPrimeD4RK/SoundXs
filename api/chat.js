// api/chat.js
// Chat global. Identitas pengirim = akun Google (cookie sesi dari /api/auth).
//   GET    -> daftar pesan (publik, bisa dibaca tanpa login)
//   POST   -> kirim pesan   (wajib login)
//   PUT    -> edit pesan sendiri
//   DELETE -> hapus pesan sendiri

import { parseCookies } from "../lib/cookies.js";
import { SESSION_COOKIE, readSession } from "../lib/session.js";

// ============================================================
// KV Backend: Upstash REST API (langsung via fetch, tanpa package)
// Env: KV_REST_API_URL + KV_REST_API_TOKEN
// ============================================================
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const useKV = !!(KV_URL && KV_TOKEN);

async function kvCmd(...args) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("KV invalid response: " + text.slice(0, 200)); }
  if (!r.ok || data.error) throw new Error("KV: " + (data.error || r.status));
  return data.result;
}

// Wrapper supaya API-nya sama kayak @vercel/kv (lrange, lpush, lindex, lset, ltrim)
const kv = useKV ? {
  lrange: (key, start, stop) => kvCmd("LRANGE", key, start, stop),
  lpush: (key, value) => kvCmd("LPUSH", key, value),
  lindex: (key, idx) => kvCmd("LINDEX", key, idx),
  lset: (key, idx, value) => kvCmd("LSET", key, idx, value),
  ltrim: (key, start, stop) => kvCmd("LTRIM", key, start, stop),
  lrem: (key, count, value) => kvCmd("LREM", key, count, value),
  expire: (key, seconds) => kvCmd("EXPIRE", key, seconds),
} : null;

const memStore = { messages: [] };
const KEY = "soundpulse:chat:messages";

// ============================================================
// Auto-hapus riwayat chat: pesan hanya hidup 24 jam sejak dikirim
// supaya database tidak penuh.
//  1) GET selalu menyaring pesan > 24 jam (tidak pernah tampil).
//  2) purgeExpired() membuang pesan kadaluarsa dari ekor list di KV
//     (list = terbaru di depan, terlama di belakang).
//  3) Setiap POST memasang EXPIRE 24 jam pada seluruh key sebagai
//     jaring pengaman: kalau tidak ada pesan baru, semua data hilang
//     sendiri tepat saat pesan terakhir berumur 24 jam.
// ============================================================
const CHAT_TTL_MS = 24 * 60 * 60 * 1000;
const CHAT_TTL_SEC = 24 * 60 * 60;
const PURGE_INTERVAL_MS = 60_000;     // hemat command Upstash
const PURGE_MAX_PER_RUN = 100;        // batas hapus per eksekusi
let lastPurge = 0;

const isExpired = (m, now = Date.now()) =>
  !m || typeof m.ts !== "number" || now - m.ts >= CHAT_TTL_MS;

async function purgeExpired(force = false) {
  const now = Date.now();
  if (!force && now - lastPurge < PURGE_INTERVAL_MS) return;
  lastPurge = now;

  if (!useKV) {
    memStore.messages = memStore.messages.filter(m => !isExpired(m, now));
    return;
  }
  try {
    for (let i = 0; i < PURGE_MAX_PER_RUN; i++) {
      const raw = await kv.lindex(KEY, -1);          // pesan paling lama
      if (raw === null || raw === undefined) break;  // list kosong
      const m = parseMsg(raw);
      if (!isExpired(m, now)) break;                 // sisanya masih baru
      // LREM (bukan RPOP): hanya menghapus entri persis ini, jadi aman
      // walau ada pesan lain yang masuk/ter-trim bersamaan.
      await kv.lrem(KEY, -1, typeof raw === "string" ? raw : JSON.stringify(raw));
    }
  } catch (e) {
    console.error("[chat] purge gagal:", e);        // best-effort, jangan ganggu request
  }
}

const IMAGE_DATA_URI = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/]+=*$/;
const FILE_DATA_URI = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/i;

function isValidDataUri(value, re, maxLen = 700000) {
  return typeof value === "string" && value.length > 0 && value.length < maxLen && re.test(value);
}

const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 8;
const rateMap = new Map();

function isRateLimited(key) {
  const now = Date.now();
  const entry = rateMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateMap.set(key, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

const parseMsg = (m) => {
  try { return typeof m === "string" ? JSON.parse(m) : m; } catch { return null; }
};

async function findMessageIndex(id, useKV) {
  if (useKV) {
    const raw = await kv.lrange(KEY, 0, 199);
    for (let i = 0; i < raw.length; i++) {
      const m = parseMsg(raw[i]);
      if (m && m.id === id) return i;
    }
    return -1;
  }
  return memStore.messages.findIndex(m => m.id === id);
}

async function loadMessageAt(idx, useKV) {
  if (useKV) return parseMsg(await kv.lindex(KEY, idx));
  return memStore.messages[idx];
}

async function saveMessageAt(idx, msg, useKV) {
  if (useKV) await kv.lset(KEY, idx, JSON.stringify(msg));
  else memStore.messages[idx] = msg;
}

const safeAvatar = (a) => (typeof a === "string" && /^https:\/\//.test(a) ? a : null);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://soundxs.web.id");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();

  // useKV udah dihitung di atas, tinggal pakai
  const session = readSession(parseCookies(req)[SESSION_COOKIE]);

  try {
    // ============ GET ============
    if (req.method === "GET") {
      await purgeExpired();
      const now = Date.now();
      let messages;
      if (useKV) {
        const raw = await kv.lrange(KEY, 0, 99);
        messages = raw.map(parseMsg).filter(Boolean).reverse();
      } else {
        messages = memStore.messages.slice(-100);
      }
      messages = messages.filter(m => !isExpired(m, now));
      const out = messages.map(m => {
        if (m.deleted) return { id: m.id, uid: m.uid || null, name: m.name || "", avatar: safeAvatar(m.avatar), deleted: true, ts: m.ts };
        return {
          id: m.id,
          uid: m.uid || null,
          name: m.name,
          avatar: safeAvatar(m.avatar),
          admin: !!m.admin,
          text: m.text || "",
          image: m.image || null,
          file: m.file || null,
          replyTo: m.replyTo || null,
          ts: m.ts,
          editedAt: m.editedAt || null,
        };
      });
      return res.status(200).json({ success: true, messages: out, storage: useKV ? "kv" : "memory" });
    }

    // Semua operasi tulis wajib login Google
    if (!session) {
      return res.status(401).json({ success: false, code: "AUTH", error: "Login dengan Google dulu untuk ikut chat" });
    }
    if (isRateLimited(session.uid)) {
      return res.status(429).json({ success: false, error: "Terlalu banyak request, coba lagi sebentar" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // ============ POST ============
    if (req.method === "POST") {
      const { text, image, file, replyTo, clientId } = body;
      const safeId = typeof clientId === "string" && /^[a-z0-9]{6,30}$/i.test(clientId) ? clientId : null;

      const cleanText = text ? String(text).slice(0, 500).trim() : "";
      const cleanImage = isValidDataUri(image, IMAGE_DATA_URI) ? image : null;
      const cleanFile = file && typeof file === "object" && isValidDataUri(file.data, FILE_DATA_URI)
        ? {
            name: String(file.name || "file").slice(0, 100).replace(/[<>"'&]/g, ""),
            type: String(file.type || "").slice(0, 60),
            size: Number(file.size) || 0,
            data: file.data,
          }
        : null;
      if ((image && !cleanImage) || (file && !cleanFile)) return res.status(400).json({ success: false, error: "Format lampiran tidak valid" });
      if (!cleanText && !cleanImage && !cleanFile) return res.status(400).json({ success: false, error: "Pesan kosong" });

      const cleanReply = replyTo && typeof replyTo === "object"
        ? {
            id: String(replyTo.id || "").slice(0, 30),
            name: String(replyTo.name || "").slice(0, 24),
            text: String(replyTo.text || "").slice(0, 100),
            hasImage: !!replyTo.hasImage,
            hasFile: !!replyTo.hasFile,
          }
        : null;

      if (safeId) {
        const recent = useKV ? (await kv.lrange(KEY, 0, 49)).map(parseMsg) : memStore.messages;
        if (recent.some(m => m && m.id === safeId)) return res.status(200).json({ success: true, duplicate: true });
      }

      const msg = {
        id: safeId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        uid: session.uid,
        name: session.name,
        avatar: session.picture,
        admin: !!session.admin,
        text: cleanText,
        image: cleanImage,
        file: cleanFile,
        replyTo: cleanReply,
        ts: Date.now(),
      };

      if (useKV) {
        await kv.lpush(KEY, JSON.stringify(msg));
        await kv.ltrim(KEY, 0, 199);
        await kv.expire(KEY, CHAT_TTL_SEC);   // jaring pengaman 24 jam
        await purgeExpired();
      } else {
        memStore.messages.push(msg);
        if (memStore.messages.length > 200) memStore.messages.shift();
        await purgeExpired();
      }
      return res.status(200).json({ success: true, message: msg });
    }

    // ============ PUT (EDIT) ============
    if (req.method === "PUT") {
      const { id, text } = body;
      if (!id || !text) return res.status(400).json({ success: false, error: "Data tidak lengkap" });

      const cleanText = String(text).slice(0, 500).trim();
      if (!cleanText) return res.status(400).json({ success: false, error: "Pesan tidak boleh kosong" });

      const idx = await findMessageIndex(id, useKV);
      if (idx === -1) return res.status(404).json({ success: false, error: "Pesan tidak ditemukan" });

      const msg = await loadMessageAt(idx, useKV);
      if (!msg || msg.deleted) return res.status(410).json({ success: false, error: "Pesan sudah dihapus" });
      if (msg.uid !== session.uid) return res.status(403).json({ success: false, error: "Kamu tidak bisa mengedit pesan ini" });

      msg.text = cleanText;
      msg.editedAt = Date.now();
      await saveMessageAt(idx, msg, useKV);
      return res.status(200).json({ success: true, message: { id: msg.id, text: msg.text, editedAt: msg.editedAt } });
    }

    // ============ DELETE ============
    if (req.method === "DELETE") {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: "ID pesan tidak ada" });

      const idx = await findMessageIndex(id, useKV);
      if (idx === -1) return res.status(404).json({ success: false, error: "Pesan tidak ditemukan" });

      const msg = await loadMessageAt(idx, useKV);
      if (!msg) return res.status(404).json({ success: false, error: "Pesan tidak ditemukan" });
      if (msg.deleted) return res.status(200).json({ success: true });
      if (msg.uid !== session.uid) return res.status(403).json({ success: false, error: "Kamu tidak bisa menghapus pesan ini" });

      const tombstone = { id: msg.id, uid: msg.uid, name: msg.name, avatar: msg.avatar, deleted: true, ts: msg.ts, deletedAt: Date.now() };
      await saveMessageAt(idx, tombstone, useKV);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (err) {
    console.error("[chat]", err);
    return res.status(500).json({ success: false, error: "Terjadi kesalahan di server" });
  }
}