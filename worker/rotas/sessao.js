// Rotas de acesso — no padrão do worker/index.js do blog UpDance.
//
// JURADOS (o "membro" do festival; login principal: e-mail + senha):
//   POST /api/member/login    → { email, password }        cria sessão (cookie m_session)
//   POST /api/member/logout   →                            encerra a sessão
//   POST /api/member/forgot   → { email }                  envia link de redefinição (resposta sempre genérica)
//   POST /api/member/reset    → { token, password }        grava a nova senha (link de 30 min, uso único)
//   POST /api/member/senha    → { atual?, nova }           troca a própria senha (obrigatória com senha provisória)
//   GET  /api/me              →                            jurado logado (ou 401)
//
// ADMIN (login SEPARADO: e-mail + senha):
//   POST /api/admin/setup     → { setup_key, email, password, nome? }  cria/redefine admin (exige ADMIN_SETUP_KEY)
//   POST /api/admin/login     → { email, password }        cria sessão (cookie a_session)
//   POST /api/admin/logout    →                            encerra a sessão
//   POST /api/admin/senha     → { atual?, nova }           troca a própria senha
//   GET  /api/admin/me        →                            admin logado (ou 401)

import { json, lerJson, ErroHttp, ipDe } from '../lib/http.js';
import { aleatorio, randomToken, sha256Hex, timingSafeEqual } from '../lib/cripto.js';
import { auditar } from '../lib/auditoria.js';
import { gerarHash, conferir, validarSenhaNova } from '../lib/senha.js';
import { enviarEmail, emailReset } from '../lib/email.js';
import { PAPEIS, autenticar, criarSessao, encerrarSessao, exigirConta } from '../lib/sessao.js';

const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutos, como no blog
const COOLDOWN_TTL = 60; // segundos entre pedidos de redefinição para o mesmo e-mail
const SETUP_MAX_FALHAS = 5;
const SETUP_JANELA = 15 * 60; // segundos
const RE_EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;

async function corpo(request) {
  return lerJson(request, 4096).catch(() => {
    throw new ErroHttp(400, 'Requisição inválida.', 'requisicao_invalida');
  });
}
const emailDe = (b) => (typeof b.email === 'string' ? b.email.trim().toLowerCase() : '');

/* ───────────────────────── login / logout / me ───────────────────────── */

function login(papel) {
  return async (request, env) => {
    const b = await corpo(request);
    const email = emailDe(b);
    let conta;
    try {
      conta = await autenticar(env, papel, email, b.password);
    } catch (err) {
      if (err.codigo === 'login_invalido' || err.codigo === 'bloqueado') {
        await auditar(env, request, { ator: 'publico', acao: `login_${papel}_falhou`, alvo: email.slice(0, 254) || null });
      }
      throw err;
    }
    await auditar(env, request, { ator: `${papel}:${conta.email}`, acao: `login_${papel}` });
    return json(
      { ok: true, nome: conta.nome, email: conta.email, trocar_senha: !!conta.trocar_senha },
      200,
      { 'Set-Cookie': await criarSessao(request, env, papel, conta) },
    );
  };
}

function logout(papel) {
  return async (request, env) => json({ ok: true }, 200, { 'Set-Cookie': await encerrarSessao(request, env, papel) });
}

function quemSouEu(papel) {
  return async (request, env) => {
    const c = await exigirConta(request, env, papel, { permitirTrocaPendente: true });
    return json({ id: c.id, nome: c.nome, email: c.email, role: PAPEIS[papel].role, trocar_senha: !!c.trocar_senha });
  };
}

/* ───────────────────────── troca da própria senha ───────────────────────── */

