// Área de administração do UpDance Festival. Todas as rotas exigem sessão de admin (cookie a_session).

import { json, lerJson, lerTexto, ErroHttp, disposicao, CABECALHOS_SEGURANCA } from '../lib/http.js';
import { exigirAdmin } from '../lib/sessao.js';
import { aleatorio, sha256Hex } from '../lib/cripto.js';
import { gerarHash, gerarSenhaProvisoria } from '../lib/senha.js';
import { auditar } from '../lib/auditoria.js';
import { servirAudio } from '../lib/midia.js';
import { chaveTrecho } from './jurado.js';

const OFFSET_BRASILIA = '-03:00'; // Brasil sem horário de verão desde 2019
const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/* ------------------------------ utilidades ------------------------------ */

function texto(v, max, obrigatorio = true) {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  if (obrigatorio && !s) throw new ErroHttp(422, 'Campo obrigatório ausente', 'campo_ausente');
  if (s.length > max) throw new ErroHttp(422, `Texto maior que ${max} caracteres`, 'texto_longo');
  return s;
}

function email(v) {
  const e = texto(v, 254).toLowerCase();
  if (!RE_EMAIL.test(e)) throw new ErroHttp(422, 'E-mail inválido', 'email_invalido');
  return e;
}

function dataHora(v, padrao) {
  if (v == null || v === '') return padrao;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new ErroHttp(422, `Data/hora inválida: ${v}`, 'data_invalida');
  return ms;
}

