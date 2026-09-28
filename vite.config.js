import { defineConfig } from 'vite'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
// vite-plugin-mkcert NÃO é importado no topo: só é carregado (import dinâmico) no `vite` dev.
// Assim `vite build`, o CI e o wrangler conseguem ler este arquivo sem as dependências de dev.

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// Worker local (wrangler dev) que atende /api, /ouvir e as sessões durante o `vite` (dev).
const WORKER_DEV = process.env.WORKER_DEV || 'http://127.0.0.1:8787'
// HTTPS local via mkcert (padrão). SEM_HTTPS=1 desliga — ex.: máquina sem acesso ao GitHub para baixar o mkcert.
// Em http://localhost o microfone continua liberado; pelo IP da rede (celular) só com HTTPS.
const HTTPS = !process.env.SEM_HTTPS

// ─── Proxy para o Worker ──────────────────────────────────────────────────────
// O navegador fala só com o Vite (https://localhost:3000); o Vite repassa a API
// ao wrangler dev. O cabeçalho Origin é reescrito para a origem do Worker, senão
// a proteção contra CSRF (mesma origem) recusaria as escritas.
const proxyWorker = {
  target: WORKER_DEV,
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (req) => {
      if (req.getHeader('origin')) req.setHeader('origin', WORKER_DEV)
    })
  },
}

// ─── Plugin: gate da área de admin no dev ─────────────────────────────────────
// Em produção quem protege /admin/* é o Worker (run_worker_first). No dev as
// páginas vêm do Vite, então este middleware reproduz o mesmo comportamento:
// sem sessão de admin → /admin-login/.
const _adminGateDev = {
  name: 'udx-admin-gate-dev',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = req.url || ''
      // páginas da área de admin (/admin/, /admin/evento/…) — não os arquivos .js/.css
      if (!/^\/admin(\/[^.?]*)?(\/index\.html)?(\?|$)/.test(url)) return next()
      try {
        const r = await fetch(`${WORKER_DEV}/api/admin/me`, { headers: { cookie: req.headers.cookie || '' } })
        const eu = r.ok ? await r.json() : null
        if (eu && !eu.trocar_senha) return next()
      } catch {
        console.warn('[admin-gate] Worker indisponível em', WORKER_DEV, '— rode `npm run dev:worker`')
      }
      res.statusCode = 302
      res.setHeader('Location', `/admin-login/?next=${encodeURIComponent(url)}`)
      res.end()
    })
  },
}

export default defineConfig(async ({ command }) => ({
  base: '/',
  publicDir: 'public',
  plugins: command === 'serve'
    ? [
        HTTPS && (await import('vite-plugin-mkcert')).default(), // HTTPS no dev: microfone liberado também no celular pela rede
        _adminGateDev,                                           // gate de /admin/ só no dev
      ].filter(Boolean)
    : [],

  server: {
    port: 3000,
    open: true,
    host: !!process.env.EXPOSE_HOST,  // EXPOSE_HOST=1 npm run dev → acessível pelo celular na mesma rede
    https: HTTPS,
    proxy: {
      '/api': proxyWorker,
      '/ouvir': proxyWorker,
    },
  },

  resolve: {
    alias: {
      '@': '/src',
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,         // NUNCA gerar sourcemaps em produção
    minify: 'esbuild',
    target: 'es2020',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),                          // app do jurado (PWA)
        admin: resolve(__dirname, 'admin/index.html'),                   // dashboard da organização
        'admin-evento': resolve(__dirname, 'admin/evento/index.html'),   // tela exclusiva de cada evento
        'admin-login': resolve(__dirname, 'admin-login/index.html'),     // login da organização
        'reset-senha': resolve(__dirname, 'reset-senha/index.html'),     // nova senha pelo link do e-mail
        404: resolve(__dirname, '404.html'),                             // not_found_handling = "404-page"
      },
    },
  },
}))
