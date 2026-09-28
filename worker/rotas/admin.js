// Área de administração do UpDance Festival. Todas as rotas exigem sessão de admin (cookie a_session).
//
// Níveis (worker/lib/permissoes.js):
//   geral        → dashboard de controle geral: visão de todos os eventos, contas (admins, jurados),
//                  grupos. Também cria eventos e acessa a tela de qualquer evento.
//   responsavel  → autonomia sobre os SEUS eventos: cria eventos (e vira responsável por eles),
//                  cadastra responsáveis, grupos/escolas, jurados e coreografias do evento,
//                  acompanha notas, ranking e áudios, gera links de entrega.

import { json, lerJson, lerTexto, ErroHttp, disposicao, CABECALHOS_SEGURANCA } from '../lib/http.js';
import { exigirAdmin } from '../lib/sessao.js';
import { exigirGeral, exigirEvento, exigirRegistroDoEvento } from '../lib/permissoes.js';
import { aleatorio, sha256Hex } from '../lib/cripto.js';
import { gerarHash, gerarSenhaProvisoria } from '../lib/senha.js';
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

export const FAIXAS = ['baby', 'infantil', 'juvenil', 'adulto', 'profissional'];

/**
 * Faixa da coreografia: baby, infantil, juvenil, adulto ou profissional
 * (aceita variações: "Baby class", "bebê", "kids", "jovem", "teen", "adultos", "sênior", "pro"…).
 */
export function faixaDe(valor) {
  const k = chaveNome(valor);
  if (!k) return null;
  if (/^(baby|bady|bebe|babies)/.test(k)) return 'baby';
  if (/^(infantil|kids|crianca)/.test(k)) return 'infantil';
  if (/^(juvenil|jovem|jovens|teen|adolescente|junior)/.test(k)) return 'juvenil';
  if (/^(adulto|senior|master)/.test(k)) return 'adulto';
  if (/^(profissiona|pro\b)/.test(k)) return 'profissional';
  throw new ErroHttp(422, `Faixa inválida: "${valor}" (use baby, infantil, juvenil, adulto ou profissional)`, 'faixa_invalida');
}

async function umOu404(env, sql, id, rotulo) {
  const r = await env.DB.prepare(sql).bind(...(Array.isArray(id) ? id : [id])).first();
  if (!r) throw new ErroHttp(404, `${rotulo} não encontrado(a)`, 'nao_encontrado');
  return r;
}
const eventoOu404 = (env, id) => umOu404(env, 'SELECT * FROM eventos WHERE id = ?1', id, 'Evento');

/** Resposta com senha provisória (mostrada uma única vez). */
function comSenha(dados, senha, status = 200) {
  return json({ ...dados, senha_provisoria: senha }, status);
}

/* ================================ DASHBOARD DE CONTROLE (somente geral) ================================ */