/** Chave de comparação de nomes de grupo: sem acento, minúsculas, espaços simples. */
export function chaveNome(nome) {
  return String(nome || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function umOu404(env, sql, id, rotulo) {
  const r = await env.DB.prepare(sql).bind(id).first();
  if (!r) throw new ErroHttp(404, `${rotulo} não encontrado(a)`, 'nao_encontrado');
  return r;
}
const eventoOu404 = (env, id) => umOu404(env, 'SELECT * FROM eventos WHERE id = ?1', id, 'Evento');

/** Resposta com senha provisória (mostrada uma única vez). */
function comSenha(dados, senha, status = 200) {
  return json({ ...dados, senha_provisoria: senha }, status);
}

/* ================================ ADMINS ================================ */

/* GET /api/admin/admins */
export async function listarAdmins(request, env) {
  await exigirAdmin(request, env);
  const { results } = await env.DB.prepare(
    'SELECT id, nome, email, ativo, trocar_senha, bloqueado_ate, ultimo_acesso, criado_em FROM admins ORDER BY nome',
  ).all();
  return json(results);
}

/* POST /api/admin/admins  { nome, email } */
export async function criarAdmin(request, env) {
  const a = await exigirAdmin(request, env);
  const b = await lerJson(request);
  const nome = texto(b.nome, 120);
  const e = email(b.email);
  if (await env.DB.prepare('SELECT 1 FROM admins WHERE email = ?1').bind(e).first()) {
    throw new ErroHttp(409, 'Já existe um administrador com este e-mail', 'email_existente');
  }
  const senha = gerarSenhaProvisoria();
  const h = await gerarHash(senha, env);
  const id = aleatorio(12);
  await env.DB.prepare(
    `INSERT INTO admins (id, nome, email, senha_hash, senha_sal, senha_iter, trocar_senha, criado_por, criado_em)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)`,
  )
    .bind(id, nome, e, h.senha_hash, h.senha_sal, h.senha_iter, a.email, Date.now())
    .run();
  await auditar(env, request, { ator: a.ator, acao: 'admin_criado', alvo: e });
  return comSenha({ id, nome, email: e }, senha, 201);
}

/* PATCH /api/admin/admins/:id  { nome?, ativo? } */
export async function atualizarAdmin(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const alvo = await umOu404(env, 'SELECT * FROM admins WHERE id = ?1', id, 'Administrador');
  const b = await lerJson(request);
  const nome = b.nome !== undefined ? texto(b.nome, 120) : alvo.nome;
  const ativo = b.ativo !== undefined ? (b.ativo ? 1 : 0) : alvo.ativo;
  if (!ativo && alvo.ativo) {
    if (alvo.id === a.id) throw new ErroHttp(422, 'Você não pode desativar a própria conta', 'auto_desativacao');
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins WHERE ativo = 1').first();
    if (n <= 1) throw new ErroHttp(422, 'É preciso manter pelo menos um administrador ativo', 'ultimo_admin');
  }
  await env.DB.prepare(
    'UPDATE admins SET nome = ?1, ativo = ?2, sessao_versao = sessao_versao + ?3 WHERE id = ?4',
  )
    .bind(nome, ativo, ativo !== alvo.ativo ? 1 : 0, id)
    .run();
  await auditar(env, request, { ator: a.ator, acao: ativo ? 'admin_atualizado' : 'admin_desativado', alvo: alvo.email });
  return json({ ok: true, nome, ativo: !!ativo });
}

/* POST /api/admin/admins/:id/redefinir-senha — gera senha provisória e derruba sessões */
export async function redefinirSenhaAdmin(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const alvo = await umOu404(env, 'SELECT * FROM admins WHERE id = ?1', id, 'Administrador');
  if (alvo.id === a.id) throw new ErroHttp(422, 'Para a sua conta, use "Minha conta → Trocar senha"', 'auto_redefinicao');
  const senha = gerarSenhaProvisoria();
  const h = await gerarHash(senha, env);
  await env.DB.prepare(
    `UPDATE admins SET senha_hash = ?1, senha_sal = ?2, senha_iter = ?3, trocar_senha = 1, sessao_versao = sessao_versao + 1,
                       tentativas_falhas = 0, bloqueado_ate = 0 WHERE id = ?4`,
  )
    .bind(h.senha_hash, h.senha_sal, h.senha_iter, id)
    .run();
  await auditar(env, request, { ator: a.ator, acao: 'admin_senha_redefinida', alvo: alvo.email });
  return comSenha({ id, email: alvo.email }, senha);
}

/* ================================ JURADOS (contas) ================================ */

/* GET /api/admin/jurados */
export async function listarJurados(request, env) {
  await exigirAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT j.id, j.nome, j.email, j.telefone, j.ativo, j.trocar_senha, j.bloqueado_ate, j.ultimo_acesso, j.criado_em,
            (SELECT COUNT(*) FROM evento_jurados ej WHERE ej.jurado_id = j.id) AS eventos
       FROM jurados j ORDER BY j.nome`,
  ).all();
  return json(results);
}

/* POST /api/admin/jurados  { nome, email, telefone? } */
export async function criarJurado(request, env) {
  const a = await exigirAdmin(request, env);
  const b = await lerJson(request);
  const nome = texto(b.nome, 120);
  const e = email(b.email);
  const telefone = texto(b.telefone, 40, false) || null;
  if (await env.DB.prepare('SELECT 1 FROM jurados WHERE email = ?1').bind(e).first()) {
    throw new ErroHttp(409, 'Já existe um jurado com este e-mail', 'email_existente');
  }
  const senha = gerarSenhaProvisoria();
  const h = await gerarHash(senha, env);
  const id = aleatorio(12);
  await env.DB.prepare(
    `INSERT INTO jurados (id, nome, email, telefone, senha_hash, senha_sal, senha_iter, trocar_senha, criado_por, criado_em)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)`,
  )
    .bind(id, nome, e, telefone, h.senha_hash, h.senha_sal, h.senha_iter, a.email, Date.now())
    .run();
  await auditar(env, request, { ator: a.ator, acao: 'jurado_criado', alvo: e });
  return comSenha({ id, nome, email: e, link: `${new URL(request.url).origin}/` }, senha, 201);
}

/* PATCH /api/admin/jurados/:id  { nome?, telefone?, ativo? } */
export async function atualizarJurado(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const j = await umOu404(env, 'SELECT * FROM jurados WHERE id = ?1', id, 'Jurado');
  const b = await lerJson(request);
  const nome = b.nome !== undefined ? texto(b.nome, 120) : j.nome;
  const telefone = b.telefone !== undefined ? texto(b.telefone, 40, false) || null : j.telefone;
  const ativo = b.ativo !== undefined ? (b.ativo ? 1 : 0) : j.ativo;
  await env.DB.prepare('UPDATE jurados SET nome = ?1, telefone = ?2, ativo = ?3, sessao_versao = sessao_versao + ?4 WHERE id = ?5')
    .bind(nome, telefone, ativo, ativo !== j.ativo ? 1 : 0, id)
    .run();
  await auditar(env, request, { ator: a.ator, acao: ativo ? 'jurado_atualizado' : 'jurado_desativado', alvo: j.email });
  return json({ ok: true, nome, telefone, ativo: !!ativo });
}

/* POST /api/admin/jurados/:id/redefinir-senha — senha provisória, desbloqueia e derruba sessões */
export async function redefinirSenhaJurado(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const j = await umOu404(env, 'SELECT * FROM jurados WHERE id = ?1', id, 'Jurado');
  const senha = gerarSenhaProvisoria();
  const h = await gerarHash(senha, env);
  await env.DB.prepare(
    `UPDATE jurados SET senha_hash = ?1, senha_sal = ?2, senha_iter = ?3, trocar_senha = 1, sessao_versao = sessao_versao + 1,
                        tentativas_falhas = 0, bloqueado_ate = 0 WHERE id = ?4`,
  )
    .bind(h.senha_hash, h.senha_sal, h.senha_iter, id)
    .run();
  await auditar(env, request, { ator: a.ator, acao: 'jurado_senha_redefinida', alvo: j.email });
  return comSenha({ id, email: j.email }, senha);
}

/* ================================ GRUPOS ================================ */

/* GET /api/admin/grupos */
export async function listarGrupos(request, env) {
  await exigirAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT g.*, (SELECT COUNT(*) FROM coreografias c WHERE c.grupo_id = g.id) AS coreografias
       FROM grupos g ORDER BY g.nome`,
  ).all();
  return json(results);
}

