// オフライン用キャッシュ（ファイルを更新したら VERSION を変える）
const VERSION = "step-v1.0.2";
const ASSETS = [
  "./", "index.html", "style.css", "app.js", "step.js", "vision_bundle.mjs", "mp4-muxer.mjs",
  "xlsx.mini.min.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png",
  "vision_wasm_internal.js", "vision_wasm_internal.wasm",
  "rtm.js", "ort.webgpu.min.mjs", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
// 同じ github.io 上のほかのアプリ（gait-appなど）のキャッシュは消さない
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("step-") && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true, cacheName: VERSION }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }))
  );
});
