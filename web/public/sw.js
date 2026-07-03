/**
 * Service Worker — Antigravity Remote Connect PWA
 * Provides offline splash screen and caching of static assets.
 * Only caches same-origin resources — never intercepts external CDN requests.
 */

const CACHE_NAME = 'ag-remote-v6';
const STATIC_ASSETS = [
    '/app/index.html',
    '/app/manifest.json'
];

// Install — cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// Fetch — only intercept same-origin requests
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // IMPORTANT: Skip all cross-origin requests (CDN, external APIs, etc.)
    // These must go through the network directly — intercepting them causes CSP violations.
    if (url.origin !== self.location.origin) {
        return;
    }

    // Skip API calls, WebSocket upgrades, and auth routes
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/auth')) {
        return;
    }

    // For same-origin static assets: network first, cache fallback
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Clone and cache successful responses for same-origin only
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, clone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Fallback to cache when offline
                return caches.match(event.request).then((cached) => {
                    if (cached) return cached;

                    // If the main page is requested offline, show cached index
                    if (event.request.mode === 'navigate') {
                        return caches.match('/app/index.html');
                    }

                    return new Response('Offline', { status: 503 });
                });
            })
    );
});
