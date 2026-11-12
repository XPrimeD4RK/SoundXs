/*
 * SoundXs - perbaikan DOWNLOAD & OFFLINE (file tambahan, tidak mengubah kode player).
 * Dimuat SETELAH script utama; hanya menggantikan fungsi downloadTrackById.
 * Penyimpanan memakai IndexedDB "sp_offline" / store "audio" / key = String(id),
 * sama persis dengan yang dibaca playTrack() untuk memutar lagu offline.
 */
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  const MIN_BYTES = 20000;

  /* ---------- IndexedDB (kompatibel dengan punya index.html) ---------- */
  function idbOpen() {
    return new Promise((res, rej) => {
      const q = indexedDB.open("sp_offline", 1);
      q.onupgradeneeded = () => { if (!q.result.objectStoreNames.contains("audio")) q.result.createObjectStore("audio"); };
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function idb(mode, fn) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction("audio", mode);
      const r = fn(tx.objectStore("audio"));
      tx.oncomplete = () => { db.close(); res(r && r.result !== undefined ? r.result : null); };
      tx.onerror = () => { db.close(); rej(tx.error); };
      tx.onabort = () => { db.close(); rej(tx.error || new Error("Penyimpanan dibatalkan")); };
    });
  }
  const dbGet = (id) => idb("readonly", s => s.get(String(id)));
  const dbPut = (id, blob) => idb("readwrite", s => s.put(blob, String(id)));
  const dbDel = (id) => idb("readwrite", s => s.delete(String(id)));

  /* ---------- fetch helpers ---------- */
  function audioMime(headerType, hint) {
    const h = String(headerType || "").split(";")[0].trim().toLowerCase();
    if (/^audio\//.test(h)) return h;
    const k = String(hint || "").split(";")[0].trim().toLowerCase();
    return /^audio\//.test(k) ? k : "audio/mpeg";
  }

  async function fetchRetry(url, tries) {
    tries = tries || 3;
    let err;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) {
          let detail = "";
          try { const j = await r.clone().json(); detail = j.error || ""; if (j.upstream_status) detail += " [SoundCloud " + j.upstream_status + "]"; } catch (_) {}
          const er = new Error("HTTP " + r.status + (detail ? " - " + detail : ""));
          er.noRetry = r.status >= 400 && r.status < 500;
          throw er;
        }
        return r;
      } catch (e) {
        err = e;
        if (e.noRetry || !navigator.onLine) break;
        await new Promise(res => setTimeout(res, 400 * (i + 1)));
      }
    }
    throw err;
  }

  // Lagu satu file (progressive)
  async function fetchFileBlob(url, onProgress, mimeHint) {
    const r = await fetchRetry(url);
    const type = r.headers.get("content-type") || "";
    if (/json|html|text\/|mpegurl/i.test(type)) throw new Error("Respon bukan audio");
    const total = +r.headers.get("content-length") || 0;
    const reader = r.body.getReader();
    const chunks = []; let got = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      if (total && onProgress) onProgress(Math.min(1, got / total));
    }
    const blob = new Blob(chunks, { type: audioMime(type, mimeHint) });
    if (blob.size < MIN_BYTES) throw new Error("File audio kosong/terlalu kecil");
    return blob;
  }

  // Lagu HLS: ambil playlist, unduh semua segmen berurutan, sambung jadi satu file
  async function fetchHlsBlob(url, onProgress, mimeHint) {
    let r = await fetchRetry(url);
    let text = await r.text();
    let base = r.url || url;
    if (!/^#EXTM3U/.test(text.trim())) throw new Error("Playlist HLS tidak valid");

    if (/#EXT-X-STREAM-INF/.test(text)) {            // master playlist -> varian pertama
      const v = text.split(/\r?\n/).find(l => l && !l.startsWith("#"));
      if (!v) throw new Error("Varian HLS tidak ditemukan");
      base = new URL(v, base).toString();
      r = await fetchRetry(base);
      text = await r.text();
      base = r.url || base;
    }
    if (/#EXT-X-KEY:(?!METHOD=NONE)/.test(text)) throw new Error("Stream terenkripsi, tidak bisa disimpan");

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const urls = [];
    const map = lines.find(l => l.startsWith("#EXT-X-MAP:"));
    if (map) { const m = map.match(/URI="([^"]+)"/); if (m) urls.push(new URL(m[1], base).toString()); }
    for (const l of lines) if (!l.startsWith("#")) urls.push(new URL(l, base).toString());
    if (!urls.length) throw new Error("Playlist HLS kosong");

    // segmen: langsung dari CDN; kalau diblok browser (CORS) lewat /api/dl
    const getSeg = async (u) => {
      try { return await fetchRetry(u, 3); }
      catch (e) {
        if (e.noRetry) throw e;
        return await fetchRetry("/api/dl?url=" + encodeURIComponent(u), 2);
      }
    };

    const parts = new Array(urls.length);
    let next = 0, done = 0, failed = null;
    const worker = async () => {
      while (!failed) {
        const i = next++;
        if (i >= urls.length) return;
        try {
          const sr = await getSeg(urls[i]);
          parts[i] = new Uint8Array(await sr.arrayBuffer());
          done++;
          if (onProgress) onProgress(done / urls.length);
        } catch (e) { failed = e; }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (failed) throw new Error("Segmen gagal diunduh: " + failed.message);

    const blob = new Blob(parts, { type: audioMime("", mimeHint) });
    if (blob.size < MIN_BYTES) throw new Error("File audio kosong/terlalu kecil");
    return blob;
  }

  root.__spDl = { fetchHlsBlob, fetchFileBlob, audioMime }; // untuk pengujian

  /* ---------- pengganti downloadTrackById ---------- */
  if (typeof state === "undefined" || typeof apiClient === "undefined" || typeof toast !== "function") return;
  if (typeof indexedDB === "undefined") return;

  const busy = new Set();

  root.downloadTrackById = async function downloadTrackById(trackId) {
    const t = state.tracks.find(x => x.id == trackId)
      || state.downloaded.find(x => x.id == trackId)
      || (state.currentTrack && state.currentTrack.id == trackId ? state.currentTrack : null);
    if (!t) return;
    if (busy.has(t.id)) return toast("Sedang mengunduh, tunggu sebentar...");

    let hasBlob = false;
    try { hasBlob = !!(await dbGet(t.id)); } catch (_) {}

    if (hasBlob) {
      try { await dbDel(t.id); } catch (_) {}
      state.downloaded = state.downloaded.filter(d => d.id !== t.id);
      toast("Dihapus dari Offline");
    } else {
      if (!navigator.onLine) return toast("Kamu sedang offline, tidak bisa mengunduh");
      const raw = apiClient.getStreamUrl(t);
      if (!raw) return toast("Lagu ini tidak punya stream yang bisa disimpan");
      // aturan yang sama dengan player: URL berisi "hls" = HLS
      const isHls = raw.includes("hls") || t.stream_type === "hls";
      busy.add(t.id);
      try {
        let cid = apiClient.clientId || await apiClient.getCredentials();
        const mk = (id) => {
          let u = "/api/stream?url=" + encodeURIComponent(raw) + "&client_id=" + encodeURIComponent(id);
          if (t.track_authorization) u += "&track_authorization=" + encodeURIComponent(t.track_authorization);
          return u;
        };
        let lastStep = -1;
        const prog = (p) => { const s = Math.floor(p * 10); if (s !== lastStep) { lastStep = s; toast("Mengunduh " + Math.round(p * 100) + "%"); } };
        const run = (id) => isHls ? fetchHlsBlob(mk(id), prog, "audio/mpeg") : fetchFileBlob(mk(id), prog, "audio/mpeg");
        toast("Mengunduh...");
        let blob;
        try { blob = await run(cid); }
        catch (e1) {
          if (/\b(401|403|502)\b/.test(e1.message)) {         // client_id kedaluwarsa
            cid = await apiClient.getCredentials(true);
            blob = await run(cid);
          } else throw e1;
        }
        await dbPut(t.id, blob);
        if (!(await dbGet(t.id))) throw new Error("Penyimpanan perangkat menolak file");
        if (!state.downloaded.some(d => d.id === t.id)) state.downloaded.push(t);
        toast('"' + t.title + '" tersimpan offline');
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
      } catch (e) {
        try { await dbDel(t.id); } catch (_) {}
        const quota = e && (e.name === "QuotaExceededError" || /quota/i.test(e.message || ""));
        toast(quota ? "Penyimpanan perangkat penuh" : "Gagal unduh: " + (e.message || e));
      } finally {
        busy.delete(t.id);
      }
    }

    try { localStorage.setItem("sp_downloaded", JSON.stringify(state.downloaded)); } catch (_) {}
    if (typeof refreshOfflineCount === "function") refreshOfflineCount();
    if (typeof updateDownloadUI === "function") updateDownloadUI(t.id);
    if (state.view === "home" && typeof renderTrackList === "function") renderTrackList(state.tracks, "quickPicksGrid");
    if (state.view === "offline" && typeof renderOffline === "function") renderOffline();
    if (state.view === "search" && typeof renderSearch === "function") renderSearch();
  };
})();
