// api/auth.js
//   GET    -> { clientId, user }   (config Google + sesi saat ini)
//   POST   -> { credential }       login: verifikasi ID token Google, set cookie sesi
//   DELETE -> logout
//
// Env var (Vercel -> Settings -> Environment Variables):
//   GOOGLE_CLIENT_ID = OAuth Web client ID dari Google Cloud Console
//   SESSION_SECRET   = string acak panjang untuk tanda tangan cookie
//   ADMIN_EMAILS     = (opsional) email admin, pisah koma -> dapat badge "Dev"

import { parseCookies, appendSetCookie, serializeCookie } from "../lib/cookies.js";
import { SESSION_COOKIE, SESSION_MAX_AGE, createSession, readSession } from "../lib/session.js";

function publicUser(s) {
  return s ? { uid: s.uid, name: s.name, picture: s.picture, admin: !!s.admin } : null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const clientId = process.env.GOOGLE_CLIENT_ID || null;

  try {
    if (req.method === "GET") {
      const session = readSession(parseCookies(req)[SESSION_COOKIE]);
      return res.status(200).json({ success: true, clientId, user: publicUser(session) });
    }

    if (req.method === "POST") {
      if (!clientId) return res.status(503).json({ success: false, error: "Login Google belum dikonfigurasi di server" });

      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const credential = body?.credential;
      if (!credential || typeof credential !== "string" || credential.length > 4000) {
        return res.status(400).json({ success: false, error: "Token tidak valid" });
      }

      const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
      if (!r.ok) return res.status(401).json({ success: false, error: "Token Google ditolak" });
      const info = await r.json();

      const issOk = info.iss === "accounts.google.com" || info.iss === "https://accounts.google.com";
      const notExpired = Number(info.exp) * 1000 > Date.now();
      if (info.aud !== clientId || !issOk || !notExpired || !info.sub) {
        return res.status(401).json({ success: false, error: "Token Google tidak valid" });
      }

      const value = createSession({
        sub: info.sub,
        name: info.name || (info.email || "User").split("@")[0],
        picture: info.picture,
        email: info.email_verified === "true" || info.email_verified === true ? info.email : null,
      });
      appendSetCookie(res, serializeCookie(SESSION_COOKIE, value, { maxAgeSeconds: SESSION_MAX_AGE }));
      return res.status(200).json({ success: true, user: publicUser(readSession(value)) });
    }

    if (req.method === "DELETE") {
      appendSetCookie(res, serializeCookie(SESSION_COOKIE, "", { maxAgeSeconds: 0 }));
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (err) {
    console.error("[auth]", err);
    return res.status(500).json({ success: false, error: "Terjadi kesalahan di server" });
  }
}
