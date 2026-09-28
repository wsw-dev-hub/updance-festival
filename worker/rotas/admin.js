// Área de administração do UpDance Festival. Todas as rotas exigem sessão de admin (cookie a_session).
//
// Níveis (worker/lib/permissoes.js):
//   geral        → dashboard completo: contas (admins, jurados), grupos, todos os eventos
//   responsavel  → tela exclusiva dos SEUS eventos: dados do evento, escala, coreografias,
//                  gravações, notas, ranking, links de entrega e auditoria do evento

import { json, lerJson, lerTexto, ErroHttp, disposicao, CABECALHOS_SEGURANCA } from '../lib/http.js';
import { exigirAdmin } from '../lib/sessao.js';
import { exigirGeral, exigirEvento, exigirRegistroDoEvento } from '../lib/permissoes.js';
import { aleatorio, sha256Hex } from '../lib/cripto.js';
import { gerarHash, gerarSenhaProvisoria } from '../lib/senha.js';
import { auditar } from '../lib/auditoria.js';
import { servirAudio } from '../lib/midia.js';
import { chaveTrecho } from './jurado.js';

const OFFSET_BRASILIA = '-03:00'; // Brasil sem horário de verão desde 2019
const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const FORMACOES = ['solo', 'duo', 'trio', 'grupo'];

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

