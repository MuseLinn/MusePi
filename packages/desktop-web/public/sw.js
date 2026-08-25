/* MusePi collab PWA service worker — offline shell + static asset cache.
 *
 * Served from the relay's static root (desktop-web/dist). The shell HTML is
 * network-first (fresh deploy wins), static assets are cache-first (hash
 * filenames are immutable). Offline, the cached connect shell still opens so
 * the user can read the guide / copy a link — connecting itself needs a
 * network.
 *
 * Version bump to invalidate every cached asset.
 */
const CACHE = "musepi-collab-v1";

const PRECACHE = [
	"./",
	"./index.html",
	"./mobile.html",
	"./manifest.webmanifest",
	"./mobile.webmanifest",
	"./favicon.svg",
	"./favicon-192x192.png",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	// Only same-origin GETs; never touch the relay WS upgrade or cross-origin.
	if (url.origin !== self.location.origin) return;

	if (req.mode === "navigate") {
		// Network-first shell: fresh HTML wins and replaces the cache entry;
		// offline falls back to the cached copy.
		event.respondWith(
			fetch(req)
				.then((res) => {
					if (res.ok) {
						const copy = res.clone();
						void caches.open(CACHE).then((c) => c.put(req, copy));
					}
					return res;
				})
				.catch(() =>
					caches.match(req).then((hit) => hit || caches.match("./index.html")),
				),
		);
		return;
	}

	// Static assets: cache-first with runtime fill (hash names never change).
	event.respondWith(
		caches.match(req).then(
			(hit) =>
				hit ||
				fetch(req).then((res) => {
					if (res.ok) {
						const copy = res.clone();
						void caches.open(CACHE).then((c) => c.put(req, copy));
					}
					return res;
				}),
		),
	);
});
