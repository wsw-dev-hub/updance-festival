/**
 * Worker do UpDance Festival (Cloudflare Workers + assets do Vite em dist/).
 *
 * JURADOS (login principal: e-mail + senha — o "membro" do festival):
 *   POST /api/member/login      → login com e-mail e senha (cria sessão de JURADO, cookie m_session)
 *   POST /api/member/logout     → encerra a sessão de jurado
 *   POST /api/member/forgot     → envia link de redefinição de senha por e-mail
 *   POST /api/member/reset      → grava a nova senha a partir do link (/reset-senha/?token=…)
 *   POST /api/member/senha      → troca a própria senha (obrigatória no 1º acesso com senha provisória)
 *   GET  /api/me                → jurado logado (ou 401)
 *
 * ADMIN (login SEPARADO: e-mail + senha):
 *   POST /api/admin/setup       → cria/redefine admin (exige ADMIN_SETUP_KEY)
 *   POST /api/admin/login       → login de admin (cria sessão de ADMIN, cookie a_session)
 *   POST /api/admin/logout      → encerra a sessão de admin
 *   POST /api/admin/senha       → troca a própria senha
 *   GET  /api/admin/me          → admin logado (ou 401)
 *
 * FESTIVAL:
 *   /api/sessao, /api/gravacoes/*        app do jurado (exige m_session)
 *   /api/admin/*                         área de admin (exige a_session)
 *   /ouvir/<token>                       entrega pública ao participante
 *
 * Páginas protegidas: /admin/* (sessão de admin → senão /admin-login/).
 * Sessões e cookies SEPARADOS: m_session (jurado) e a_session (admin), guardadas no KV.
 *
 * Bindings: KV, DB (D1 updance-festival_db), AUDIOS (R2), ASSETS.
 * Vars: AMBIENTE, GMAIL_USER, PBKDF2_ITERACOES. Secrets: ADMIN_SETUP_KEY, GMAIL_APP_PASSWORD.
 * ESTE ARQUIVO RODA NO SERVIDOR — não use document/window.
 */

import { Roteador, ErroHttp, erro } from './lib/http.js';
import { getAdmin } from './lib/sessao.js';
import * as sessao from './rotas/sessao.js';
import * as jurado from './rotas/jurado.js';
import * as admin from './rotas/admin.js';
import * as entrega from './rotas/entrega.js';

const r = new Roteador()
  // ---- JURADOS (membros do festival) ----
  .rota('POST', '/api/member/login', sessao.memberLogin)
  .rota('POST', '/api/member/logout', sessao.memberLogout)
  .rota('POST', '/api/member/forgot', sessao.memberForgot)
  .rota('POST', '/api/member/reset', sessao.memberReset)
  .rota('POST', '/api/member/senha', sessao.memberSenha)
  .rota('GET', '/api/me', sessao.memberMe)

  // ---- ADMIN ----
  .rota('POST', '/api/admin/setup', sessao.adminSetup)
  .rota('POST', '/api/admin/login', sessao.adminLogin)
  .rota('POST', '/api/admin/logout', sessao.adminLogout)
  .rota('POST', '/api/admin/senha', sessao.adminSenha)
  .rota('GET', '/api/admin/me', sessao.adminMe)

  // ---- APP DO JURADO ----
  .rota('GET', '/api/sessao', jurado.sessao)
  .rota('PUT', '/api/gravacoes/:id', jurado.criarGravacao)
  .rota('PUT', '/api/gravacoes/:id/trechos/:seq', jurado.enviarTrecho)
  .rota('POST', '/api/gravacoes/:id/finalizar', jurado.finalizarGravacao)

  // ---- ADMIN: cadastros ----
  .rota('GET', '/api/admin/admins', admin.listarAdmins)
  .rota('POST', '/api/admin/admins', admin.criarAdmin)
  .rota('PATCH', '/api/admin/admins/:id', admin.atualizarAdmin)
  .rota('POST', '/api/admin/admins/:id/redefinir-senha', admin.redefinirSenhaAdmin)
  .rota('GET', '/api/admin/jurados', admin.listarJurados)
  .rota('POST', '/api/admin/jurados', admin.criarJurado)
  .rota('PATCH', '/api/admin/jurados/:id', admin.atualizarJurado)
  .rota('POST', '/api/admin/jurados/:id/redefinir-senha', admin.redefinirSenhaJurado)
  .rota('GET', '/api/admin/grupos', admin.listarGrupos)
  .rota('POST', '/api/admin/grupos', admin.criarGrupo)
  .rota('PATCH', '/api/admin/grupos/:id', admin.atualizarGrupo)
  .rota('DELETE', '/api/admin/grupos/:id', admin.excluirGrupo)

  // ---- ADMIN: eventos ----
  .rota('GET', '/api/admin/eventos', admin.listarEventos)
  .rota('POST', '/api/admin/eventos', admin.criarEvento)
  .rota('GET', '/api/admin/eventos/:id', admin.detalharEvento)
  .rota('PATCH', '/api/admin/eventos/:id', admin.atualizarEvento)
  .rota('POST', '/api/admin/eventos/:id/jurados', admin.escalarJurado)
  .rota('PATCH', '/api/admin/eventos/:id/jurados/:jurado', admin.atualizarEscala)
  .rota('POST', '/api/admin/eventos/:id/coreografias', admin.adicionarCoreografias)
  .rota('GET', '/api/admin/eventos/:id/gravacoes', admin.listarGravacoes)
  .rota('GET', '/api/admin/gravacoes/:id/audio', admin.ouvirGravacao)
  .rota('POST', '/api/admin/gravacoes/:id/aprovar', admin.aprovarGravacao)
  .rota('POST', '/api/admin/coreografias/:id/link', admin.criarLinkEntrega)
  .rota('POST', '/api/admin/coreografias/:id/revogar-links', admin.revogarLinks)
  .rota('GET', '/api/admin/auditoria', admin.listarAuditoria)

  // ---- ENTREGA AO PARTICIPANTE ----
  .rota('GET', '/ouvir/:token', entrega.paginaEntrega)
  .rota('GET', '/ouvir/:token/:gravacao', entrega.audioEntrega);

const ehPainel = (p) => p === '/admin' || p.startsWith('/admin/');
const ehDinamico = (p) => p.startsWith('/api/') || p.startsWith('/ouvir/');

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // ---- páginas protegidas: /admin/* (o Worker roda antes dos assets: run_worker_first) ----
      if (ehPainel(pathname)) {
        const a = await getAdmin(request, env);
        if (!a || a.trocar_senha) {
          const destino = new URL('/admin-login/', url.origin);
          if (!a) destino.searchParams.set('next', pathname + url.search);
          return Response.redirect(destino.toString(), 302);
        }
        const resp = await env.ASSETS.fetch(request);
        const h = new Headers(resp.headers);
        h.set('Cache-Control', 'no-store');
        return new Response(resp.body, { status: resp.status, headers: h });
      }

      if (!ehDinamico(pathname)) return env.ASSETS.fetch(request);

      // Sessão em cookie → proteção contra CSRF nas escritas:
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
      return await achada.fn(request, env, achada.params, ctx);
    } catch (e) {
      if (e instanceof ErroHttp) return erro(e.status, e.message, e.codigo);
      console.error('erro inesperado', e?.stack || e);
      return erro(500, 'Erro interno', 'interno');
    }
  },
};