/** Chave de comparação de nomes: sem acento, minúsculas, espaços simples. */
export function chaveNome(nome) {
  return String(nome || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Formação da coreografia: aceita "solo", "duo", "trio", "grupo" (e variações como "Solo feminino",
 * "conjunto", "dupla") ou o número de integrantes (1 = solo, 2 = duo, 3 = trio, 4+ = grupo).
 */
export function formacaoDe(valor, integrantes) {
  const k = chaveNome(valor);
  if (k) {
    if (/^solo|^individual/.test(k)) return 'solo';
    if (/^duo|^dupla|^pas de deux/.test(k)) return 'duo';
    if (/^trio/.test(k)) return 'trio';
    if (/^grupo|^conjunto|^coletivo|^companhia|^cia/.test(k)) return 'grupo';
    throw new ErroHttp(422, `Formação inválida: "${valor}" (use solo, duo, trio ou grupo)`, 'formacao_invalida');
  }
  const n = Number.parseInt(integrantes, 10);
  if (Number.isFinite(n) && n > 0) return n === 1 ? 'solo' : n === 2 ? 'duo' : n === 3 ? 'trio' : 'grupo';
  return null;
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

/* ================================ ADMINS (somente geral) ================================ */

/* GET /api/admin/admins */
export async function listarAdmins(request, env) {
  await exigirGeral(request, env);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.nome, a.email, a.nivel, a.ativo, a.trocar_senha, a.bloqueado_ate, a.ultimo_acesso, a.criado_em,
            (SELECT GROUP_CONCAT(e.nome, ' · ') FROM evento_responsaveis er JOIN eventos e ON e.id = er.evento_id
              WHERE er.admin_id = a.id) AS eventos
       FROM admins a ORDER BY a.nivel, a.nome`,
  ).all();
  return json(results);
}

async function novoAdmin(env, { nome, email: e, nivel, criadoPor }) {
  const senha = gerarSenhaProvisoria();
  const h = await gerarHash(senha, env);
  const id = aleatorio(12);
  await env.DB.prepare(
    `INSERT INTO admins (id, nome, email, senha_hash, senha_sal, senha_iter, trocar_senha, criado_por, criado_em, nivel)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9)`,
  )
    .bind(id, nome, e, h.senha_hash, h.senha_sal, h.senha_iter, criadoPor, Date.now(), nivel)
    .run();
  return { id, senha };
}

/* POST /api/admin/admins  { nome, email, nivel? } */
export async function criarAdmin(request, env) {
  const a = await exigirGeral(request, env);
  const b = await lerJson(request);
  const nome = texto(b.nome, 120);
  const e = email(b.email);
  const nivel = b.nivel === 'responsavel' ? 'responsavel' : 'geral';
  if (await env.DB.prepare('SELECT 1 FROM admins WHERE email = ?1').bind(e).first()) {
    throw new ErroHttp(409, 'Já existe um administrador com este e-mail', 'email_existente');
  }
  const { id, senha } = await novoAdmin(env, { nome, email: e, nivel, criadoPor: a.email });
  await auditar(env, request, { ator: a.ator, acao: 'admin_criado', alvo: e, detalhes: { nivel } });
  return comSenha({ id, nome, email: e, nivel }, senha, 201);
}

/* PATCH /api/admin/admins/:id  { nome?, ativo?, nivel? } */
export async function atualizarAdmin(request, env, { id }) {
  const a = await exigirGeral(request, env);
  const alvo = await umOu404(env, 'SELECT * FROM admins WHERE id = ?1', id, 'Administrador');
  const b = await lerJson(request);
  const nome = b.nome !== undefined ? texto(b.nome, 120) : alvo.nome;
  const ativo = b.ativo !== undefined ? (b.ativo ? 1 : 0) : alvo.ativo;
  const nivel = b.nivel !== undefined ? (b.nivel === 'responsavel' ? 'responsavel' : 'geral') : alvo.nivel;
  const perdeGeral = alvo.nivel === 'geral' && alvo.ativo && (!ativo || nivel !== 'geral');
  if (perdeGeral) {
    if (alvo.id === a.id) throw new ErroHttp(422, 'Você não pode desativar nem rebaixar a própria conta', 'auto_desativacao');
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM admins WHERE ativo = 1 AND nivel = 'geral'").first();
    if (n <= 1) throw new ErroHttp(422, 'É preciso manter pelo menos um administrador geral ativo', 'ultimo_admin');
  }
  const mudouAcesso = ativo !== alvo.ativo || nivel !== alvo.nivel;
  await env.DB.prepare('UPDATE admins SET nome = ?1, ativo = ?2, nivel = ?3, sessao_versao = sessao_versao + ?4 WHERE id = ?5')
    .bind(nome, ativo, nivel, mudouAcesso ? 1 : 0, id)
    .run();
  await auditar(env, request, { ator: a.ator, acao: ativo ? 'admin_atualizado' : 'admin_desativado', alvo: alvo.email, detalhes: { nivel } });
  return json({ ok: true, nome, ativo: !!ativo, nivel });
}

/* POST /api/admin/admins/:id/redefinir-senha — gera senha provisória e derruba sessões */
export async function redefinirSenhaAdmin(request, env, { id }) {
  const a = await exigirGeral(request, env);
  const alvo = await umOu404(env, 'SELECT * FROM admins WHERE id = ?1', id, 'Administrador');
  if (alvo.id === a.id) throw new ErroHttp(422, 'Para a sua conta, use "Minha conta → Trocar senha"', 'auto_redefinicao');
  const senha = await redefinirConta(env, 'admins', id);
  await auditar(env, request, { ator: a.ator, acao: 'admin_senha_redefinida', alvo: alvo.email });
  return comSenha({ id, email: alvo.email }, senha);
}

async function redefinirConta(env, tabela, id) {
  const senha = gerarSenhaProvisoria();
  const h = await gerarHash(senha, env);
  await env.DB.prepare(
    `UPDATE ${tabela} SET senha_hash = ?1, senha_sal = ?2, senha_iter = ?3, trocar_senha = 1, sessao_versao = sessao_versao + 1,
                          tentativas_falhas = 0, bloqueado_ate = 0 WHERE id = ?4`,
  )
    .bind(h.senha_hash, h.senha_sal, h.senha_iter, id)
    .run();
  return senha;
}

/* ================================ JURADOS (contas) ================================ */

/* GET /api/admin/jurados  (geral) */
export async function listarJurados(request, env) {
  await exigirGeral(request, env);
  const { results } = await env.DB.prepare(
    `SELECT j.id, j.nome, j.email, j.telefone, j.ativo, j.trocar_senha, j.bloqueado_ate, j.ultimo_acesso, j.criado_em,
            (SELECT COUNT(*) FROM evento_jurados ej WHERE ej.jurado_id = j.id) AS eventos
       FROM jurados j ORDER BY j.nome`,
  ).all();
  return json(results);
}

async function novoJurado(env, { nome, email: e, telefone, criadoPor }) {
  const senha = gerarSenhaProvisoria();
  const h = await gerarHash(senha, env);
  const id = aleatorio(12);
  await env.DB.prepare(
    `INSERT INTO jurados (id, nome, email, telefone, senha_hash, senha_sal, senha_iter, trocar_senha, criado_por, criado_em)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)`,
  )
    .bind(id, nome, e, telefone, h.senha_hash, h.senha_sal, h.senha_iter, criadoPor, Date.now())
    .run();
  return { id, senha };
}

/* POST /api/admin/jurados  { nome, email, telefone? }  (geral) */
export async function criarJurado(request, env) {
  const a = await exigirGeral(request, env);
  const b = await lerJson(request);
  const nome = texto(b.nome, 120);
  const e = email(b.email);
  const telefone = texto(b.telefone, 40, false) || null;
  if (await env.DB.prepare('SELECT 1 FROM jurados WHERE email = ?1').bind(e).first()) {
    throw new ErroHttp(409, 'Já existe um jurado com este e-mail', 'email_existente');
  }
  const { id, senha } = await novoJurado(env, { nome, email: e, telefone, criadoPor: a.email });
  await auditar(env, request, { ator: a.ator, acao: 'jurado_criado', alvo: e });
  return comSenha({ id, nome, email: e, link: `${new URL(request.url).origin}/` }, senha, 201);
}

/* PATCH /api/admin/jurados/:id  { nome?, telefone?, ativo? }  (geral) */
export async function atualizarJurado(request, env, { id }) {
  const a = await exigirGeral(request, env);
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

/* POST /api/admin/jurados/:id/redefinir-senha
   Geral: qualquer jurado. Responsável: só jurados escalados em um evento dele. */
export async function redefinirSenhaJurado(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const j = await umOu404(env, 'SELECT * FROM jurados WHERE id = ?1', id, 'Jurado');
  if (a.nivel !== 'geral') {
    const ok = await env.DB.prepare(
      `SELECT 1 FROM evento_jurados ej JOIN evento_responsaveis er ON er.evento_id = ej.evento_id
        WHERE ej.jurado_id = ?1 AND er.admin_id = ?2`,
    ).bind(id, a.id).first();
    if (!ok) throw new ErroHttp(404, 'Jurado não encontrado(a)', 'nao_encontrado');
  }
  const senha = await redefinirConta(env, 'jurados', id);
  await auditar(env, request, { ator: a.ator, acao: 'jurado_senha_redefinida', alvo: j.email });
  return comSenha({ id, email: j.email }, senha);
}

/* ================================ GRUPOS ================================ */

/* GET /api/admin/grupos  (qualquer admin: usado no cadastro de coreografias) */
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

/* POST /api/admin/grupos  (qualquer admin) */
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

/* PATCH /api/admin/grupos/:id  (geral) */
export async function atualizarGrupo(request, env, { id }) {
  const a = await exigirGeral(request, env);
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

/* DELETE /api/admin/grupos/:id — só sem coreografias vinculadas (geral) */
export async function excluirGrupo(request, env, { id }) {
  const a = await exigirGeral(request, env);
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
  // Escala das notas (padrão 0 a 10, uma casa decimal)
  const num = (v, padrao) => (v === undefined || v === null || v === '' ? padrao : Number(v));
  const notaMin = num(b.nota_min, atual?.nota_min ?? 0);
  const notaMax = num(b.nota_max, atual?.nota_max ?? 10);
  const notaCasas = num(b.nota_casas, atual?.nota_casas ?? 1);
  if (![notaMin, notaMax].every(Number.isFinite) || notaMin < 0 || notaMax > 1000 || notaMin >= notaMax) {
    throw new ErroHttp(422, 'Escala de notas inválida (mínima menor que a máxima, entre 0 e 1000)', 'escala_invalida');
  }
  if (![0, 1, 2].includes(notaCasas)) throw new ErroHttp(422, 'Casas decimais da nota: 0, 1 ou 2', 'escala_invalida');
  return {
    nome, data, local, abre_em: abre, fecha_em: fecha, anonimizar_jurados: anon, duracao_max_s: dur,
    nota_min: notaMin, nota_max: notaMax, nota_casas: notaCasas,
  };
}

/* POST /api/admin/eventos  (geral) */
export async function criarEvento(request, env) {
  const a = await exigirGeral(request, env);
  const ev = camposEvento(await lerJson(request));
  const id = aleatorio(12);
  await env.DB.prepare(
    `INSERT INTO eventos (id, nome, data, local, fuso, abre_em, fecha_em, anonimizar_jurados, duracao_max_s, criado_por, criado_em,
                          nota_min, nota_max, nota_casas)
     VALUES (?1, ?2, ?3, ?4, 'America/Sao_Paulo', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  )
    .bind(id, ev.nome, ev.data, ev.local, ev.abre_em, ev.fecha_em, ev.anonimizar_jurados, ev.duracao_max_s, a.email, Date.now(),
      ev.nota_min, ev.nota_max, ev.nota_casas)
    .run();
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'evento_criado', alvo: id, detalhes: { nome: ev.nome } });
  return json({ id, ...ev }, 201);
}