/* GET /api/admin/resumo — números do sistema inteiro */
export async function resumoGeral(request, env) {
  await exigirGeral(request, env);
  const agora = Date.now();
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM eventos) AS eventos,
            (SELECT COUNT(*) FROM eventos WHERE abre_em > ?1) AS eventos_em_breve,
            (SELECT COUNT(*) FROM eventos WHERE abre_em <= ?1 AND fecha_em >= ?1) AS eventos_abertos,
            (SELECT COUNT(*) FROM eventos WHERE fecha_em < ?1) AS eventos_encerrados,
            (SELECT COUNT(*) FROM eventos e WHERE NOT EXISTS (SELECT 1 FROM evento_responsaveis er WHERE er.evento_id = e.id)) AS eventos_sem_responsavel,
            (SELECT COUNT(*) FROM coreografias) AS coreografias,
            (SELECT COUNT(*) FROM grupos) AS grupos,
            (SELECT COUNT(*) FROM grupos WHERE evento_id IS NULL) AS grupos_sem_evento,
            (SELECT COUNT(*) FROM jurados) AS jurados,
            (SELECT COUNT(*) FROM jurados WHERE ativo = 1) AS jurados_ativos,
            (SELECT COUNT(*) FROM admins WHERE nivel = 'geral' AND ativo = 1) AS admins_gerais,
            (SELECT COUNT(*) FROM admins WHERE nivel = 'responsavel' AND ativo = 1) AS responsaveis,
            (SELECT COUNT(*) FROM admins WHERE bloqueado_ate > ?1) + (SELECT COUNT(*) FROM jurados WHERE bloqueado_ate > ?1) AS contas_bloqueadas,
            (SELECT COUNT(*) FROM gravacoes WHERE status = 'completo') AS audios,
            (SELECT COUNT(*) FROM gravacoes WHERE status <> 'completo') AS audios_parciais,
            (SELECT COALESCE(SUM(tamanho), 0) FROM gravacoes) AS bytes_audios,
            (SELECT COUNT(*) FROM notas) AS notas`,
  ).bind(agora).first();
  return json({ ...r, gerado_em: agora });
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
  return json({ ok: true, nome, ativo: !!ativo, nivel });
}

/* POST /api/admin/admins/:id/redefinir-senha — gera senha provisória e derruba sessões */
export async function redefinirSenhaAdmin(request, env, { id }) {
  const a = await exigirGeral(request, env);
  const alvo = await umOu404(env, 'SELECT * FROM admins WHERE id = ?1', id, 'Administrador');
  if (alvo.id === a.id) throw new ErroHttp(422, 'Para a sua conta, use "Minha conta → Trocar senha"', 'auto_redefinicao');
  const senha = await redefinirConta(env, 'admins', id);
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

/** Jurado escalado em algum evento do responsável? (geral: sempre) */
async function juradoAoAlcance(env, a, juradoId) {
  if (a.nivel === 'geral') return true;
  return !!(await env.DB.prepare(
    `SELECT 1 FROM evento_jurados ej JOIN evento_responsaveis er ON er.evento_id = ej.evento_id
      WHERE ej.jurado_id = ?1 AND er.admin_id = ?2`,
  ).bind(juradoId, a.id).first());
}

/** Responsável só altera conta (nome, senha) de quem atua APENAS em eventos dele.
    Conta compartilhada com evento de outra equipe: só a administração geral mexe
    (senão, redefinir a senha daria acesso aos eventos alheios). */
async function exigirContaExclusiva(env, a, tabelaVinculo, colunaConta, contaId) {
  if (a.nivel === 'geral') return;
  const fora = await env.DB.prepare(
    `SELECT 1 FROM ${tabelaVinculo} v
      WHERE v.${colunaConta} = ?1
        AND v.evento_id NOT IN (SELECT evento_id FROM evento_responsaveis WHERE admin_id = ?2) LIMIT 1`,
  ).bind(contaId, a.id).first();
  if (fora) {
    throw new ErroHttp(403, 'Esta pessoa também atua em evento de outra equipe. Peça à administração geral do festival.', 'conta_compartilhada');
  }
}

/* PATCH /api/admin/jurados/:id  { nome?, telefone?, ativo? }
   Responsável: nome e telefone dos jurados dos seus eventos. Desativar a conta (todos os eventos): só geral. */
export async function atualizarJurado(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const j = await umOu404(env, 'SELECT * FROM jurados WHERE id = ?1', id, 'Jurado');
  if (!(await juradoAoAlcance(env, a, id))) throw new ErroHttp(404, 'Jurado não encontrado(a)', 'nao_encontrado');
  const b = await lerJson(request);
  if (b.ativo !== undefined && a.nivel !== 'geral') {
    throw new ErroHttp(403, 'Para tirar o jurado do evento, use "Suspender" na escala', 'somente_geral');
  }
  await exigirContaExclusiva(env, a, 'evento_jurados', 'jurado_id', id);
  const nome = b.nome !== undefined ? texto(b.nome, 120) : j.nome;
  const telefone = b.telefone !== undefined ? texto(b.telefone, 40, false) || null : j.telefone;
  const ativo = b.ativo !== undefined ? (b.ativo ? 1 : 0) : j.ativo;
  await env.DB.prepare('UPDATE jurados SET nome = ?1, telefone = ?2, ativo = ?3, sessao_versao = sessao_versao + ?4 WHERE id = ?5')
    .bind(nome, telefone, ativo, ativo !== j.ativo ? 1 : 0, id)
    .run();
  return json({ ok: true, nome, telefone, ativo: !!ativo });
}

/* POST /api/admin/jurados/:id/redefinir-senha
   Geral: qualquer jurado. Responsável: só jurados escalados em um evento dele. */
export async function redefinirSenhaJurado(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const j = await umOu404(env, 'SELECT * FROM jurados WHERE id = ?1', id, 'Jurado');
  if (!(await juradoAoAlcance(env, a, id))) throw new ErroHttp(404, 'Jurado não encontrado(a)', 'nao_encontrado');
  await exigirContaExclusiva(env, a, 'evento_jurados', 'jurado_id', id);
  const senha = await redefinirConta(env, 'jurados', id);
  return comSenha({ id, email: j.email }, senha);
}

/* ================================ GRUPOS ================================ */

/** Chave única do grupo: nome sem acento/caixa DENTRO do evento ("evento|nome"). */
const chaveGrupo = (eventoId, nome) => `${eventoId}|${chaveNome(nome)}`;

/* GET /api/admin/grupos — todos os grupos, de todos os eventos (somente geral: controle) */
export async function listarGrupos(request, env) {
  await exigirGeral(request, env);
  const { results } = await env.DB.prepare(
    `SELECT g.*, e.nome AS evento, (SELECT COUNT(*) FROM coreografias c WHERE c.grupo_id = g.id) AS coreografias
       FROM grupos g LEFT JOIN eventos e ON e.id = g.evento_id ORDER BY e.data DESC, g.nome`,
  ).all();
  return json(results);
}

/* GET /api/admin/eventos/:id/grupos — grupos/escolas do evento */
export async function listarGruposEvento(request, env, { id }) {
  await exigirEvento(request, env, id);
  const { results } = await env.DB.prepare(
    `SELECT g.*, (SELECT COUNT(*) FROM coreografias c WHERE c.grupo_id = g.id) AS coreografias
       FROM grupos g WHERE g.evento_id = ?1 ORDER BY g.nome`,
  ).bind(id).all();
  return json(results);
}

/** Lista de nomes (um por linha, ou separados por ";" / ","): limpa, sem vazios nem repetidos. */
export function listaDeNomes(v, { maxNomes = 200, maxNome = 120 } = {}) {
  if (v == null) return null;
  const bruto = Array.isArray(v) ? v : String(v).split(/\r?\n|;|,/);
  const vistos = new Set();
  const nomes = [];
  for (const n of bruto) {
    const s = String(n).replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (s.length > maxNome) throw new ErroHttp(422, `Nome maior que ${maxNome} caracteres: "${s.slice(0, 30)}…"`, 'texto_longo');
    const k = chaveNome(s);
    if (vistos.has(k)) continue;
    vistos.add(k);
    nomes.push(s);
  }
  if (nomes.length > maxNomes) throw new ErroHttp(422, `Máximo de ${maxNomes} nomes por campo`, 'lista_longa');
  return nomes.length ? nomes.join('\n') : null;
}

const CAMPOS_EQUIPE = { integrantes: { maxNomes: 200 }, coreografo: { maxNomes: 10 }, diretores: { maxNomes: 20 }, coordenadores: { maxNomes: 20 } };

function camposGrupo(b, atual = {}) {
  const pegar = (k, max) => (b[k] !== undefined ? texto(b[k], max, false) || null : atual[k] ?? null);
  const nome = b.nome !== undefined ? texto(b.nome, 160) : atual.nome;
  const em = b.email !== undefined && b.email !== '' ? email(b.email) : b.email === '' ? null : atual.email ?? null;
  const equipe = Object.fromEntries(
    Object.entries(CAMPOS_EQUIPE).map(([k, lim]) => [k, b[k] !== undefined ? listaDeNomes(b[k], lim) : atual[k] ?? null]),
  );
  return { nome, cidade: pegar('cidade', 120), responsavel: pegar('responsavel', 120), email: em, telefone: pegar('telefone', 40), ...equipe };
}

/* POST /api/admin/eventos/:id/grupos — cadastra grupo/escola no evento */
export async function criarGrupo(request, env, { id: eventoId }) {
  const a = await exigirEvento(request, env, eventoId);
  await eventoOu404(env, eventoId);
  const g = camposGrupo(await lerJson(request));
  const chave = chaveGrupo(eventoId, g.nome);
  if (await env.DB.prepare('SELECT 1 FROM grupos WHERE nome_chave = ?1').bind(chave).first()) {
    throw new ErroHttp(409, 'Já existe um grupo com este nome neste evento', 'grupo_existente');
  }
  const id = aleatorio(12);
  await env.DB.prepare(
    `INSERT INTO grupos (id, nome, nome_chave, cidade, responsavel, email, telefone, criado_em, integrantes, coreografo, diretores, coordenadores, evento_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  )
    .bind(id, g.nome, chave, g.cidade, g.responsavel, g.email, g.telefone, Date.now(), g.integrantes, g.coreografo, g.diretores, g.coordenadores, eventoId)
    .run();
  return json({ id, evento_id: eventoId, ...g }, 201);
}