/** Com senha provisória, não pede a atual (já foi conferida no login). */
function trocarSenha(papel) {
  return async (request, env) => {
    const c = await exigirConta(request, env, papel, { permitirTrocaPendente: true });
    const { atual, nova } = await corpo(request);
    const tabela = PAPEIS[papel].tabela;
    const conta = await env.DB.prepare(`SELECT * FROM ${tabela} WHERE id = ?1`).bind(c.id).first();
    if (!conta.trocar_senha && !(await conferir(atual, conta))) throw new ErroHttp(422, 'Senha atual incorreta', 'senha_atual');
    validarSenhaNova(nova);
    // Sem hash extra: com a senha atual em mãos, compara direto; com senha provisória, confere o hash.
    const repetida = !conta.trocar_senha ? nova === atual : await conferir(nova, conta);
    if (repetida) throw new ErroHttp(422, 'A nova senha precisa ser diferente da atual', 'senha_repetida');

    const h = await gerarHash(nova, env);
    await env.DB.prepare(
      `UPDATE ${tabela} SET senha_hash = ?1, senha_sal = ?2, senha_iter = ?3, trocar_senha = 0, sessao_versao = sessao_versao + 1 WHERE id = ?4`,
    )
      .bind(h.senha_hash, h.senha_sal, h.senha_iter, c.id)
      .run();
    const atualizada = await env.DB.prepare(`SELECT id, email, sessao_versao FROM ${tabela} WHERE id = ?1`).bind(c.id).first();
    await encerrarSessao(request, env, papel); // a sessão antiga some do KV…
    await auditar(env, request, { ator: c.ator, acao: 'senha_trocada' });
    // …e esta aba recebe uma nova; as sessões em outros aparelhos caem (versão nova).
    return json({ ok: true }, 200, { 'Set-Cookie': await criarSessao(request, env, papel, atualizada) });
  };
}

/* ───────────────────────── jurado: recuperação de senha ───────────────────────── */

async function memberForgot(request, env) {
  const email = emailDe(await corpo(request));
  if (!RE_EMAIL.test(email)) throw new ErroHttp(400, 'Informe um e-mail válido.', 'email_invalido');
  const generica = json({ ok: true }); // nunca revela se o e-mail existe

  const chaveCd = `fest:cd:${email}`;
  if (await env.KV.get(chaveCd)) return generica;
  await env.KV.put(chaveCd, '1', { expirationTtl: COOLDOWN_TTL });

  const j = await env.DB.prepare('SELECT id, nome, email FROM jurados WHERE email = ?1 AND ativo = 1').bind(email).first();
  if (!j) {
    await auditar(env, request, { ator: 'publico', acao: 'reset_ignorado', alvo: email });
    return generica;
  }
  const token = randomToken(32);
  await env.DB.prepare('UPDATE jurados SET reset_hash = ?1, reset_expira = ?2 WHERE id = ?3')
    .bind(await sha256Hex(token), Date.now() + RESET_TTL_MS, j.id)
    .run();
  const link = `${new URL(request.url).origin}/reset-senha/?token=${token}`;
  const r = await enviarEmail(env, j.email, 'Redefinir sua senha — UpDance Festival', emailReset(link, j.nome));
  await auditar(env, request, { ator: 'publico', acao: r.ok ? 'reset_enviado' : 'reset_erro', alvo: j.email, detalhes: r.error ? { erro: r.error } : null });
  return generica;
}

async function memberReset(request, env) {
  const b = await corpo(request);
  const token = typeof b.token === 'string' ? b.token.trim() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) throw new ErroHttp(400, 'Link inválido.', 'token_invalido');
  validarSenhaNova(b.password);

  const j = await env.DB.prepare('SELECT id, email, reset_expira FROM jurados WHERE reset_hash = ?1').bind(await sha256Hex(token)).first();
  if (!j) throw new ErroHttp(400, 'Link inválido ou já usado.', 'token_invalido');
  if (!j.reset_expira || j.reset_expira < Date.now()) {
    await env.DB.prepare('UPDATE jurados SET reset_hash = NULL, reset_expira = NULL WHERE id = ?1').bind(j.id).run();
    throw new ErroHttp(400, 'Link expirado. Solicite outro.', 'token_expirado');
  }
  const h = await gerarHash(b.password, env);
  await env.DB.prepare(
    `UPDATE jurados SET senha_hash = ?1, senha_sal = ?2, senha_iter = ?3, trocar_senha = 0, sessao_versao = sessao_versao + 1,
                        reset_hash = NULL, reset_expira = NULL, tentativas_falhas = 0, bloqueado_ate = 0 WHERE id = ?4`,
  )
    .bind(h.senha_hash, h.senha_sal, h.senha_iter, j.id)
    .run();
  await auditar(env, request, { ator: `jurado:${j.email}`, acao: 'reset_concluido' });
  return json({ ok: true });
}