/* PATCH /api/admin/eventos/:id  (geral ou responsável do evento) */
export async function atualizarEvento(request, env, { id }) {
  const a = await exigirEvento(request, env, id);
  const atual = await eventoOu404(env, id);
  const ev = camposEvento(await lerJson(request), atual);
  await env.DB.prepare(
    `UPDATE eventos SET nome = ?1, data = ?2, local = ?3, abre_em = ?4, fecha_em = ?5, anonimizar_jurados = ?6, duracao_max_s = ?7,
                        nota_min = ?8, nota_max = ?9, nota_casas = ?10 WHERE id = ?11`,
  )
    .bind(ev.nome, ev.data, ev.local, ev.abre_em, ev.fecha_em, ev.anonimizar_jurados, ev.duracao_max_s,
      ev.nota_min, ev.nota_max, ev.nota_casas, id)
    .run();
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'evento_atualizado', alvo: id });
  return json({ id, ...ev });
}

/* GET /api/admin/eventos — geral: todos; responsável: os seus. Com números para os cartões do dashboard. */
export async function listarEventos(request, env) {
  const a = await exigirAdmin(request, env);
  const filtro = a.nivel === 'geral' ? '' : 'WHERE e.id IN (SELECT evento_id FROM evento_responsaveis WHERE admin_id = ?1)';
  const stmt = env.DB.prepare(
    `SELECT e.*,
            (SELECT COUNT(*) FROM coreografias c WHERE c.evento_id = e.id) AS n_coreografias,
            (SELECT COUNT(*) FROM evento_jurados ej WHERE ej.evento_id = e.id AND ej.ativo = 1) AS n_jurados,
            (SELECT COUNT(*) FROM gravacoes g WHERE g.evento_id = e.id AND g.status = 'completo') AS n_gravacoes,
            (SELECT COUNT(*) FROM notas n JOIN evento_jurados ej ON ej.evento_id = n.evento_id AND ej.jurado_id = n.jurado_id AND ej.ativo = 1
              WHERE n.evento_id = e.id) AS n_notas,
            (SELECT GROUP_CONCAT(ad.nome, ', ') FROM evento_responsaveis er JOIN admins ad ON ad.id = er.admin_id
              WHERE er.evento_id = e.id) AS responsaveis
       FROM eventos e ${filtro}
      ORDER BY e.data DESC, e.criado_em DESC`,
  );
  const { results } = await (a.nivel === 'geral' ? stmt : stmt.bind(a.id)).all();
  return json(results);
}