const sqlGrupo = 'SELECT * FROM grupos WHERE id = ?1';

/* PATCH /api/admin/grupos/:id — responsável do evento do grupo (ou geral) */
export async function atualizarGrupo(request, env, { id }) {
  const { a, linha: atual } = await exigirRegistroDoEvento(request, env, sqlGrupo, id, 'Grupo');
  const g = camposGrupo(await lerJson(request), atual);
  const chave = chaveGrupo(atual.evento_id || 'sem-evento', g.nome);
  const conflito = await env.DB.prepare('SELECT id FROM grupos WHERE nome_chave = ?1 AND id <> ?2').bind(chave, id).first();
  if (conflito) throw new ErroHttp(409, 'Já existe um grupo com este nome neste evento', 'grupo_existente');
  await env.DB.prepare(
    `UPDATE grupos SET nome = ?1, nome_chave = ?2, cidade = ?3, responsavel = ?4, email = ?5, telefone = ?6,
                       integrantes = ?7, coreografo = ?8, diretores = ?9, coordenadores = ?10 WHERE id = ?11`,
  )
    .bind(g.nome, chave, g.cidade, g.responsavel, g.email, g.telefone, g.integrantes, g.coreografo, g.diretores, g.coordenadores, id)
    .run();
  return json({ id, evento_id: atual.evento_id, ...g });
}

