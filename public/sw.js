// Service worker: permite abrir o app do jurado sem internet.
// Nunca armazena API, painel, entrega nem redirecionamentos (login pela ponte UpDance).
const VERSAO = 'udx-festival-v1';
const ARQUIVOS = [
  '/',
  '/index.html',
  '/css/udx-tokens.css',
  '/css/festival.css',
  '/js/tema.js',
  '/js/app.js',
  '/js/api.js',
  '/js/fila.js',
  '/js/gravador.js',
  '/js/sincronizador.js',
  '/js/microfone.js',
  '/manifest.webmanifest',
  '/icone.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(api|ouvir|admin|entrar)(\/|$)/.test(url.pathname)) return;

  // Rede primeiro (pega atualizações); cache se estiver sem internet
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp.ok && !resp.redirected && resp.type === 'basic') {
          const copia = resp.clone();
          caches.open(VERSAO).then((c) => c.put(e.request, copia));
        }
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: url.pathname === '/' }).then((r) => r || caches.match('/index.html'))),
  );
});
