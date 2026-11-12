// lib/cookies.js
// Helper backend-only untuk baca/tulis cookie httpOnly.
// File ini TIDAK ada di folder api/ atau public/, jadi tidak pernah jadi
// endpoint publik dan tidak pernah dikirim ke browser — murni dipakai
// oleh function serverless lain lewat import.

export function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// Menambahkan satu Set-Cookie ke response tanpa menimpa Set-Cookie lain
// yang mungkin sudah di-set sebelumnya di request yang sama.
export function appendSetCookie(res, cookieString) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", cookieString);
  } else if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, cookieString]);
  } else {
    res.setHeader("Set-Cookie", [prev, cookieString]);
  }
}

export function serializeCookie(name, value, { httpOnly = true, secure = true, sameSite = "Lax", maxAgeSeconds, path = "/" } = {}) {
  let str = `${name}=${encodeURIComponent(value)}; Path=${path}`;
  if (httpOnly) str += "; HttpOnly";
  if (secure) str += "; Secure";
  if (sameSite) str += `; SameSite=${sameSite}`;
  if (typeof maxAgeSeconds === "number") str += `; Max-Age=${maxAgeSeconds}`;
  return str;
}
