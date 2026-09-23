// Rotas do painel do festival. Todas exigem sessão de ADMIN UpDance (a_session → asess:<sid>).

import { json, lerJson, lerTexto, ErroHttp, disposicao, CABECALHOS_SEGURANCA } from '../lib/http.js';
import { exigirAdmin } from '../lib/sessao.js';
import { aleatorio, sha256Hex } from '../lib/cripto.js';
import { auditar } from '../lib/auditoria.js';
import { servirAudio } from '../lib/midia.js';
import { chaveTrecho } from './jurado.js';

const OFFSET_BRASILIA = '-03:00'; // Brasil sem horário de verão desde 2019
const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function texto(v, max, obrigatorio = true) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (obrigatorio && !s) throw new ErroHttp(422, 'Campo obrigatório ausente', 'campo_ausente');
  if (s.length > max) throw new ErroHttp(422, `Texto maior que ${max} caracteres`, 'texto_longo');
  return s;
}

function dataHora(v, padrao) {
  if (v == null || v === '') return padrao;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new ErroHttp(422, `Data/hora inválida: ${v}`, 'data_invalida');
  return ms;
}

async function eventoOu404(env, id) {
  const e = await env.DB.prepare('SELECT * FROM eventos WHERE id = ?1').bind(id).first();
  if (!e) throw new ErroHttp(404, 'Evento não encontrado', 'nao_encontrado');
  return e;
}

/* GET /api/admin/me — identifica o admin no topo do painel */
export async function quemSouEu(request, env) {
  const a = await exigirAdmin(request, env);
  return json({ email: a.email, painel_updance: `${env.BLOG_ORIGIN}/admin/` });
}

/* POST /api/admin/eventos */
export async function criarEvento(request, env) {
  const a = await exigirAdmin(request, env);
  const b = await lerJson(request);
  const nome = texto(b.nome, 120);
  const data = texto(b.data, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new ErroHttp(422, 'Data no formato AAAA-MM-DD', 'data_invalida');
  const local = texto(b.local, 160, false) || null;

  const abre = dataHora(b.abre_em, Date.parse(`${data}T00:00:00${OFFSET_BRASILIA}`));
  const fecha = dataHora(b.fecha_em, Date.parse(`${data}T23:59:59${OFFSET_BRASILIA}`));
  if (fecha <= abre) throw new ErroHttp(422, 'O encerramento deve ser depois da abertura', 'data_invalida');
  const duracaoMax = Math.min(Math.max(Number(b.duracao_max_s) || 480, 60), 1800);

  const id = aleatorio(12);
  await env.DB.prepare(
    `INSERT INTO eventos (id, nome, data, local, fuso, abre_em, fecha_em, anonimizar_jurados, duracao_max_s, criado_por, criado_em)
     VALUES (?1, ?2, ?3, ?4, 'America/Sao_Paulo', ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(id, nome, data, local, abre, fecha, b.anonimizar_jurados ? 1 : 0, duracaoMax, a.email, Date.now())
    .run();
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'evento_criado', alvo: id, detalhes: { nome } });
  return json({ id, nome, data, abre_em: abre, fecha_em: fecha }, 201);
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
    env.DB.prepare('SELECT * FROM coreografias WHERE evento_id = ?1 ORDER BY numero').bind(id),
    env.DB.prepare('SELECT id, email, nome, ordem, ativo, criado_em FROM jurados WHERE evento_id = ?1 ORDER BY ordem').bind(id),
  ]);
  return json({ evento, coreografias: coreografias.results, jurados: jurados.results, link_jurados: `${new URL(request.url).origin}/?evento=${id}` });
}

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

/* POST /api/admin/eventos/:id/coreografias  (CSV: numero;nome;grupo;categoria) */
export async function importarCoreografias(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  await eventoOu404(env, id);
  const linhas = lerCsv(await lerTexto(request, 512 * 1024));
  if (!linhas.length) throw new ErroHttp(422, 'CSV vazio', 'csv_vazio');
  if (linhas.length > 2000) throw new ErroHttp(422, 'Máximo de 2000 coreografias', 'csv_grande');

  const erros = [];
  const stmts = [];
  linhas.forEach((l, i) => {
    const numero = Number.parseInt(l.numero, 10);
    const nome = (l.nome || l.coreografia || '').trim();
    if (!Number.isFinite(numero) || numero < 0 || !nome || nome.length > 200) {
      erros.push(`linha ${i + 2}: número ou nome inválido`);
      return;
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO coreografias (id, evento_id, numero, nome, grupo, categoria) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (evento_id, numero) DO UPDATE SET nome = excluded.nome, grupo = excluded.grupo, categoria = excluded.categoria`,
      ).bind(aleatorio(12), id, numero, nome, (l.grupo || '').slice(0, 200), (l.categoria || '').slice(0, 100)),
    );
  });
  if (erros.length) throw new ErroHttp(422, erros.slice(0, 20).join('; '), 'csv_invalido');
  await env.DB.batch(stmts);
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'coreografias_importadas', detalhes: { quantidade: stmts.length } });
  return json({ importadas: stmts.length });
}

/* POST /api/admin/eventos/:id/jurados  { nome, email }
   O e-mail é o da CONTA UpDance do jurado: é por ele que o festival reconhece a sessão. */