/* DELETE /api/admin/grupos/:id — só sem coreografias vinculadas */
export async function excluirGrupo(request, env, { id }) {
  const { a, linha: g } = await exigirRegistroDoEvento(request, env, sqlGrupo, id, 'Grupo');
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM coreografias WHERE grupo_id = ?1').bind(id).first();
  if (n) throw new ErroHttp(409, `O grupo tem ${n} coreografia(s) vinculada(s)`, 'grupo_em_uso');
  await env.DB.prepare('DELETE FROM grupos WHERE id = ?1').bind(id).run();
  return json({ ok: true });
}

/** Encontra o grupo do evento pelo nome (ignorando acento/caixa) ou cria. */
async function grupoPorNome(env, eventoId, nome, cache) {
  const n = texto(nome, 160, false);
  if (!n) return null;
  const chave = chaveGrupo(eventoId, n);
  if (cache.has(chave)) return cache.get(chave);
  let g = await env.DB.prepare('SELECT id FROM grupos WHERE nome_chave = ?1').bind(chave).first();
  if (!g) {
    g = { id: aleatorio(12) };
    await env.DB.prepare('INSERT INTO grupos (id, nome, nome_chave, criado_em, evento_id) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(g.id, n, chave, Date.now(), eventoId)
      .run();
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

/* POST /api/admin/eventos  { ...campos, responsaveis?: [{ nome, email }] }
   Geral ou responsável. Quem é responsável e cria o evento passa a ser responsável por ele.
   Contas novas de responsável voltam com senha provisória (mostrada uma única vez). */
export async function criarEvento(request, env) {
  const a = await exigirAdmin(request, env);
  const b = await lerJson(request);
  const ev = camposEvento(b);
  const pedidos = Array.isArray(b.responsaveis) ? b.responsaveis.filter((r) => r && (r.email || '').trim()) : [];
  if (pedidos.length > 10) throw new ErroHttp(422, 'Máximo de 10 responsáveis por vez', 'lista_longa');
  const emails = pedidos.map((r) => email(r.email)); // valida tudo antes de gravar
  if (new Set(emails).size !== emails.length) throw new ErroHttp(422, 'E-mail de responsável repetido', 'email_repetido');
  for (const [i, e] of emails.entries()) {
    const existente = await env.DB.prepare('SELECT nivel FROM admins WHERE email = ?1').bind(e).first();
    if (existente?.nivel === 'geral') throw new ErroHttp(409, `${e} é administrador geral (já acessa todos os eventos)`, 'ja_geral');
    if (!existente) texto(pedidos[i].nome, 120); // conta nova precisa de nome
  }
  const id = aleatorio(12);
  await env.DB.prepare(
    `INSERT INTO eventos (id, nome, data, local, fuso, abre_em, fecha_em, anonimizar_jurados, duracao_max_s, criado_por, criado_em,
                          nota_min, nota_max, nota_casas)
     VALUES (?1, ?2, ?3, ?4, 'America/Sao_Paulo', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  )
    .bind(id, ev.nome, ev.data, ev.local, ev.abre_em, ev.fecha_em, ev.anonimizar_jurados, ev.duracao_max_s, a.email, Date.now(),
      ev.nota_min, ev.nota_max, ev.nota_casas)
    .run();
  const responsaveis = [];
  if (a.nivel !== 'geral') {
    await env.DB.prepare('INSERT INTO evento_responsaveis (evento_id, admin_id, criado_por, criado_em) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, a.id, a.email, Date.now())
      .run();
    responsaveis.push({ id: a.id, nome: a.nome, email: a.email, criado: false, voce: true });
  }
  for (const r of pedidos) {
    if (email(r.email) === a.email) continue;
    responsaveis.push(await vincularResponsavel(env, request, a, id, r));
  }
  return json({ id, ...ev, responsaveis, link_login: `${new URL(request.url).origin}/admin-login/` }, 201);
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
            (SELECT COUNT(*) FROM grupos gr WHERE gr.evento_id = e.id) AS n_grupos,
            (SELECT COALESCE(SUM(g.tamanho), 0) FROM gravacoes g WHERE g.evento_id = e.id) AS bytes_audios,
            (SELECT json_group_array(json_object('id', ad.id, 'nome', ad.nome, 'email', ad.email, 'ativo', ad.ativo,
                                                 'trocar_senha', ad.trocar_senha, 'ultimo_acesso', ad.ultimo_acesso))
               FROM evento_responsaveis er JOIN admins ad ON ad.id = er.admin_id WHERE er.evento_id = e.id) AS responsaveis_json
       FROM eventos e ${filtro}
      ORDER BY e.data DESC, e.criado_em DESC`,
  );
  const { results } = await (a.nivel === 'geral' ? stmt : stmt.bind(a.id)).all();
  return json(results.map(({ responsaveis_json: rj, ...e }) => {
    const lista = JSON.parse(rj || '[]').filter((r) => r.id);
    return { ...e, responsaveis_lista: lista, responsaveis: lista.map((r) => r.nome).join(', ') };
  }));
}

/* GET /api/admin/eventos/:id */
export async function detalharEvento(request, env, { id }) {
  await exigirEvento(request, env, id);
  const evento = await eventoOu404(env, id);
  const [coreografias, jurados, responsaveis] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.*, g.nome AS grupo,
              (SELECT COUNT(*) FROM gravacoes gr WHERE gr.coreografia_id = c.id) AS n_gravacoes,
              (SELECT COUNT(*) FROM notas n WHERE n.coreografia_id = c.id) AS n_notas,
              (SELECT MAX(l.expira_em) FROM links_entrega l WHERE l.coreografia_id = c.id AND l.revogado = 0 AND l.expira_em > ?2) AS link_expira_em
         FROM coreografias c LEFT JOIN grupos g ON g.id = c.grupo_id
        WHERE c.evento_id = ?1 ORDER BY c.numero`,
    ).bind(id, Date.now()),
    env.DB.prepare(
      `SELECT j.id, j.nome, j.email, j.telefone, j.ativo AS conta_ativa, j.trocar_senha, j.ultimo_acesso, ej.ordem, ej.ativo
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
  return json({ ok: true, ativo: !!ativo });
}

/* ------------------------------ responsáveis do evento ------------------------------
   Geral ou responsável do próprio evento: cada responsável controla quem mais administra o evento. */

/** Liga (e se preciso cria) um responsável ao evento. Devolve os dados, com senha provisória se a conta é nova. */
async function vincularResponsavel(env, request, a, eventoId, { nome, email: em }) {
  const e = email(em);
  let alvo = await env.DB.prepare('SELECT id, nome, email, nivel FROM admins WHERE email = ?1').bind(e).first();
  let senha = null;
  if (alvo?.nivel === 'geral') throw new ErroHttp(409, 'Este e-mail é de um administrador geral (já acessa todos os eventos)', 'ja_geral');
  if (!alvo) {
    const n = texto(nome, 120);
    const criado = await novoAdmin(env, { nome: n, email: e, nivel: 'responsavel', criadoPor: a.email });
    alvo = { id: criado.id, nome: n, email: e };
    senha = criado.senha;
  }
  const r = await env.DB.prepare('INSERT OR IGNORE INTO evento_responsaveis (evento_id, admin_id, criado_por, criado_em) VALUES (?1, ?2, ?3, ?4)')
    .bind(eventoId, alvo.id, a.email, Date.now())
    .run();
  if (!r.meta.changes) throw new ErroHttp(409, 'Esta pessoa já é responsável pelo evento', 'ja_responsavel');
  return { id: alvo.id, nome: alvo.nome, email: e, criado: !!senha, ...(senha ? { senha_provisoria: senha } : {}) };
}

/* POST /api/admin/eventos/:id/responsaveis  { nome, email } */
export async function adicionarResponsavel(request, env, { id }) {
  const a = await exigirEvento(request, env, id);
  await eventoOu404(env, id);
  const r = await vincularResponsavel(env, request, a, id, await lerJson(request));
  return json({ ok: true, ...r, link: `${new URL(request.url).origin}/admin-login/` }, 201);
}

/* DELETE /api/admin/eventos/:id/responsaveis/:admin
   Responsável pode tirar outros (ou a si mesmo), desde que o evento continue com pelo menos um. */
export async function removerResponsavel(request, env, { id, admin }) {
  const a = await exigirEvento(request, env, id);
  if (a.nivel !== 'geral') {
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM evento_responsaveis WHERE evento_id = ?1').bind(id).first();
    if (n <= 1) throw new ErroHttp(422, 'O evento precisa de pelo menos um responsável', 'ultimo_responsavel');
  }
  const r = await env.DB.prepare('DELETE FROM evento_responsaveis WHERE evento_id = ?1 AND admin_id = ?2').bind(id, admin).run();
  if (!r.meta.changes) throw new ErroHttp(404, 'Responsável não encontrado', 'nao_encontrado');
  await env.DB.prepare('UPDATE admins SET sessao_versao = sessao_versao + 1 WHERE id = ?1').bind(admin).run();
  return json({ ok: true });
}

/* POST /api/admin/eventos/:id/responsaveis/:admin/redefinir-senha — senha provisória para outro responsável do evento */
export async function redefinirSenhaResponsavel(request, env, { id, admin }) {
  const a = await exigirEvento(request, env, id);
  const alvo = await env.DB.prepare(
    `SELECT ad.* FROM evento_responsaveis er JOIN admins ad ON ad.id = er.admin_id
      WHERE er.evento_id = ?1 AND er.admin_id = ?2 AND ad.nivel = 'responsavel'`,
  ).bind(id, admin).first();
  if (!alvo) throw new ErroHttp(404, 'Responsável não encontrado', 'nao_encontrado');
  if (alvo.id === a.id) throw new ErroHttp(422, 'Para a sua conta, use "Minha conta → Trocar senha"', 'auto_redefinicao');
  await exigirContaExclusiva(env, a, 'evento_responsaveis', 'admin_id', alvo.id);
  const senha = await redefinirConta(env, 'admins', alvo.id);
  return comSenha({ id: alvo.id, email: alvo.email }, senha);
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
  const cab = dividir(linhas[0]).map((c) => c.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().replace(/[\s-]+/g, '_'));
  return linhas.slice(1).map((l) => {
    const v = dividir(l);
    return Object.fromEntries(cab.map((c, i) => [c, v[i] ?? '']));
  });
}

const sqlUpsertCoreografia = `INSERT INTO coreografias (id, evento_id, numero, nome, grupo_id, categoria, formacao, faixa)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  ON CONFLICT (evento_id, numero) DO UPDATE SET nome = excluded.nome, grupo_id = excluded.grupo_id, categoria = excluded.categoria,
                                               formacao = excluded.formacao, faixa = excluded.faixa`;

/* POST /api/admin/eventos/:id/coreografias
   - text/csv: numero;nome;grupo;categoria;formacao;faixa  (ou "integrantes" no lugar de formacao; grupos inexistentes são criados)
   - JSON: { numero, nome, grupo_id?, categoria?, formacao?, faixa? } (uma coreografia; mesmo número = atualiza) */
export async function adicionarCoreografias(request, env, { id }) {
  const a = await exigirEvento(request, env, id);
  await eventoOu404(env, id);
  const ehJson = (request.headers.get('Content-Type') || '').includes('application/json');

  if (ehJson) {
    const b = await lerJson(request);
    const numero = Number.parseInt(b.numero, 10);
    if (!Number.isFinite(numero) || numero < 0) throw new ErroHttp(422, 'Número inválido', 'numero_invalido');
    const nome = texto(b.nome, 200);
    const grupoId = b.grupo_id
      ? (await umOu404(env, 'SELECT id FROM grupos WHERE id = ?1 AND evento_id = ?2', [String(b.grupo_id), id], 'Grupo do evento')).id
      : null;
    const formacao = formacaoDe(b.formacao, b.integrantes);
    const faixa = faixaDe(b.faixa);
    await env.DB.prepare(sqlUpsertCoreografia).bind(aleatorio(12), id, numero, nome, grupoId, texto(b.categoria, 100, false) || null, formacao, faixa).run();
    return json({ ok: true }, 201);
  }

  const linhas = lerCsv(await lerTexto(request, 512 * 1024));
  if (!linhas.length) throw new ErroHttp(422, 'CSV vazio', 'csv_vazio');
  if (linhas.length > 2000) throw new ErroHttp(422, 'Máximo de 2000 coreografias', 'csv_grande');
  const erros = [];
  const faixas = linhas.map((l, i) => {
    try {
      return faixaDe(l.faixa || l.faixa_etaria || l.nivel);
    } catch (e) {
      erros.push(`linha ${i + 2}: ${e.message}`);
      return null;
    }
  });
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
    const grupoId = await grupoPorNome(env, id, l.grupo || l.escola || l.companhia, cache);
    stmts.push(
      env.DB.prepare(sqlUpsertCoreografia).bind(aleatorio(12), id, Number.parseInt(l.numero, 10), (l.nome || l.coreografia || '').trim(),
        grupoId, (l.categoria || '').slice(0, 100) || null, formacoes[i], faixas[i]),
    );
  }
  await env.DB.batch(stmts);
  return json({ importadas: stmts.length, grupos: cache.size, sem_formacao: formacoes.filter((f) => !f).length, sem_faixa: faixas.filter((f) => !f).length });
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
  return json({ ok: true });
}

/* ================================ NOTAS E MÉDIAS ================================ */

/* GET /api/admin/eventos/:id/notas
   Quadro do evento: coreografias × jurados, com a nota de cada jurado, o status do áudio dele
   e a média calculada (só jurados com a escala ativa entram na média). O ranking é montado a partir daqui. */
export async function quadroNotas(request, env, { id }) {
  await exigirEvento(request, env, id);
  const evento = await eventoOu404(env, id);
  const [jur, cor, not, gra, fin] = await env.DB.batch([
    env.DB.prepare(
      `SELECT j.id, j.nome, ej.ordem, ej.ativo FROM evento_jurados ej JOIN jurados j ON j.id = ej.jurado_id
        WHERE ej.evento_id = ?1 ORDER BY ej.ordem`,
    ).bind(id),
    env.DB.prepare(
      `SELECT c.id, c.numero, c.nome, c.categoria, c.formacao, c.faixa, g.nome AS grupo
         FROM coreografias c LEFT JOIN grupos g ON g.id = c.grupo_id WHERE c.evento_id = ?1 ORDER BY c.numero`,
    ).bind(id),
    env.DB.prepare('SELECT coreografia_id, jurado_id, nota, atualizado_em FROM notas WHERE evento_id = ?1').bind(id),
    // última versão de cada jurado em cada coreografia
    env.DB.prepare(
      `SELECT g.id, g.coreografia_id, g.jurado_id, g.status, g.aprovada, g.versao, g.duracao_ms,
              g.identificador, g.tamanho, g.iniciado_em, g.finalizado_em
         FROM gravacoes g
        WHERE g.evento_id = ?1
          AND g.versao = (SELECT MAX(v.versao) FROM gravacoes v WHERE v.coreografia_id = g.coreografia_id AND v.jurado_id = g.jurado_id)`,
    ).bind(id),
    env.DB.prepare('SELECT coreografia_id, jurado_id, finalizado_em FROM finalizacoes WHERE evento_id = ?1').bind(id),
  ]);
  const finalizadas = new Map();
  for (const f of fin.results) {
    (finalizadas.get(f.coreografia_id) || finalizadas.set(f.coreografia_id, {}).get(f.coreografia_id))[f.jurado_id] = f.finalizado_em;
  }
  const ativos = new Set(jur.results.filter((j) => j.ativo).map((j) => j.id));
  const notas = new Map();
  for (const n of not.results) (notas.get(n.coreografia_id) || notas.set(n.coreografia_id, {}).get(n.coreografia_id))[n.jurado_id] = n.nota;
  const audios = new Map();
  for (const g of gra.results) {
    (audios.get(g.coreografia_id) || audios.set(g.coreografia_id, {}).get(g.coreografia_id))[g.jurado_id] = {
      gravacao_id: g.id, status: g.aprovada ? 'aprovado' : g.status, versao: g.versao, duracao_ms: g.duracao_ms,
      identificador: g.identificador, tamanho: g.tamanho, iniciado_em: g.iniciado_em, finalizado_em: g.finalizado_em,
    };
  }
  let lancadas = 0;
  const coreografias = cor.results.map((c) => {
    const n = notas.get(c.id) || {};
    const validas = Object.entries(n).filter(([j]) => ativos.has(j)).map(([, v]) => v);
    lancadas += validas.length;
    const media = validas.length ? Math.round((validas.reduce((s, v) => s + v, 0) / validas.length) * 10000) / 10000 : null;
    return { ...c, notas: n, audios: audios.get(c.id) || {}, finalizadas: finalizadas.get(c.id) || {}, media, qtd_notas: validas.length };
  });
  return json({
    evento: {
      id: evento.id, nome: evento.nome, data: evento.data, local: evento.local, abre_em: evento.abre_em, fecha_em: evento.fecha_em,
      nota_min: evento.nota_min, nota_max: evento.nota_max, nota_casas: evento.nota_casas,
    },
    jurados: jur.results,
    coreografias,
    resumo: { coreografias: coreografias.length, jurados_ativos: ativos.size, notas_lancadas: lancadas, notas_esperadas: coreografias.length * ativos.size,
      finalizadas: fin.results.filter((f) => ativos.has(f.jurado_id)).length },
    gerado_em: Date.now(),
  });
}

/* DELETE /api/admin/eventos/:id/finalizacoes/:coreografia/:jurado
   Reabre a avaliação de um jurado numa coreografia (ex.: finalizou por engano). Geral ou responsável do evento. */
export async function reabrirAvaliacao(request, env, { id, coreografia, jurado }) {
  const a = await exigirEvento(request, env, id);
  const r = await env.DB.prepare('DELETE FROM finalizacoes WHERE evento_id = ?1 AND coreografia_id = ?2 AND jurado_id = ?3')
    .bind(id, coreografia, jurado)
    .run();
  if (!r.meta.changes) throw new ErroHttp(404, 'Esta avaliação não está finalizada', 'nao_encontrado');
  return json({ ok: true });
}

/* ================================ GRAVAÇÕES ================================ */

/* GET /api/admin/eventos/:id/gravacoes */
export async function listarGravacoes(request, env, { id }) {
  await exigirEvento(request, env, id);
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.versao, g.identificador, g.identificador_publico, g.status, g.aprovada, g.duracao_ms, g.tamanho,
            g.sha256, g.iniciado_em, g.finalizado_em, c.id AS coreografia_id, c.numero, c.nome AS coreografia, c.faixa,
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
  return json({ ok: true });
}

/* ------------------------------ link exclusivo de notas e áudios (para o grupo/escola) ------------------------------
   Cada coreografia tem UM link ativo por vez: gerar um novo revoga o anterior. Só o hash do token fica no banco. */

const diasDoLink = (corpo) => Math.min(Math.max(Number(corpo?.dias) || 30, 1), 180);

/** Comandos que trocam o link da coreografia (revoga os anteriores e grava o novo). */
async function novoLink(env, c, criadoPor, dias, origem) {
  const token = aleatorio(32);
  const agora = Date.now();
  const expira = agora + dias * 86400_000;
  const stmts = [
    env.DB.prepare('UPDATE links_entrega SET revogado = 1 WHERE coreografia_id = ?1 AND revogado = 0').bind(c.id),
    env.DB.prepare(
      'INSERT INTO links_entrega (token_hash, coreografia_id, evento_id, criado_por, criado_em, expira_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(await sha256Hex(token), c.id, c.evento_id, criadoPor, agora, expira),
  ];
  return { stmts, url: `${origem}/ouvir/${token}`, expira_em: expira };
}

/* POST /api/admin/coreografias/:id/link  { dias? } */
export async function criarLinkEntrega(request, env, { id }) {
  const { a, linha: c } = await exigirRegistroDoEvento(request, env, 'SELECT id, evento_id FROM coreografias WHERE id = ?1', id, 'Coreografia');
  const corpo = await lerJson(request).catch(() => ({}));
  const l = await novoLink(env, c, a.email, diasDoLink(corpo), new URL(request.url).origin);
  await env.DB.batch(l.stmts);
  return json({ url: l.url, expira_em: l.expira_em }, 201);
}

/* POST /api/admin/eventos/:id/links  { dias?, somente_sem_link? }
   Gera o link de todas as coreografias do evento de uma vez (para enviar às escolas/grupos). */
export async function criarLinksDoEvento(request, env, { id }) {
  const a = await exigirEvento(request, env, id);
  await eventoOu404(env, id);
  const corpo = await lerJson(request).catch(() => ({}));
  const dias = diasDoLink(corpo);
  const agora = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.evento_id, c.numero, c.nome, g.nome AS grupo, g.responsavel AS grupo_responsavel, g.email AS grupo_email,
            g.telefone AS grupo_telefone,
            (SELECT COUNT(*) FROM links_entrega l WHERE l.coreografia_id = c.id AND l.revogado = 0 AND l.expira_em > ?2) AS ativos
       FROM coreografias c LEFT JOIN grupos g ON g.id = c.grupo_id WHERE c.evento_id = ?1 ORDER BY c.numero`,
  ).bind(id, agora).all();
  const alvo = corpo.somente_sem_link ? results.filter((c) => !c.ativos) : results;
  const origem = new URL(request.url).origin;
  const links = [];
  let stmts = [];
  for (const c of alvo) {
    const l = await novoLink(env, c, a.email, dias, origem);
    stmts.push(...l.stmts);
    links.push({
      coreografia_id: c.id, numero: c.numero, coreografia: c.nome, grupo: c.grupo, grupo_responsavel: c.grupo_responsavel,
      grupo_email: c.grupo_email, grupo_telefone: c.grupo_telefone, url: l.url, expira_em: l.expira_em,
    });
    if (stmts.length >= 90) { await env.DB.batch(stmts); stmts = []; }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ links, dias }, 201);
}

/* POST /api/admin/coreografias/:id/revogar-links */
export async function revogarLinks(request, env, { id }) {
  const { a, linha: c } = await exigirRegistroDoEvento(request, env, 'SELECT evento_id FROM coreografias WHERE id = ?1', id, 'Coreografia');
  const r = await env.DB.prepare('UPDATE links_entrega SET revogado = 1 WHERE coreografia_id = ?1').bind(id).run();
  return json({ revogados: r.meta.changes });
}