function camposGrupo(b, atual = {}) {
  const pegar = (k, max) => (b[k] !== undefined ? texto(b[k], max, false) || null : atual[k] ?? null);
  const nome = b.nome !== undefined ? texto(b.nome, 160) : atual.nome;
  const em = b.email !== undefined && b.email !== '' ? email(b.email) : b.email === '' ? null : atual.email ?? null;
  return { nome, cidade: pegar('cidade', 120), responsavel: pegar('responsavel', 120), email: em, telefone: pegar('telefone', 40) };
}

/* POST /api/admin/grupos */
export async function criarGrupo(request, env) {
  const a = await exigirAdmin(request, env);
  const g = camposGrupo(await lerJson(request));
  const chave = chaveNome(g.nome);
  if (await env.DB.prepare('SELECT 1 FROM grupos WHERE nome_chave = ?1').bind(chave).first()) {
    throw new ErroHttp(409, 'Já existe um grupo com este nome', 'grupo_existente');
  }
  const id = aleatorio(12);
  await env.DB.prepare(
    'INSERT INTO grupos (id, nome, nome_chave, cidade, responsavel, email, telefone, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
  )
    .bind(id, g.nome, chave, g.cidade, g.responsavel, g.email, g.telefone, Date.now())
    .run();
  await auditar(env, request, { ator: a.ator, acao: 'grupo_criado', alvo: g.nome });
  return json({ id, ...g }, 201);
}

/* PATCH /api/admin/grupos/:id */
export async function atualizarGrupo(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const atual = await umOu404(env, 'SELECT * FROM grupos WHERE id = ?1', id, 'Grupo');
  const g = camposGrupo(await lerJson(request), atual);
  const chave = chaveNome(g.nome);
  const conflito = await env.DB.prepare('SELECT id FROM grupos WHERE nome_chave = ?1 AND id <> ?2').bind(chave, id).first();
  if (conflito) throw new ErroHttp(409, 'Já existe um grupo com este nome', 'grupo_existente');
  await env.DB.prepare('UPDATE grupos SET nome = ?1, nome_chave = ?2, cidade = ?3, responsavel = ?4, email = ?5, telefone = ?6 WHERE id = ?7')
    .bind(g.nome, chave, g.cidade, g.responsavel, g.email, g.telefone, id)
    .run();
  await auditar(env, request, { ator: a.ator, acao: 'grupo_atualizado', alvo: g.nome });
  return json({ id, ...g });
}

/* DELETE /api/admin/grupos/:id — só sem coreografias vinculadas */
export async function excluirGrupo(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const g = await umOu404(env, 'SELECT * FROM grupos WHERE id = ?1', id, 'Grupo');
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM coreografias WHERE grupo_id = ?1').bind(id).first();
  if (n) throw new ErroHttp(409, `O grupo tem ${n} coreografia(s) vinculada(s)`, 'grupo_em_uso');
  await env.DB.prepare('DELETE FROM grupos WHERE id = ?1').bind(id).run();
  await auditar(env, request, { ator: a.ator, acao: 'grupo_excluido', alvo: g.nome });
  return json({ ok: true });
}

