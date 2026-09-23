// Sessões do ecossistema UpDance.
//
// O login acontece no worker do blog (blog.updance.workers.dev). As sessões ficam no
// KV COMPARTILHADO entre os workers do ecossistema:
//   membro → cookie m_session  → KV msess:<sid>  (JSON com email e type/types)
//   admin  → cookie a_session  → KV asess:<sid>
//
// Como *.workers.dev está na Public Suffix List, cookies não atravessam subdomínios.
// O festival recebe a sessão pela mesma ponte já usada pelo app.updance:
//   festival → blog /api/session/bridge?next=… → (KV handoff:<tok>, 60 s, uso único)
//            → festival /api/session/adopt?t=… → Set-Cookie host-only no festival.

import { ErroHttp } from './http.js';

export const COOKIE_MEMBRO = 'm_session';
export const COOKIE_ADMIN = 'a_session';
const PREFIXO = { membro: 'msess', admin: 'asess' };
const RE_SID = /^[A-Za-z0-9._~-]{8,256}$/;

export function lerCookie(request, nome) {
  const cabecalho = request.headers.get('Cookie') || '';
  for (const parte of cabecalho.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nome) {
      try {
        return decodeURIComponent(parte.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Mesmo formato do helper cookie() do ecossistema: host-only, HttpOnly, Secure, SameSite=Lax. */
export function cookie(nome, valor, maxAge) {
  return `${nome}=${encodeURIComponent(valor)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function apagarCookie(nome) {
  return `${nome}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Lê msess:/asess:<sid> do KV compartilhado. Aceita expiração em segundos ou milissegundos, se houver. */
export async function lerSessao(env, prefixo, sid) {
  if (!sid || !RE_SID.test(sid)) return null;
  const bruto = await env.KV.get(`${prefixo}:${sid}`);
  if (!bruto) return null;
  let s;
  try {
    s = JSON.parse(bruto);
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object') return null;
  const exp = Number(s.exp ?? s.expira_em ?? s.expires ?? 0);
  if (exp) {
    const ms = exp < 1e12 ? exp * 1000 : exp;
    if (ms < Date.now()) return null;
  }
  return s;
}

/** Tipos do membro: aceita o formato atual (types: []) e o anterior (type: ''). Usados sem normalização. */
function tiposDe(s) {
  const t = Array.isArray(s.types) ? s.types : s.type ? [s.type] : [];
  return t.filter((x) => typeof x === 'string' && x);
}

export async function obterMembro(request, env) {
  const sid = lerCookie(request, COOKIE_MEMBRO);
  const s = await lerSessao(env, PREFIXO.membro, sid);
  if (!s || typeof s.email !== 'string' || !s.email.includes('@')) return null;
  return { sid, email: s.email.trim().toLowerCase(), tipos: tiposDe(s) };
}

export async function obterAdmin(request, env) {
  const sid = lerCookie(request, COOKIE_ADMIN);
  const s = await lerSessao(env, PREFIXO.admin, sid);
  if (!s) return null;
  if (s.role && s.role !== 'admin') return null;
  const email = typeof s.email === 'string' ? s.email.trim().toLowerCase() : 'admin';
  return { sid, email, ator: `admin:${email}` };
}

export async function exigirMembro(request, env) {
  const m = await obterMembro(request, env);
  if (!m) throw new ErroHttp(401, 'Entre com sua conta UpDance', 'sessao_invalida');
  return m;
}

export async function exigirAdmin(request, env) {
  const a = await obterAdmin(request, env);
  if (!a) throw new ErroHttp(401, 'Acesso restrito aos administradores UpDance', 'admin_negado');
  return a;
}

/** URL da ponte de sessão no blog. tipo: "membro" | "admin". */
export function urlPonte(env, next, tipo = 'membro') {
  const u = new URL('/api/session/bridge', env.BLOG_ORIGIN);
  u.searchParams.set('next', next);
  if (tipo === 'admin') u.searchParams.set('tipo', 'admin');
  return u.toString();
}

export { PREFIXO };
