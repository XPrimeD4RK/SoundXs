/**
 * Pemulihan buffering untuk elemen <audio id="audioEngine">.
 *
 * - Tidak menjeda / memutar ulang elemen saat buffering. Cara lama itu yang
 *   bikin musik terputus di koneksi lemah.
 * - Kalau buffering bertahan WATCHDOG_MS tanpa kemajuan, minta index.html
 *   memuat ulang stream lewat window.spRecoverStream().
 */
(function () {
  const audio = document.getElementById("audioEngine");
  if (!audio) return;

  const WATCHDOG_MS = 12000;
  let watchdog = 0;
  let recoveries = 0;

  function clearWatchdog() {
    if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
  }

  function armWatchdog() {
    if (watchdog || audio.paused) return;
    const at = audio.currentTime;
    watchdog = setTimeout(() => {
      watchdog = 0;
      const stuck = !audio.paused && Math.abs(audio.currentTime - at) < 0.05 && audio.readyState < 3;
      if (!stuck) return;
      recoveries++;
      if (typeof window.spRecoverStream === "function") window.spRecoverStream();
    }, WATCHDOG_MS);
  }

  audio.addEventListener("waiting", armWatchdog);
  audio.addEventListener("stalled", armWatchdog);
  audio.addEventListener("playing", clearWatchdog);
  audio.addEventListener("pause", clearWatchdog);
  audio.addEventListener("emptied", clearWatchdog);
  audio.addEventListener("ended", clearWatchdog);

  window.AudioPlaybackEnhanced = {
    getState: () => ({
      recoveries,
      currentTime: audio.currentTime,
      duration: audio.duration,
      paused: audio.paused,
      readyState: audio.readyState,
      networkState: audio.networkState,
      error: audio.error ? audio.error.code : null,
    }),
  };
})();