/** Encontra o grupo pelo nome (ignorando acento/caixa) ou cria. */
async function grupoPorNome(env, nome, cache) {
  const n = texto(nome, 160, false);
  if (!n) return null;
  const chave = chaveNome(n);
  if (cache.has(chave)) return cache.get(chave);
  let g = await env.DB.prepare('SELECT id FROM grupos WHERE nome_chave = ?1').bind(chave).first();
  if (!g) {
    g = { id: aleatorio(12) };
    await env.DB.prepare('INSERT INTO grupos (id, nome, nome_chave, criado_em) VALUES (?1, ?2, ?3, ?4)').bind(g.id, n, chave, Date.now()).run();
  }
  cache.set(chave, g.id);
  return g.id;
}

/* ================================ EVENTOS ================================ */

function camposEvento(b, atual = null) {
  const nome = b.nome !== undefined || !atual ? texto(b.nome, 120) : atual.nome;
  const data = b.data !== undefined || !atual ? texto(b.data, 10) : atual.data;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new ErroHttp(422, 'Data no formato AAAA-MM-DD', 'data_invalida');
  const local = b.local !== undefined ? texto(b.local, 160, false) || null : atual?.local ?? null;
  const abre = dataHora(b.abre_em, atual?.abre_em ?? Date.parse(`${data}T00:00:00${OFFSET_BRASILIA}`));
  const fecha = dataHora(b.fecha_em, atual?.fecha_em ?? Date.parse(`${data}T23:59:59${OFFSET_BRASILIA}`));
  if (fecha <= abre) throw new ErroHttp(422, 'O encerramento deve ser depois da abertura', 'data_invalida');
  const anon = b.anonimizar_jurados !== undefined ? (b.anonimizar_jurados ? 1 : 0) : atual?.anonimizar_jurados ?? 0;
  const dur = b.duracao_max_s !== undefined ? Math.min(Math.max(Number(b.duracao_max_s) || 480, 60), 1800) : atual?.duracao_max_s ?? 480;
  return { nome, data, local, abre_em: abre, fecha_em: fecha, anonimizar_jurados: anon, duracao_max_s: dur };
}

/* POST /api/admin/eventos */
export async function criarEvento(request, env) {
  const a = await exigirAdmin(request, env);
  const ev = camposEvento(await lerJson(request));
  const id = aleatorio(12);
  await env.DB.prepare(
    `INSERT INTO eventos (id, nome, data, local, fuso, abre_em, fecha_em, anonimizar_jurados, duracao_max_s, criado_por, criado_em)
     VALUES (?1, ?2, ?3, ?4, 'America/Sao_Paulo', ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(id, ev.nome, ev.data, ev.local, ev.abre_em, ev.fecha_em, ev.anonimizar_jurados, ev.duracao_max_s, a.email, Date.now())
    .run();
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'evento_criado', alvo: id, detalhes: { nome: ev.nome } });
  return json({ id, ...ev }, 201);
}

/* PATCH /api/admin/eventos/:id */
export async function atualizarEvento(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const atual = await eventoOu404(env, id);
  const ev = camposEvento(await lerJson(request), atual);
  await env.DB.prepare(
    `UPDATE eventos SET nome = ?1, data = ?2, local = ?3, abre_em = ?4, fecha_em = ?5, anonimizar_jurados = ?6, duracao_max_s = ?7 WHERE id = ?8`,
  )
    .bind(ev.nome, ev.data, ev.local, ev.abre_em, ev.fecha_em, ev.anonimizar_jurados, ev.duracao_max_s, id)
    .run();
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'evento_atualizado', alvo: id });
  return json({ id, ...ev });
}

/* GET /api/admin/eventos */
export async function listarEventos(request, env) {
  await exigirAdmin(request, env);
  const { results } = await env.DB.prepare('SELECT * FROM eventos ORDER BY data DESC, criado_em DESC').all();
  return json(results);
}

/* GET /api/admin/eventos/:id */
export async function detalharEvento(request, env, { id }) {
  await exigirAdmin(request, env);
  const evento = await eventoOu404(env, id);
  const [coreografias, jurados] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.*, g.nome AS grupo FROM coreografias c LEFT JOIN grupos g ON g.id = c.grupo_id
        WHERE c.evento_id = ?1 ORDER BY c.numero`,
    ).bind(id),
    env.DB.prepare(
      `SELECT j.id, j.nome, j.email, j.ativo AS conta_ativa, ej.ordem, ej.ativo
         FROM evento_jurados ej JOIN jurados j ON j.id = ej.jurado_id
        WHERE ej.evento_id = ?1 ORDER BY ej.ordem`,
    ).bind(id),
  ]);
  return json({ evento, coreografias: coreografias.results, jurados: jurados.results, link_jurados: `${new URL(request.url).origin}/?evento=${id}` });
}

