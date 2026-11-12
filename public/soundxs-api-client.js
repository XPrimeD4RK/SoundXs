(function () {
  "use strict";
  const API = "/api";
  let clientId = null;
  let credentialsPromise = null;

  async function readJson(response) {
    let data;
    try { data = await response.json(); }
    catch { throw new Error(response.ok ? "Respons server tidak valid" : "API belum aktif. Jalankan lewat `vercel dev` atau buka versi yang sudah di-deploy."); }
    if (!response.ok || data?.success === false) {
      const message = data?.error || `Request gagal (${response.status})`;
      throw new Error(message);
    }
    return data;
  }

  async function getCredentials(force) {
    if (clientId && !force) return clientId;
    if (credentialsPromise && !force) return credentialsPromise;
    credentialsPromise = (async () => {
      const response = await fetch(`${API}/get-credentials`, {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      const data = await readJson(response);
      const id = data.client_id || data.clientId;
      if (typeof id !== "string" || id.length < 20) throw new Error("Kredensial SoundCloud tidak tersedia");
      clientId = id;
      return id;
    })();
    try { return await credentialsPromise; }
    finally { credentialsPromise = null; }
  }

  async function requestSearch(params) {
    const id = await getCredentials();
    const query = new URLSearchParams({ ...params, client_id: id });
    let response = await fetch(`${API}/search?${query}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (response.status === 401) {
      await getCredentials(true);
      query.set("client_id", clientId);
      response = await fetch(`${API}/search?${query}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    }
    return readJson(response);
  }

  window.apiClient = {
    get clientId() { return clientId; },
    set clientId(v) { clientId = v || null; },
    getCredentials,
    search(q) { return requestSearch({ q: String(q || "").trim(), type: "tracks" }); },
    searchPlaylists(q) { return requestSearch({ q: String(q || "").trim(), type: "playlists" }); },
    searchArtists(q) { return requestSearch({ q: String(q || "").trim(), type: "users" }); },
    getPlaylistTracks(id) { return requestSearch({ playlist_id: String(id), type: "tracks" }); },
    getStreamUrl(track) {
      if (!track || !track.stream_url) return null;
      return track.stream_url;
    }
  };

  // index.html memakai `new SoundXsAPI()`; kembalikan objek apiClient yang sama.
  window.SoundXsAPI = function SoundXsAPI() { return window.apiClient; };
})();