/* GET /api/admin/eventos/:id */
export async function detalharEvento(request, env, { id }) {
  await exigirEvento(request, env, id);
  const evento = await eventoOu404(env, id);
  const [coreografias, jurados, responsaveis] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.*, g.nome AS grupo,
              (SELECT COUNT(*) FROM gravacoes gr WHERE gr.coreografia_id = c.id) AS n_gravacoes,
              (SELECT COUNT(*) FROM notas n WHERE n.coreografia_id = c.id) AS n_notas
         FROM coreografias c LEFT JOIN grupos g ON g.id = c.grupo_id
        WHERE c.evento_id = ?1 ORDER BY c.numero`,
    ).bind(id),
    env.DB.prepare(
      `SELECT j.id, j.nome, j.email, j.ativo AS conta_ativa, j.trocar_senha, j.ultimo_acesso, ej.ordem, ej.ativo
         FROM evento_jurados ej JOIN jurados j ON j.id = ej.jurado_id
        WHERE ej.evento_id = ?1 ORDER BY ej.ordem`,
    ).bind(id),
    env.DB.prepare(
      `SELECT a.id, a.nome, a.email, a.ativo, a.trocar_senha, a.ultimo_acesso
         FROM evento_responsaveis er JOIN admins a ON a.id = er.admin_id
        WHERE er.evento_id = ?1 ORDER BY a.nome`,
    ).bind(id),
  ]);
  return json({
    evento,
    coreografias: coreografias.results,
    jurados: jurados.results,
    responsaveis: responsaveis.results,
    link_jurados: `${new URL(request.url).origin}/?evento=${id}`,
  });
}

/* POST /api/admin/eventos/:id/jurados
   { jurado_id }                  → escala um jurado já cadastrado (somente geral)
   { nome, email, telefone? }     → escala pelo e-mail; se a conta não existir, cria com senha provisória */
export async function escalarJurado(request, env, { id }) {
  const a = await exigirEvento(request, env, id);
  await eventoOu404(env, id);
  const b = await lerJson(request);
  let j;
  let senha = null;
  if (b.jurado_id) {
    if (a.nivel !== 'geral') throw new ErroHttp(403, 'Informe nome e e-mail do jurado', 'somente_geral');
    j = await umOu404(env, 'SELECT id, email, nome, ativo FROM jurados WHERE id = ?1', String(b.jurado_id), 'Jurado');
  } else {
    const e = email(b.email);
    j = await env.DB.prepare('SELECT id, email, nome, ativo FROM jurados WHERE email = ?1').bind(e).first();
    if (!j) {
      const nome = texto(b.nome, 120);
      const criado = await novoJurado(env, { nome, email: e, telefone: texto(b.telefone, 40, false) || null, criadoPor: a.email });
      j = { id: criado.id, email: e, nome, ativo: 1 };
      senha = criado.senha;
      await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'jurado_criado', alvo: e });
    }
  }
  if (!j.ativo) throw new ErroHttp(422, 'Esta conta de jurado está desativada. Peça à organização para reativá-la.', 'conta_desativada');
  if (await env.DB.prepare('SELECT 1 FROM evento_jurados WHERE evento_id = ?1 AND jurado_id = ?2').bind(id, j.id).first()) {
    throw new ErroHttp(409, 'Este jurado já está escalado no evento', 'ja_escalado');
  }
  const { ordem } = await env.DB.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS ordem FROM evento_jurados WHERE evento_id = ?1').bind(id).first();
  await env.DB.prepare('INSERT INTO evento_jurados (evento_id, jurado_id, ordem, criado_em) VALUES (?1, ?2, ?3, ?4)')
    .bind(id, j.id, ordem, Date.now())
    .run();
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'jurado_escalado', alvo: j.email, detalhes: { ordem } });
  const resp = { ok: true, jurado_id: j.id, nome: j.nome, email: j.email, ordem, criado: !!senha, link: `${new URL(request.url).origin}/?evento=${id}` };
  return senha ? comSenha(resp, senha, 201) : json(resp, 201);
}

/* PATCH /api/admin/eventos/:id/jurados/:jurado  { ativo } — tira/devolve o acesso ao evento */
export async function atualizarEscala(request, env, { id, jurado }) {
  const a = await exigirEvento(request, env, id);
  const { ativo } = await lerJson(request);
  const r = await env.DB.prepare('UPDATE evento_jurados SET ativo = ?1 WHERE evento_id = ?2 AND jurado_id = ?3')
    .bind(ativo ? 1 : 0, id, jurado)
    .run();
  if (!r.meta.changes) throw new ErroHttp(404, 'Escala não encontrada', 'nao_encontrado');
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: ativo ? 'escala_ativada' : 'escala_suspensa', alvo: jurado });
  return json({ ok: true, ativo: !!ativo });
}

/* ------------------------------ responsáveis do evento (geral) ------------------------------ */

/* POST /api/admin/eventos/:id/responsaveis  { nome, email }
   Liga um responsável ao evento. Se o e-mail não tiver conta, cria (nível "responsavel", senha provisória). */
export async function adicionarResponsavel(request, env, { id }) {
  const a = await exigirGeral(request, env);
  await eventoOu404(env, id);
  const b = await lerJson(request);
  const e = email(b.email);
  let alvo = await env.DB.prepare('SELECT id, nome, email, nivel FROM admins WHERE email = ?1').bind(e).first();
  let senha = null;
  if (alvo?.nivel === 'geral') throw new ErroHttp(409, 'Este e-mail é de um administrador geral (já acessa todos os eventos)', 'ja_geral');
  if (!alvo) {
    const nome = texto(b.nome, 120);
    const criado = await novoAdmin(env, { nome, email: e, nivel: 'responsavel', criadoPor: a.email });
    alvo = { id: criado.id, nome, email: e };
    senha = criado.senha;
    await auditar(env, request, { ator: a.ator, acao: 'admin_criado', alvo: e, detalhes: { nivel: 'responsavel' } });
  }
  const r = await env.DB.prepare('INSERT OR IGNORE INTO evento_responsaveis (evento_id, admin_id, criado_por, criado_em) VALUES (?1, ?2, ?3, ?4)')
    .bind(id, alvo.id, a.email, Date.now())
    .run();
  if (!r.meta.changes) throw new ErroHttp(409, 'Esta pessoa já é responsável pelo evento', 'ja_responsavel');
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'responsavel_adicionado', alvo: e });
  const resp = { ok: true, id: alvo.id, nome: alvo.nome, email: e, criado: !!senha, link: `${new URL(request.url).origin}/admin-login/` };
  return senha ? comSenha(resp, senha, 201) : json(resp, 201);
}

/* DELETE /api/admin/eventos/:id/responsaveis/:admin */
export async function removerResponsavel(request, env, { id, admin }) {
  const a = await exigirGeral(request, env);
  const r = await env.DB.prepare('DELETE FROM evento_responsaveis WHERE evento_id = ?1 AND admin_id = ?2').bind(id, admin).run();
  if (!r.meta.changes) throw new ErroHttp(404, 'Responsável não encontrado', 'nao_encontrado');
  await env.DB.prepare('UPDATE admins SET sessao_versao = sessao_versao + 1 WHERE id = ?1').bind(admin).run();
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'responsavel_removido', alvo: admin });
  return json({ ok: true });
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

const sqlUpsertCoreografia = `INSERT INTO coreografias (id, evento_id, numero, nome, grupo_id, categoria, formacao) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  ON CONFLICT (evento_id, numero) DO UPDATE SET nome = excluded.nome, grupo_id = excluded.grupo_id, categoria = excluded.categoria,
                                               formacao = excluded.formacao`;

/* POST /api/admin/eventos/:id/coreografias
   - text/csv: numero;nome;grupo;categoria;formacao  (ou "integrantes" no lugar de formacao; grupos inexistentes são criados)
   - JSON: { numero, nome, grupo_id?, categoria?, formacao? } (uma coreografia; mesmo número = atualiza) */
export async function adicionarCoreografias(request, env, { id }) {
  const a = await exigirEvento(request, env, id);
  await eventoOu404(env, id);
  const ehJson = (request.headers.get('Content-Type') || '').includes('application/json');

  if (ehJson) {
    const b = await lerJson(request);
    const numero = Number.parseInt(b.numero, 10);
    if (!Number.isFinite(numero) || numero < 0) throw new ErroHttp(422, 'Número inválido', 'numero_invalido');
    const nome = texto(b.nome, 200);
    const grupoId = b.grupo_id ? (await umOu404(env, 'SELECT id FROM grupos WHERE id = ?1', String(b.grupo_id), 'Grupo')).id : null;
    const formacao = formacaoDe(b.formacao, b.integrantes);
    await env.DB.prepare(sqlUpsertCoreografia).bind(aleatorio(12), id, numero, nome, grupoId, texto(b.categoria, 100, false) || null, formacao).run();
    await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'coreografia_salva', detalhes: { numero, nome, formacao } });
    return json({ ok: true }, 201);
  }

  const linhas = lerCsv(await lerTexto(request, 512 * 1024));
  if (!linhas.length) throw new ErroHttp(422, 'CSV vazio', 'csv_vazio');
  if (linhas.length > 2000) throw new ErroHttp(422, 'Máximo de 2000 coreografias', 'csv_grande');
  const erros = [];
  const formacoes = linhas.map((l, i) => {
    const numero = Number.parseInt(l.numero, 10);
    const nome = (l.nome || l.coreografia || '').trim();
    if (!Number.isFinite(numero) || numero < 0 || !nome || nome.length > 200) erros.push(`linha ${i + 2}: número ou nome inválido`);
    try {
      return formacaoDe(l.formacao || l.modalidade_formacao, l.integrantes || l.bailarinos);
    } catch (e) {
      erros.push(`linha ${i + 2}: ${e.message}`);
      return null;
    }
  });
  if (erros.length) throw new ErroHttp(422, erros.slice(0, 20).join('; '), 'csv_invalido');

  const cache = new Map();
  const stmts = [];
  for (const [i, l] of linhas.entries()) {
    const grupoId = await grupoPorNome(env, l.grupo || l.escola || l.companhia, cache);
    stmts.push(
      env.DB.prepare(sqlUpsertCoreografia).bind(aleatorio(12), id, Number.parseInt(l.numero, 10), (l.nome || l.coreografia || '').trim(),
        grupoId, (l.categoria || '').slice(0, 100) || null, formacoes[i]),
    );
  }
  await env.DB.batch(stmts);
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'coreografias_importadas', detalhes: { quantidade: stmts.length, grupos: cache.size } });
  return json({ importadas: stmts.length, grupos: cache.size, sem_formacao: formacoes.filter((f) => !f).length });
}

/* DELETE /api/admin/coreografias/:id — só sem gravações, notas nem links */
export async function excluirCoreografia(request, env, { id }) {
  const { a, linha: c } = await exigirRegistroDoEvento(request, env, 'SELECT * FROM coreografias WHERE id = ?1', id, 'Coreografia');
  const uso = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM gravacoes WHERE coreografia_id = ?1) + (SELECT COUNT(*) FROM notas WHERE coreografia_id = ?1)
          + (SELECT COUNT(*) FROM links_entrega WHERE coreografia_id = ?1) AS n`,
  ).bind(id).first();
  if (uso.n) throw new ErroHttp(409, 'A coreografia já tem gravações, notas ou links; não pode ser excluída', 'coreografia_em_uso');
  await env.DB.prepare('DELETE FROM coreografias WHERE id = ?1').bind(id).run();
  await auditar(env, request, { eventoId: c.evento_id, ator: a.ator, acao: 'coreografia_excluida', detalhes: { numero: c.numero, nome: c.nome } });
  return json({ ok: true });
}