/* POST /api/admin/eventos/:id/jurados  { jurado_id } — escala um jurado no evento */
export async function escalarJurado(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  await eventoOu404(env, id);
  const { jurado_id } = await lerJson(request);
  const j = await umOu404(env, 'SELECT id, email, nome FROM jurados WHERE id = ?1', String(jurado_id || ''), 'Jurado');
  if (await env.DB.prepare('SELECT 1 FROM evento_jurados WHERE evento_id = ?1 AND jurado_id = ?2').bind(id, j.id).first()) {
    throw new ErroHttp(409, 'Este jurado já está escalado no evento', 'ja_escalado');
  }
  const { ordem } = await env.DB.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS ordem FROM evento_jurados WHERE evento_id = ?1').bind(id).first();
  await env.DB.prepare('INSERT INTO evento_jurados (evento_id, jurado_id, ordem, criado_em) VALUES (?1, ?2, ?3, ?4)')
    .bind(id, j.id, ordem, Date.now())
    .run();
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'jurado_escalado', alvo: j.email, detalhes: { ordem } });
  return json({ ok: true, jurado_id: j.id, ordem, link: `${new URL(request.url).origin}/?evento=${id}` }, 201);
}

/* PATCH /api/admin/eventos/:id/jurados/:jurado  { ativo } — tira/devolve o acesso ao evento */
export async function atualizarEscala(request, env, { id, jurado }) {
  const a = await exigirAdmin(request, env);
  const { ativo } = await lerJson(request);
  const r = await env.DB.prepare('UPDATE evento_jurados SET ativo = ?1 WHERE evento_id = ?2 AND jurado_id = ?3')
    .bind(ativo ? 1 : 0, id, jurado)
    .run();
  if (!r.meta.changes) throw new ErroHttp(404, 'Escala não encontrada', 'nao_encontrado');
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: ativo ? 'escala_ativada' : 'escala_suspensa', alvo: jurado });
  return json({ ok: true, ativo: !!ativo });
}

/* ================================ COREOGRAFIAS ================================ */

/** Parser de CSV simples (aceita ; ou , e campos entre aspas). */
export function lerCsv(conteudo) {
  const linhas = conteudo.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) return [];
  const sep = (linhas[0].match(/;/g) || []).length >= (linhas[0].match(/,/g) || []).length ? ';' : ',';
  const dividir = (linha) => {
    const campos = [];
    let atual = '';
    let aspas = false;
    for (let i = 0; i < linha.length; i++) {
      const c = linha[i];
      if (aspas) {
        if (c === '"' && linha[i + 1] === '"') { atual += '"'; i++; }
        else if (c === '"') aspas = false;
        else atual += c;
      } else if (c === '"') aspas = true;
      else if (c === sep) { campos.push(atual.trim()); atual = ''; }
      else atual += c;
    }
    campos.push(atual.trim());
    return campos;
  };
  const cab = dividir(linhas[0]).map((c) => c.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, ''));
  return linhas.slice(1).map((l) => {
    const v = dividir(l);
    return Object.fromEntries(cab.map((c, i) => [c, v[i] ?? '']));
  });
}

const sqlUpsertCoreografia = `INSERT INTO coreografias (id, evento_id, numero, nome, grupo_id, categoria) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  ON CONFLICT (evento_id, numero) DO UPDATE SET nome = excluded.nome, grupo_id = excluded.grupo_id, categoria = excluded.categoria`;

