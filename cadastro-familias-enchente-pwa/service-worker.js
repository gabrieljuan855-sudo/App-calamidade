const CACHE_NAME = 'cadastro-enchente-v23';
const ASSETS = ['./', './index.html', './acompanhamento.html', './manifest.json', './icon-192.png', './icon-512.png'];

// O Safari recusa servir, para uma navegação, uma resposta que veio de um
// redirecionamento (ex.: http->https, ou mudança de domínio) — dá o erro
// "has redirections". Recriamos a resposta sem essa marca antes de guardar
// OU de entregar, seja ela recém-buscada ou já guardada em cache de antes
// dessa correção (por isso limpamos nos dois lugares, não só um).
function stripRedirect(response) {
  return response && response.redirected ? new Response(response.body, response) : response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS.map((url) =>
        fetch(url).then((response) => cache.put(url, stripRedirect(response)))
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedRaw) => {
      const cached = stripRedirect(cachedRaw);
      const fetchPromise = fetch(event.request)
        .then((response) => {
          const finalResponse = stripRedirect(response);
          const copy = finalResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return finalResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
