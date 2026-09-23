// Worker "festival" do ecossistema UpDance (festival.updance.workers.dev).
//   /api/*          API (jurados e painel)
//   /ouvir/*        entrega pública aos participantes (link com token)
//   /admin/*        painel do festival — exige sessão de ADMIN UpDance (gate no servidor)
//   demais          app do jurado (PWA estático; a API é que exige sessão de membro)
//
// Bindings: DB = updance-festival_db (próprio) · AUDIOS = R2 próprio · KV = KV COMPARTILHADO do ecossistema

import { Roteador, ErroHttp, erro } from './lib/http.js';
import { obterAdmin, urlPonte } from './lib/sessao.js';
import * as sessao from './rotas/sessao.js';
import * as jurado from './rotas/jurado.js';
import * as admin from './rotas/admin.js';
import * as entrega from './rotas/entrega.js';

const r = new Roteador()
  // Sessão (ponte com o blog UpDance)
  .rota('GET', '/api/session/adopt', sessao.adotar)
  .rota('GET', '/entrar', sessao.entrar)
  .rota('GET', '/api/me', sessao.quemSouEu)
  .rota('POST', '/api/member/logout', sessao.sairMembro)
  .rota('POST', '/api/admin/logout', sessao.sairAdmin)
  // Jurado
  .rota('GET', '/api/sessao', jurado.sessao)
  .rota('PUT', '/api/gravacoes/:id', jurado.criarGravacao)
  .rota('PUT', '/api/gravacoes/:id/trechos/:seq', jurado.enviarTrecho)
  .rota('POST', '/api/gravacoes/:id/finalizar', jurado.finalizarGravacao)
  // Painel
  .rota('GET', '/api/admin/me', admin.quemSouEu)
  .rota('GET', '/api/admin/eventos', admin.listarEventos)
  .rota('POST', '/api/admin/eventos', admin.criarEvento)
  .rota('GET', '/api/admin/eventos/:id', admin.detalharEvento)
  .rota('POST', '/api/admin/eventos/:id/coreografias', admin.importarCoreografias)
  .rota('POST', '/api/admin/eventos/:id/jurados', admin.criarJurado)
  .rota('GET', '/api/admin/eventos/:id/gravacoes', admin.listarGravacoes)
  .rota('GET', '/api/admin/eventos/:id/auditoria', admin.listarAuditoria)
  .rota('PATCH', '/api/admin/jurados/:id', admin.atualizarJurado)
  .rota('GET', '/api/admin/gravacoes/:id/audio', admin.ouvirGravacao)
  .rota('POST', '/api/admin/gravacoes/:id/aprovar', admin.aprovarGravacao)
  .rota('POST', '/api/admin/coreografias/:id/link', admin.criarLinkEntrega)
  .rota('POST', '/api/admin/coreografias/:id/revogar-links', admin.revogarLinks)
  // Entrega
  .rota('GET', '/ouvir/:token', entrega.paginaEntrega)
  .rota('GET', '/ouvir/:token/:gravacao', entrega.audioEntrega);

const ehPainel = (p) => p === '/admin' || p.startsWith('/admin/');
const ehDinamico = (p) => p.startsWith('/api/') || p.startsWith('/ouvir/') || p === '/entrar';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ---- páginas protegidas: PAINEL (mesmo padrão do gate /admin/* do blog) ----
    if (ehPainel(pathname)) {
      if (!(await obterAdmin(request, env))) {
        return Response.redirect(urlPonte(env, url.toString(), 'admin'), 302);
      }
      const resp = await env.ASSETS.fetch(request);
      const h = new Headers(resp.headers);
      h.set('Cache-Control', 'no-store');
      return new Response(resp.body, { status: resp.status, headers: h });
    }

    if (!ehDinamico(pathname)) return env.ASSETS.fetch(request);

    // Autenticação por cookie → proteção contra CSRF nas escritas:
    // mesma origem + cabeçalho próprio (outro site não consegue enviá-lo sem preflight, que é recusado).
    if (request.method === 'OPTIONS') return new Response(null, { status: 405 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origem = request.headers.get('Origin');
      if ((origem && origem !== url.origin) || request.headers.get('X-UDX-Festival') !== '1') {
        return erro(403, 'Origem não permitida', 'origem_negada');
      }
    }

    const achada = r.encontrar(request.method, pathname);
    if (!achada) return erro(404, 'Rota não encontrada', 'nao_encontrada');
    if (achada.metodoNaoPermitido) return erro(405, 'Método não permitido', 'metodo');

    try {
      return await achada.fn(request, env, achada.params, ctx);
    } catch (e) {
      if (e instanceof ErroHttp) return erro(e.status, e.message, e.codigo);
      console.error('erro inesperado', e?.stack || e);
      return erro(500, 'Erro interno', 'interno');
    }
  },
};