/* POST /api/admin/eventos/:id/coreografias
   - text/csv: numero;nome;grupo;categoria (grupos inexistentes são criados)
   - JSON: { numero, nome, grupo_id?, categoria? } (uma coreografia) */
export async function adicionarCoreografias(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  await eventoOu404(env, id);
  const ehJson = (request.headers.get('Content-Type') || '').includes('application/json');

  if (ehJson) {
    const b = await lerJson(request);
    const numero = Number.parseInt(b.numero, 10);
    if (!Number.isFinite(numero) || numero < 0) throw new ErroHttp(422, 'Número inválido', 'numero_invalido');
    const nome = texto(b.nome, 200);
    const grupoId = b.grupo_id ? (await umOu404(env, 'SELECT id FROM grupos WHERE id = ?1', String(b.grupo_id), 'Grupo')).id : null;
    await env.DB.prepare(sqlUpsertCoreografia).bind(aleatorio(12), id, numero, nome, grupoId, texto(b.categoria, 100, false) || null).run();
    await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'coreografia_salva', detalhes: { numero, nome } });
    return json({ ok: true }, 201);
  }

  const linhas = lerCsv(await lerTexto(request, 512 * 1024));
  if (!linhas.length) throw new ErroHttp(422, 'CSV vazio', 'csv_vazio');
  if (linhas.length > 2000) throw new ErroHttp(422, 'Máximo de 2000 coreografias', 'csv_grande');
  const erros = [];
  linhas.forEach((l, i) => {
    const numero = Number.parseInt(l.numero, 10);
    const nome = (l.nome || l.coreografia || '').trim();
    if (!Number.isFinite(numero) || numero < 0 || !nome || nome.length > 200) erros.push(`linha ${i + 2}: número ou nome inválido`);
  });
  if (erros.length) throw new ErroHttp(422, erros.slice(0, 20).join('; '), 'csv_invalido');

  const cache = new Map();
  const stmts = [];
  for (const l of linhas) {
    const grupoId = await grupoPorNome(env, l.grupo || l.escola || l.companhia, cache);
    stmts.push(
      env.DB.prepare(sqlUpsertCoreografia).bind(aleatorio(12), id, Number.parseInt(l.numero, 10), (l.nome || l.coreografia || '').trim(), grupoId, (l.categoria || '').slice(0, 100) || null),
    );
  }
  await env.DB.batch(stmts);
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'coreografias_importadas', detalhes: { quantidade: stmts.length, grupos: cache.size } });
  return json({ importadas: stmts.length, grupos: cache.size });
}

/* ================================ GRAVAÇÕES ================================ */

