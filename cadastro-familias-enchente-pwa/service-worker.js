const CACHE_NAME = 'cadastro-enchente-v53';
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
  // A Cache API só aceita guardar respostas de requisições GET — tentar
  // cachear um POST (ex.: as chamadas de sincronização pro Apps Script)
  // lança erro. Deixa esses passarem direto pra rede, sem tentar cachear.
  if (event.request.method !== 'GET') return;

  // Só as telas e ícones do próprio app entram na estratégia abaixo. As
  // chamadas de DADOS (Apps Script) passam direto pra rede, sem cache.
  //
  // Antes elas também eram guardadas, e o efeito era ruim de um jeito difícil
  // de perceber: quando a rede passava dos 4 segundos — coisa comum, o Apps
  // Script é lento — o painel de acompanhamento recebia de volta os números
  // GUARDADOS da última vez e os exibia como se fossem atuais, sem nenhum
  // aviso. Num painel de calamidade, número velho apresentado como atual é
  // pior do que não mostrar número nenhum.
  if (new URL(event.request.url).origin !== self.location.origin) return;

  // Rede primeiro, cache como reserva — mas com um limite de tempo. Rede
  // primeiro sem limite nenhum tem seu próprio problema: numa conexão muito
  // ruim (comum em situação de calamidade, é literalmente pra isso que o
  // app existe), a requisição pode ficar "pendurada" sem nunca falhar nem
  // ter sucesso — e sem cair no .catch(), o app trava esperando a rede em
  // vez de abrir com o que já está salvo. Por isso: se a rede não responder
  // dentro de NETWORK_TIMEOUT_MS, usa o cache na hora (a resposta da rede,
  // se chegar depois, ainda atualiza o cache pra próxima vez).
  const NETWORK_TIMEOUT_MS = 4000;
  event.respondWith((async () => {
    const networkPromise = fetch(event.request)
      .then((response) => {
        const finalResponse = stripRedirect(response);
        const copy = finalResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return finalResponse;
      })
      .catch(() => null);

    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));
    const early = await Promise.race([networkPromise, timeoutPromise]);
    if (early) return early;

    const cached = await caches.match(event.request).then(stripRedirect);
    if (cached) return cached;

    // Sem nada em cache ainda (ex.: primeiríssima visita) e rede lenta: só
    // resta mesmo esperar a rede terminar.
    const late = await networkPromise;
    return late || Response.error();
  })());
});
