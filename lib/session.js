// lib/session.js
//
// Sesi login Google tanpa state di server: cookie httpOnly berisi payload
// (uid, nama, foto, email-admin flag, expired) + tanda tangan HMAC-SHA256.
// Secret: env SESSION_SECRET (wajib, string acak panjang).

import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "sp_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 hari

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET belum diset (min. 16 karakter)");
  return s;
}

function sign(b64) {
  return createHmac("sha256", getSecret()).update(b64).digest("hex");
}

export function uidFromSub(sub) {
  return createHash("sha256").update("g:" + String(sub)).digest("hex").slice(0, 32);
}

export function createSession({ sub, name, picture, email }) {
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const payload = {
    uid: uidFromSub(sub),
    name: String(name || "User").slice(0, 24).trim() || "User",
    picture: typeof picture === "string" && /^https:\/\//.test(picture) ? picture.slice(0, 300) : null,
    admin: !!email && admins.includes(String(email).toLowerCase()),
    exp: Date.now() + SESSION_MAX_AGE * 1000,
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b64}.${sign(b64)}`;
}

export function readSession(cookieValue) {
  if (!cookieValue || typeof cookieValue !== "string") return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot === -1) return null;
  const b64 = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);

  let expected;
  try { expected = sign(b64); } catch { return null; }
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const p = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (!p || !p.uid || !Number.isFinite(p.exp) || Date.now() > p.exp) return null;
    return p;
  } catch {
    return null;
  }
}
