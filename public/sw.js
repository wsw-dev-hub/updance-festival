// Service worker: permite abrir o app do jurado sem internet.
// Nunca armazena API, área de admin, entrega nem a página de nova senha.
//
// Os arquivos gerados pelo Vite têm hash no nome (/assets/app-3f9c1a.js). Na instalação,
// o SW lê o index.html publicado e guarda todos os /assets/* que ele referencia; assim
// o app abre offline já na primeira visita depois da instalação.
const VERSAO = 'udx-festival-v12';
const FIXOS = [
  '/',
  '/manifest.webmanifest',
  '/js/tema.js',
  '/images/icons/udx-icon.png',
  '/images/icons/udx-icon-192.png',
  '/images/icons/udx-icon.ico',
];

async function instalar() {
  const cache = await caches.open(VERSAO);
  await cache.addAll(FIXOS);
  const html = await (await cache.match('/')).text();
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
  await cache.addAll(assets);
}

self.addEventListener('install', (e) => {
  e.waitUntil(instalar().then(() => self.skipWaiting()));
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
  if (/^\/(api|ouvir|admin|admin-login|reset-senha)(\/|$)/.test(url.pathname)) return;

  // /assets/* tem hash no nome: nunca muda → cache primeiro
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then((r) => r || fetch(e.request).then((resp) => {
        if (resp.ok) {
          const copia = resp.clone();
          caches.open(VERSAO).then((c) => c.put(e.request, copia));
        }
        return resp;
      })),
    );
    return;
  }

  // Demais: rede primeiro (pega atualizações); cache se estiver sem internet
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp.ok && !resp.redirected && resp.type === 'basic') {
          const copia = resp.clone();
          caches.open(VERSAO).then((c) => c.put(url.pathname === '/index.html' ? '/' : e.request, copia));
        }
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: url.pathname === '/' }).then((r) => r || caches.match('/'))),
  );
});
