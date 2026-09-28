// Sessões no padrão do worker do blog UpDance (worker/index.js do ecossistema):
//   • sid aleatório de 32 bytes guardado no KV com TTL;
//   • cookies SEPARADOS por papel: m_session (jurado = "membro" do festival) e a_session (admin);
//   • HttpOnly + Secure + SameSite=Lax.
//
// Diferenças deliberadas, para o festival:
//   • as chaves do KV têm o prefixo "fest:" → se este KV for o mesmo do blog, uma sessão do
//     festival nunca vale como sessão do blog (e vice-versa);
//   • a cada requisição a conta é conferida no D1 (ativa + mesma sessao_versao): trocar ou
//     redefinir a senha e desativar a conta derrubam todas as sessões na hora, sem varrer o KV.

import { ErroHttp, ipDe } from './http.js';
import { randomToken } from './cripto.js';
import { conferir, conferirFicticio } from './senha.js';

export const PAPEIS = {
  jurado: { tabela: 'jurados', cookie: 'm_session', prefixo: 'fest:msess', ttl: 60 * 60 * 24 * 7, role: 'member', extras: '' },
  // nivel: 'geral' (organização, vê tudo) ou 'responsavel' (só os eventos em evento_responsaveis)
  admin: { tabela: 'admins', cookie: 'a_session', prefixo: 'fest:asess', ttl: 60 * 60 * 12, role: 'admin', extras: ', nivel' },
};

export const MAX_FALHAS = 5;
export const BLOQUEIO_MS = 15 * 60 * 1000;

export function readCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

/** Mesmo formato do blog; o Secure só sai em http://localhost (desenvolvimento). */
export function cookie(request, name, value, maxAge) {
  const p = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (new URL(request.url).protocol === 'https:') p.push('Secure');
  if (maxAge !== undefined) p.push(`Max-Age=${maxAge}`);
  return p.join('; ');
}

/** Cria a sessão no KV e devolve o Set-Cookie. */
export async function criarSessao(request, env, papel, conta) {
  const p = PAPEIS[papel];
  const sid = randomToken(32);
  const dados = { id: conta.id, email: conta.email, role: p.role, v: conta.sessao_versao, criado_em: Date.now() };
  await env.KV.put(`${p.prefixo}:${sid}`, JSON.stringify(dados), { expirationTtl: p.ttl });
  return cookie(request, p.cookie, sid, p.ttl);
}

/** Apaga a sessão atual do KV e devolve o Set-Cookie que limpa o cookie. */
export async function encerrarSessao(request, env, papel) {
  const p = PAPEIS[papel];
  const sid = readCookie(request, p.cookie);
  if (sid && /^[0-9a-f]{64}$/.test(sid)) await env.KV.delete(`${p.prefixo}:${sid}`);
  return cookie(request, p.cookie, '', 0);
}

async function lerSessao(env, papel, sid) {
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return null;
  const raw = await env.KV.get(`${PAPEIS[papel].prefixo}:${sid}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Conta autenticada no papel, ou null. */
export async function obterConta(request, env, papel) {
  const p = PAPEIS[papel];
  const s = await lerSessao(env, papel, readCookie(request, p.cookie));
  if (!s || s.role !== p.role) return null;
  const conta = await env.DB.prepare(`SELECT id, nome, email, trocar_senha, sessao_versao, ativo${p.extras} FROM ${p.tabela} WHERE id = ?1`)
    .bind(s.id)
    .first();
  if (!conta || !conta.ativo || conta.sessao_versao !== s.v) return null;
  return { ...conta, papel, ator: `${papel}:${conta.email}` };
}

export const getMember = (request, env) => obterConta(request, env, 'jurado');
export const getAdmin = (request, env) => obterConta(request, env, 'admin');

/**
 * Exige sessão do papel. Contas com senha provisória só podem trocar a senha
 * (permitirTrocaPendente=true nas rotas de troca e de identificação).
 */
export async function exigirConta(request, env, papel, { permitirTrocaPendente = false } = {}) {
  const c = await obterConta(request, env, papel);
  if (!c) throw new ErroHttp(401, papel === 'admin' ? 'Entre como administrador' : 'Entre com sua conta de jurado', 'sessao_invalida');
  if (c.trocar_senha && !permitirTrocaPendente) throw new ErroHttp(403, 'Defina uma nova senha para continuar', 'trocar_senha');
  return c;
}

export const exigirAdmin = (request, env, opcoes) => exigirConta(request, env, 'admin', opcoes);
export const exigirJurado = (request, env, opcoes) => exigirConta(request, env, 'jurado', opcoes);

/**
 * Confere e-mail e senha com bloqueio por conta (5 erros → 15 min).
 * Mensagem genérica ("E-mail ou senha incorretos.", como no blog) para não revelar quais e-mails existem.
 */
export async function autenticar(env, papel, email, senha) {
  const { tabela } = PAPEIS[papel];
  const erroGenerico = () => new ErroHttp(401, 'E-mail ou senha incorretos.', 'login_invalido');
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!e || e.length > 254 || typeof senha !== 'string' || !senha || senha.length > 128) throw erroGenerico();

  const conta = await env.DB.prepare(`SELECT * FROM ${tabela} WHERE email = ?1`).bind(e).first();
  const agora = Date.now();
  if (!conta) {
    await conferirFicticio(env);
    throw erroGenerico();
  }
  if (conta.bloqueado_ate > agora) {
    const min = Math.ceil((conta.bloqueado_ate - agora) / 60_000);
    throw new ErroHttp(429, `Muitas tentativas erradas. Tente de novo em ${min} min ou peça ajuda à organização.`, 'bloqueado');
  }
  if (!(await conferir(senha, conta))) {
    const falhas = conta.tentativas_falhas + 1;
    const bloquear = falhas >= MAX_FALHAS;
    await env.DB.prepare(`UPDATE ${tabela} SET tentativas_falhas = ?1, bloqueado_ate = ?2 WHERE id = ?3`)
      .bind(bloquear ? 0 : falhas, bloquear ? agora + BLOQUEIO_MS : conta.bloqueado_ate, conta.id)
      .run();
    throw erroGenerico();
  }
  if (!conta.ativo) throw new ErroHttp(403, 'Conta desativada. Fale com a organização.', 'conta_desativada');
  await env.DB.prepare(`UPDATE ${tabela} SET tentativas_falhas = 0, bloqueado_ate = 0, ultimo_acesso = ?1 WHERE id = ?2`)
    .bind(agora, conta.id)
    .run();
  return conta;
}

export { ipDe };