export async function criarJurado(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  await eventoOu404(env, id);
  const b = await lerJson(request);
  const nome = texto(b.nome, 120);
  const email = texto(b.email, 254).toLowerCase();
  if (!RE_EMAIL.test(email)) throw new ErroHttp(422, 'E-mail inválido', 'email_invalido');

  const existe = await env.DB.prepare('SELECT 1 FROM jurados WHERE evento_id = ?1 AND email = ?2').bind(id, email).first();
  if (existe) throw new ErroHttp(409, 'Este e-mail já é jurado deste evento', 'jurado_existente');

  const { ordem } = await env.DB.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS ordem FROM jurados WHERE evento_id = ?1').bind(id).first();
  const juradoId = aleatorio(12);
  await env.DB.prepare('INSERT INTO jurados (id, evento_id, email, nome, ordem, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(juradoId, id, email, nome, ordem, Date.now())
    .run();
  await auditar(env, request, { eventoId: id, ator: a.ator, acao: 'jurado_criado', alvo: juradoId, detalhes: { nome, email } });
  return json({ id: juradoId, nome, email, ordem, link: `${new URL(request.url).origin}/?evento=${id}` }, 201);
}

/* PATCH /api/admin/jurados/:id  { ativo?: boolean, nome?: string }
   Desativar corta o acesso ao festival na hora (a conta UpDance continua válida no restante do ecossistema). */
export async function atualizarJurado(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const j = await env.DB.prepare('SELECT * FROM jurados WHERE id = ?1').bind(id).first();
  if (!j) throw new ErroHttp(404, 'Jurado não encontrado', 'nao_encontrado');
  const b = await lerJson(request);
  const nome = b.nome !== undefined ? texto(b.nome, 120) : j.nome;
  const ativo = b.ativo !== undefined ? (b.ativo ? 1 : 0) : j.ativo;
  await env.DB.prepare('UPDATE jurados SET nome = ?1, ativo = ?2 WHERE id = ?3').bind(nome, ativo, id).run();
  await auditar(env, request, { eventoId: j.evento_id, ator: a.ator, acao: ativo ? 'jurado_ativado' : 'jurado_desativado', alvo: id, detalhes: { nome } });
  return json({ ok: true, ativo: !!ativo, nome });
}

/* GET /api/admin/eventos/:id/gravacoes */
export async function listarGravacoes(request, env, { id }) {
  await exigirAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.versao, g.identificador, g.identificador_publico, g.status, g.aprovada, g.duracao_ms, g.tamanho,
            g.sha256, g.iniciado_em, g.finalizado_em, c.id AS coreografia_id, c.numero, c.nome AS coreografia,
            j.nome AS jurado, (SELECT COUNT(*) FROM trechos t WHERE t.gravacao_id = g.id) AS trechos
       FROM gravacoes g
       JOIN coreografias c ON c.id = g.coreografia_id
       JOIN jurados j ON j.id = g.jurado_id
      WHERE g.evento_id = ?1
      ORDER BY c.numero, j.ordem, g.versao`,
  )
    .bind(id)
    .all();
  return json(results);
}

/* GET /api/admin/gravacoes/:id/audio — completo, ou reconstruído dos trechos se ainda não finalizado */
export async function ouvirGravacao(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const g = await env.DB.prepare('SELECT * FROM gravacoes WHERE id = ?1').bind(id).first();
  if (!g) throw new ErroHttp(404, 'Gravação não encontrada', 'nao_encontrada');
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

/* POST /api/admin/gravacoes/:id/aprovar  { aprovada: true|false } */
export async function aprovarGravacao(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const { aprovada } = await lerJson(request);
  const g = await env.DB.prepare('SELECT evento_id, status FROM gravacoes WHERE id = ?1').bind(id).first();
  if (!g) throw new ErroHttp(404, 'Gravação não encontrada', 'nao_encontrada');
  if (aprovada && g.status !== 'completo') throw new ErroHttp(422, 'Só gravações completas podem ser aprovadas', 'incompleta');
  await env.DB.prepare('UPDATE gravacoes SET aprovada = ?1, aprovada_por = ?2, aprovada_em = ?3 WHERE id = ?4')
    .bind(aprovada ? 1 : 0, a.email, Date.now(), id)
    .run();
  await auditar(env, request, { eventoId: g.evento_id, ator: a.ator, acao: aprovada ? 'gravacao_aprovada' : 'gravacao_reprovada', alvo: id });
  return json({ ok: true });
}

/* POST /api/admin/coreografias/:id/link  { dias?: number } — link de entrega ao participante */
export async function criarLinkEntrega(request, env, { id }) {
  const a = await exigirAdmin(request, env);
  const c = await env.DB.prepare('SELECT id, evento_id FROM coreografias WHERE id = ?1').bind(id).first();
  if (!c) throw new ErroHttp(404, 'Coreografia não encontrada', 'nao_encontrada');
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
  const c = await env.DB.prepare('SELECT evento_id FROM coreografias WHERE id = ?1').bind(id).first();
  const r = await env.DB.prepare('UPDATE links_entrega SET revogado = 1 WHERE coreografia_id = ?1').bind(id).run();
  await auditar(env, request, { eventoId: c?.evento_id || null, ator: a.ator, acao: 'links_revogados', alvo: id, detalhes: { quantidade: r.meta.changes } });
  return json({ revogados: r.meta.changes });
}

/* GET /api/admin/eventos/:id/auditoria */
export async function listarAuditoria(request, env, { id }) {
  await exigirAdmin(request, env);
  const { results } = await env.DB.prepare('SELECT * FROM auditoria WHERE evento_id = ?1 ORDER BY id DESC LIMIT 500').bind(id).all();
  return json(results);
}