/* ───────────────────────── admin: setup ───────────────────────── */

/**
 * Cria ou redefine um administrador com a chave ADMIN_SETUP_KEY (segredo), como no blog.
 * Usado para o primeiro acesso e para recuperar o acesso se todos os admins perderem a senha.
 * Limite: 5 chaves erradas por IP a cada 15 min.
 */
async function adminSetup(request, env) {
  const ip = ipDe(request);
  const chaveFalhas = `fest:setupfail:${ip}`;
  const falhas = Number((await env.KV.get(chaveFalhas)) || 0);
  if (falhas >= SETUP_MAX_FALHAS) throw new ErroHttp(429, 'Muitas tentativas. Tente de novo em 15 minutos.', 'bloqueado');

  const b = await corpo(request);
  if (!env.ADMIN_SETUP_KEY || !timingSafeEqual(String(b.setup_key || ''), env.ADMIN_SETUP_KEY)) {
    await env.KV.put(chaveFalhas, String(falhas + 1), { expirationTtl: SETUP_JANELA });
    await auditar(env, request, { ator: 'publico', acao: 'admin_setup_negado' });
    throw new ErroHttp(403, 'Chave de setup inválida.', 'setup_negado');
  }
  const email = emailDe(b);
  if (!RE_EMAIL.test(email)) throw new ErroHttp(400, 'E-mail inválido.', 'email_invalido');
  const password = b.password;
  if (typeof password !== 'string' || password.length < 10) throw new ErroHttp(400, 'Senha de admin: mínimo 10 caracteres.', 'senha_curta');
  validarSenhaNova(password);
  const nome = (typeof b.nome === 'string' && b.nome.trim().slice(0, 120)) || 'Administrador';

  const h = await gerarHash(password, env);
  const existe = await env.DB.prepare('SELECT id FROM admins WHERE email = ?1').bind(email).first();
  if (existe) {
    await env.DB.prepare(
      `UPDATE admins SET senha_hash = ?1, senha_sal = ?2, senha_iter = ?3, trocar_senha = 0, ativo = 1,
                         sessao_versao = sessao_versao + 1, tentativas_falhas = 0, bloqueado_ate = 0 WHERE id = ?4`,
    )
      .bind(h.senha_hash, h.senha_sal, h.senha_iter, existe.id)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO admins (id, nome, email, senha_hash, senha_sal, senha_iter, trocar_senha, criado_por, criado_em)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'setup', ?7)`,
    )
      .bind(aleatorio(12), nome, email, h.senha_hash, h.senha_sal, h.senha_iter, Date.now())
      .run();
  }
  await env.KV.delete(chaveFalhas);
  await auditar(env, request, { ator: 'setup', acao: existe ? 'admin_setup_redefinido' : 'admin_setup_criado', alvo: email });
  return json({ ok: true, criado: !existe });
}

/* ───────────────────────── exportações ───────────────────────── */

export const memberLogin = login('jurado');
export const memberLogout = logout('jurado');
export const memberSenha = trocarSenha('jurado');
export const memberMe = quemSouEu('jurado');
export { memberForgot, memberReset };

export const adminLogin = login('admin');
export const adminLogout = logout('admin');
export const adminSenha = trocarSenha('admin');
export const adminMe = quemSouEu('admin');
export { adminSetup };
