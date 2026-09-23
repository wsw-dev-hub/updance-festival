// Ponte de sessão com o blog UpDance (adopt) e logout.

import { json, ErroHttp } from '../lib/http.js';
import {
  COOKIE_MEMBRO, COOKIE_ADMIN, PREFIXO, cookie, apagarCookie, lerCookie, lerSessao, obterMembro, urlPonte,
} from '../lib/sessao.js';

const maxAge = (env) => Number(env.SESSAO_COOKIE_MAX_AGE) || 7 * 86400;

/* GET /api/session/adopt?t=<token>
   Espelha o sessionAdopt do app.updance:
     1) apaga o handoff ANTES de validar (uso único, fecha replay);
     2) confere se a sessão ainda existe no KV compartilhado;
     3) `next` vem só do KV (nunca da URL) e precisa ser deste mesmo origin. */
export async function adotar(request, env) {
  const url = new URL(request.url);
  const tipoPedido = url.searchParams.get('tipo') === 'admin' ? 'admin' : 'membro';
  const falha = () => Response.redirect(new URL(tipoPedido === 'admin' ? '/admin-login/' : '/entrar/', env.BLOG_ORIGIN).toString(), 302);

  const tok = url.searchParams.get('t');
  if (!tok || tok.length > 200) return falha();
  const bruto = await env.KV.get(`handoff:${tok}`);
  if (!bruto) return falha();
  await env.KV.delete(`handoff:${tok}`);

  let p = null;
  try {
    p = JSON.parse(bruto);
  } catch {
    p = null;
  }
  if (!p || typeof p.sid !== 'string' || !p.sid) return falha();

  const tipo = p.tipo === 'admin' ? 'admin' : 'membro';
  const sessao = await lerSessao(env, PREFIXO[tipo], p.sid);
  if (!sessao) return falha();

  const padrao = `${url.origin}${tipo === 'admin' ? '/admin/' : '/'}`;
  const next = typeof p.next === 'string' && p.next.startsWith(`${url.origin}/`) ? p.next : padrao;

  return new Response(null, {
    status: 302,
    headers: {
      Location: next,
      'Set-Cookie': cookie(tipo === 'admin' ? COOKIE_ADMIN : COOKIE_MEMBRO, p.sid, maxAge(env)),
      'Cache-Control': 'no-store',
    },
  });
}

/* GET /entrar?next=/caminho — leva à ponte de sessão do blog e volta para o caminho informado.
   GET /entrar?login=1      — abre direto o login do blog (saída de emergência do guard contra loop). */
export async function entrar(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get('login') === '1') return Response.redirect(new URL('/entrar/', env.BLOG_ORIGIN).toString(), 302);
  const pedido = url.searchParams.get('next') || '/';
  const caminho = pedido.startsWith('/') && !pedido.startsWith('//') && !pedido.includes('\\') ? pedido : '/';
  return Response.redirect(urlPonte(env, `${url.origin}${caminho}`), 302);
}

/* GET /api/me — mesmo contrato do ecossistema (email + tipos) */
export async function quemSouEu(request, env) {
  const m = await obterMembro(request, env);
  if (!m) throw new ErroHttp(401, 'Entre com sua conta UpDance', 'sessao_invalida');
  return json({ email: m.email, types: m.tipos });
}

/* POST /api/member/logout — encerra a sessão no KV compartilhado (logout unificado) */
export async function sairMembro(request, env) {
  const sid = lerCookie(request, COOKIE_MEMBRO);
  if (sid) await env.KV.delete(`${PREFIXO.membro}:${sid}`);
  return json({ ok: true, redirect: `${env.BLOG_ORIGIN}/` }, 200, { 'Set-Cookie': apagarCookie(COOKIE_MEMBRO) });
}

/* POST /api/admin/logout */
export async function sairAdmin(request, env) {
  const sid = lerCookie(request, COOKIE_ADMIN);
  if (sid) await env.KV.delete(`${PREFIXO.admin}:${sid}`);
  return json({ ok: true, redirect: `${env.BLOG_ORIGIN}/admin-login/` }, 200, { 'Set-Cookie': apagarCookie(COOKIE_ADMIN) });
}