/* ================================ NOTAS E MÉDIAS ================================ */

/* GET /api/admin/eventos/:id/notas
   Quadro do evento: coreografias × jurados, com a nota de cada jurado, o status do áudio dele
   e a média calculada (só jurados com a escala ativa entram na média). O ranking é montado a partir daqui. */
export async function quadroNotas(request, env, { id }) {
  await exigirEvento(request, env, id);
  const evento = await eventoOu404(env, id);
  const [jur, cor, not, gra] = await env.DB.batch([
    env.DB.prepare(
      `SELECT j.id, j.nome, ej.ordem, ej.ativo FROM evento_jurados ej JOIN jurados j ON j.id = ej.jurado_id
        WHERE ej.evento_id = ?1 ORDER BY ej.ordem`,
    ).bind(id),
    env.DB.prepare(
      `SELECT c.id, c.numero, c.nome, c.categoria, c.formacao, g.nome AS grupo
         FROM coreografias c LEFT JOIN grupos g ON g.id = c.grupo_id WHERE c.evento_id = ?1 ORDER BY c.numero`,
    ).bind(id),
    env.DB.prepare('SELECT coreografia_id, jurado_id, nota, atualizado_em FROM notas WHERE evento_id = ?1').bind(id),
    // última versão de cada jurado em cada coreografia
    env.DB.prepare(
      `SELECT g.id, g.coreografia_id, g.jurado_id, g.status, g.aprovada, g.versao, g.duracao_ms
         FROM gravacoes g
        WHERE g.evento_id = ?1
          AND g.versao = (SELECT MAX(v.versao) FROM gravacoes v WHERE v.coreografia_id = g.coreografia_id AND v.jurado_id = g.jurado_id)`,
    ).bind(id),
  ]);
  const ativos = new Set(jur.results.filter((j) => j.ativo).map((j) => j.id));
  const notas = new Map();
  for (const n of not.results) (notas.get(n.coreografia_id) || notas.set(n.coreografia_id, {}).get(n.coreografia_id))[n.jurado_id] = n.nota;
  const audios = new Map();
  for (const g of gra.results) {
    (audios.get(g.coreografia_id) || audios.set(g.coreografia_id, {}).get(g.coreografia_id))[g.jurado_id] = {
      gravacao_id: g.id, status: g.aprovada ? 'aprovado' : g.status, versao: g.versao, duracao_ms: g.duracao_ms,
    };
  }
  let lancadas = 0;
  const coreografias = cor.results.map((c) => {
    const n = notas.get(c.id) || {};
    const validas = Object.entries(n).filter(([j]) => ativos.has(j)).map(([, v]) => v);
    lancadas += validas.length;
    const media = validas.length ? Math.round((validas.reduce((s, v) => s + v, 0) / validas.length) * 10000) / 10000 : null;
    return { ...c, notas: n, audios: audios.get(c.id) || {}, media, qtd_notas: validas.length };
  });
  return json({
    evento: {
      id: evento.id, nome: evento.nome, data: evento.data, local: evento.local, abre_em: evento.abre_em, fecha_em: evento.fecha_em,
      nota_min: evento.nota_min, nota_max: evento.nota_max, nota_casas: evento.nota_casas,
    },
    jurados: jur.results,
    coreografias,
    resumo: { coreografias: coreografias.length, jurados_ativos: ativos.size, notas_lancadas: lancadas, notas_esperadas: coreografias.length * ativos.size },
    gerado_em: Date.now(),
  });
}