/* GET /api/admin/eventos/:id/gravacoes */
export async function listarGravacoes(request, env, { id }) {
  await exigirAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.versao, g.identificador, g.identificador_publico, g.status, g.aprovada, g.duracao_ms, g.tamanho,
            g.sha256, g.iniciado_em, g.finalizado_em, c.id AS coreografia_id, c.numero, c.nome AS coreografia,
            gr.nome AS grupo, j.nome AS jurado, (SELECT COUNT(*) FROM trechos t WHERE t.gravacao_id = g.id) AS trechos
       FROM gravacoes g
       JOIN coreografias c ON c.id = g.coreografia_id
       LEFT JOIN grupos gr ON gr.id = c.grupo_id
       JOIN jurados j ON j.id = g.jurado_id
       LEFT JOIN evento_jurados ej ON ej.evento_id = g.evento_id AND ej.jurado_id = g.jurado_id
      WHERE g.evento_id = ?1
      ORDER BY c.numero, ej.ordem, g.versao`,
  )
    .bind(id)
    .all();
  return json(results);
}

/* GET /api/admin/gravacoes/:id/audio — completo, ou reconstruído dos trechos se ainda não finalizado */
export async function ouvirGravacao(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const g = await umOu404(env, 'SELECT * FROM gravacoes WHERE id = ?1', id, 'Gravação');
  const download = new URL(request.url).searchParams.get('download') === '1';

  const range = request.headers.get('Range');
  if (!range || /^bytes=0-/.test(range)) {
    await auditar(env, request, { eventoId: g.evento_id, ator: a.ator, acao: 'audio_acessado_admin', alvo: id });
  }
  if (g.status === 'completo') {
    return servirAudio(request, env.AUDIOS, g.r2_chave, { nomeArquivo: g.identificador, tipoMime: g.mime, download });
  }

  // Recuperação: concatena os trechos já recebidos (WebM/MP4 fragmentado em ordem forma um arquivo tocável)
  const { results } = await env.DB.prepare('SELECT seq FROM trechos WHERE gravacao_id = ?1 ORDER BY seq').bind(id).all();
  if (!results.length) throw new ErroHttp(404, 'Nenhum trecho recebido ainda', 'sem_trechos');
  const { readable, writable } = new TransformStream();
  (async () => {
    const w = writable.getWriter();
    try {
      for (const t of results) {
        const obj = await env.AUDIOS.get(chaveTrecho(g, t.seq));
        if (obj) await w.write(new Uint8Array(await obj.arrayBuffer()));
      }
      await w.close();
    } catch (e) {
      await w.abort(e);
    }
  })();
  return new Response(readable, {
    headers: {
      'Content-Type': g.mime,
      'Content-Disposition': disposicao(download ? 'attachment' : 'inline', g.identificador.replace(/\.(\w+)$/, '_parcial.$1')),
      'Cache-Control': 'private, no-store',
      ...CABECALHOS_SEGURANCA,
    },
  });
}

/* POST /api/admin/gravacoes/:id/aprovar  { aprovada } */
export async function aprovarGravacao(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const { aprovada } = await lerJson(request);
  const g = await umOu404(env, 'SELECT evento_id, status FROM gravacoes WHERE id = ?1', id, 'Gravação');
  if (aprovada && g.status !== 'completo') throw new ErroHttp(422, 'Só gravações completas podem ser aprovadas', 'incompleta');
  await env.DB.prepare('UPDATE gravacoes SET aprovada = ?1, aprovada_por = ?2, aprovada_em = ?3 WHERE id = ?4')
    .bind(aprovada ? 1 : 0, a.email, Date.now(), id)
    .run();
  await auditar(env, request, { eventoId: g.evento_id, ator: a.ator, acao: aprovada ? 'gravacao_aprovada' : 'gravacao_reprovada', alvo: id });
  return json({ ok: true });
}

/* POST /api/admin/coreografias/:id/link  { dias? } — link de entrega ao participante */
export async function criarLinkEntrega(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const c = await umOu404(env, 'SELECT id, evento_id FROM coreografias WHERE id = ?1', id, 'Coreografia');
  const corpo = await lerJson(request).catch(() => ({}));
  const dias = Math.min(Math.max(Number(corpo.dias) || 30, 1), 180);
  const token = aleatorio(32);
  const expira = Date.now() + dias * 86400_000;
  await env.DB.prepare(
    'INSERT INTO links_entrega (token_hash, coreografia_id, evento_id, criado_por, criado_em, expira_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  )
    .bind(await sha256Hex(token), c.id, c.evento_id, a.email, Date.now(), expira)
    .run();
  await auditar(env, request, { eventoId: c.evento_id, ator: a.ator, acao: 'link_criado', alvo: c.id, detalhes: { dias } });
  return json({ url: `${new URL(request.url).origin}/ouvir/${token}`, expira_em: expira }, 201);
}

/* POST /api/admin/coreografias/:id/revogar-links */
export async function revogarLinks(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const c = await umOu404(env, 'SELECT evento_id FROM coreografias WHERE id = ?1', id, 'Coreografia');
  const r = await env.DB.prepare('UPDATE links_entrega SET revogado = 1 WHERE coreografia_id = ?1').bind(id).run();
  await auditar(env, request, { eventoId: c.evento_id, ator: a.ator, acao: 'links_revogados', alvo: id, detalhes: { quantidade: r.meta.changes } });
  return json({ revogados: r.meta.changes });
}

/* GET /api/admin/auditoria?evento=<id> — sem evento: ações de contas e acessos */
export async function listarAuditoria(request, env) {
  await exigirAdmin(request, env);
  const evento = new URL(request.url).searchParams.get('evento');
  const stmt = evento
    ? env.DB.prepare('SELECT * FROM auditoria WHERE evento_id = ?1 ORDER BY id DESC LIMIT 500').bind(evento)
    : env.DB.prepare('SELECT * FROM auditoria WHERE evento_id IS NULL ORDER BY id DESC LIMIT 500');
  const { results } = await stmt.all();
  return json(results);
}