/* ================================ GRAVAÇÕES ================================ */

/* GET /api/admin/eventos/:id/gravacoes */
export async function listarGravacoes(request, env, { id }) {
  await exigirEvento(request, env, id);
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.versao, g.identificador, g.identificador_publico, g.status, g.aprovada, g.duracao_ms, g.tamanho,
            g.sha256, g.iniciado_em, g.finalizado_em, c.id AS coreografia_id, c.numero, c.nome AS coreografia,
            gr.nome AS grupo, j.nome AS jurado, ej.ordem AS jurado_ordem,
            (SELECT COUNT(*) FROM trechos t WHERE t.gravacao_id = g.id) AS trechos,
            (SELECT n.nota FROM notas n WHERE n.coreografia_id = g.coreografia_id AND n.jurado_id = g.jurado_id) AS nota
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
  const { a, linha: g } = await exigirRegistroDoEvento(request, env, 'SELECT * FROM gravacoes WHERE id = ?1', id, 'Gravação');
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
  const { a, linha: g } = await exigirRegistroDoEvento(request, env, 'SELECT evento_id, status FROM gravacoes WHERE id = ?1', id, 'Gravação');
  const { aprovada } = await lerJson(request);
  if (aprovada && g.status !== 'completo') throw new ErroHttp(422, 'Só gravações completas podem ser aprovadas', 'incompleta');
  await env.DB.prepare('UPDATE gravacoes SET aprovada = ?1, aprovada_por = ?2, aprovada_em = ?3 WHERE id = ?4')
    .bind(aprovada ? 1 : 0, a.email, Date.now(), id)
    .run();
  await auditar(env, request, { eventoId: g.evento_id, ator: a.ator, acao: aprovada ? 'gravacao_aprovada' : 'gravacao_reprovada', alvo: id });
  return json({ ok: true });
}

/* POST /api/admin/coreografias/:id/link  { dias? } — link de entrega ao participante */
export async function criarLinkEntrega(request, env, { id }) {
  const { a, linha: c } = await exigirRegistroDoEvento(request, env, 'SELECT id, evento_id FROM coreografias WHERE id = ?1', id, 'Coreografia');
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
  const { a, linha: c } = await exigirRegistroDoEvento(request, env, 'SELECT evento_id FROM coreografias WHERE id = ?1', id, 'Coreografia');
  const r = await env.DB.prepare('UPDATE links_entrega SET revogado = 1 WHERE coreografia_id = ?1').bind(id).run();
  await auditar(env, request, { eventoId: c.evento_id, ator: a.ator, acao: 'links_revogados', alvo: id, detalhes: { quantidade: r.meta.changes } });
  return json({ revogados: r.meta.changes });
}

/* GET /api/admin/auditoria?evento=<id> — com evento: geral ou responsável; sem evento (contas e acessos): geral */
export async function listarAuditoria(request, env) {
  const evento = new URL(request.url).searchParams.get('evento');
  if (evento) await exigirEvento(request, env, evento);
  else await exigirGeral(request, env);
  const stmt = evento
    ? env.DB.prepare('SELECT * FROM auditoria WHERE evento_id = ?1 ORDER BY id DESC LIMIT 500').bind(evento)
    : env.DB.prepare('SELECT * FROM auditoria WHERE evento_id IS NULL ORDER BY id DESC LIMIT 500');
  const { results } = await stmt.all();
  return json(results);
}

