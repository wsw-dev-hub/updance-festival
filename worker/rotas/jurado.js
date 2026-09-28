// Rotas do app do jurado.
// Autenticação: conta de jurado própria do festival (cookie m_session).
// Autorização: o jurado precisa estar escalado (e ativo) no evento, em evento_jurados.

import { json, lerJson, lerBytes, ErroHttp } from '../lib/http.js';
import { exigirJurado } from '../lib/sessao.js';
import { sha256Hex } from '../lib/cripto.js';
import { gerarIdentificadores, mimeBase, EXTENSOES } from '../lib/identificador.js';
import { auditar } from '../lib/auditoria.js';

export const LIMITES = {
  TRECHO_MAX_BYTES: 1024 * 1024,           // 1 MB por trecho (~10 s de áudio ocupam ~40 KB)
  MAX_TRECHOS: 200,                         // por gravação
  ARQUIVO_MAX_BYTES: 25 * 1024 * 1024,      // arquivo final
  TOLERANCIA_ENVIO_MS: 12 * 60 * 60 * 1000, // reenvio de pendências até 12 h após o fim do evento
};

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ator = (c) => c.ator;

function eventoPublico(e) {
  return {
    id: e.id, nome: e.nome, data: e.data, local: e.local, fuso: e.fuso,
    abre_em: e.abre_em, fecha_em: e.fecha_em, duracao_max_s: e.duracao_max_s,
    nota_min: e.nota_min, nota_max: e.nota_max, nota_casas: e.nota_casas,
  };
}

async function carregarEvento(env, id) {
  return env.DB.prepare('SELECT * FROM eventos WHERE id = ?1').bind(id).first();
}

/** Escala do jurado no evento (ordem), se ativa. */
async function juradoNoEvento(env, conta, eventoId) {
  const ej = await env.DB.prepare('SELECT ordem FROM evento_jurados WHERE evento_id = ?1 AND jurado_id = ?2 AND ativo = 1')
    .bind(eventoId, conta.id)
    .first();
  return ej ? { id: conta.id, nome: conta.nome, ordem: ej.ordem } : null;
}

/* GET /api/sessao?evento=<id>
   Eventos (ainda não encerrados) em que o jurado está escalado; dados do evento escolhido. */
export async function sessao(request, env) {
  const m = await exigirJurado(request, env);
  const { results: lista } = await env.DB.prepare(
    `SELECT e.*, ej.ordem AS jurado_ordem
       FROM evento_jurados ej JOIN eventos e ON e.id = ej.evento_id
      WHERE ej.jurado_id = ?1 AND ej.ativo = 1 AND e.fecha_em > ?2
      ORDER BY e.abre_em`,
  )
    .bind(m.id, Date.now() - LIMITES.TOLERANCIA_ENVIO_MS)
    .all();

  if (!lista.length) {
    throw new ErroHttp(403, `Sua conta (${m.email}) ainda não está escalada em nenhum evento ativo.`, 'nao_jurado');
  }

  const pedido = new URL(request.url).searchParams.get('evento');
  const sel = lista.find((e) => e.id === pedido) || (lista.length === 1 ? lista[0] : null);
  const base = {
    horario_servidor: Date.now(),
    conta: { nome: m.nome, email: m.email },
    eventos: lista.map((e) => ({ id: e.id, nome: e.nome, data: e.data, local: e.local, abre_em: e.abre_em })),
  };
  if (!sel) return json({ ...base, evento: null });

  const [coreografias, gravacoes, notas] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.id, c.numero, c.nome, g.nome AS grupo, c.categoria, c.formacao, c.faixa
         FROM coreografias c LEFT JOIN grupos g ON g.id = c.grupo_id
        WHERE c.evento_id = ?1 ORDER BY c.numero`,
    ).bind(sel.id),
    env.DB.prepare('SELECT id, coreografia_id, versao, status FROM gravacoes WHERE jurado_id = ?1 AND evento_id = ?2 ORDER BY criado_em').bind(m.id, sel.id),
    env.DB.prepare('SELECT coreografia_id, nota, atualizado_em FROM notas WHERE jurado_id = ?1 AND evento_id = ?2').bind(m.id, sel.id),
  ]);
  return json({
    ...base,
    evento: eventoPublico(sel),
    jurado: { nome: m.nome, ordem: sel.jurado_ordem },
    coreografias: coreografias.results,
    gravacoes: gravacoes.results,
    notas: Object.fromEntries(notas.results.map((n) => [n.coreografia_id, n.nota])),
  });
}

/** Valida a nota na escala do evento (mín., máx. e casas decimais). */
export function validarNota(valor, evento) {
  const n = typeof valor === 'string' ? Number(valor.replace(',', '.')) : Number(valor);
  if (!Number.isFinite(n)) throw new ErroHttp(422, 'Nota inválida', 'nota_invalida');
  if (n < evento.nota_min || n > evento.nota_max) {
    throw new ErroHttp(422, `A nota deve ficar entre ${evento.nota_min} e ${evento.nota_max}`, 'nota_fora_da_escala');
  }
  const fator = 10 ** evento.nota_casas;
  if (Math.abs(Math.round(n * fator) - n * fator) > 1e-6) {
    throw new ErroHttp(422, `Use no máximo ${evento.nota_casas} casa(s) decimal(is)`, 'nota_casas');
  }
  return Math.round(n * fator) / fator;
}

/* PUT /api/notas/:coreografia  { nota }   (nota: null apaga)
   Nota do jurado para a coreografia, registrada junto do comentário em áudio. Pode ser alterada
   enquanto o evento aceita envios (mesma janela das gravações). */
export async function salvarNota(request, env, { coreografia }) {
  const m = await exigirJurado(request, env);
  const c = await env.DB.prepare('SELECT id, evento_id, numero, nome FROM coreografias WHERE id = ?1').bind(coreografia).first();
  if (!c) throw new ErroHttp(404, 'Coreografia não encontrada', 'nao_encontrada');
  const evento = await carregarEvento(env, c.evento_id);
  if (!(await juradoNoEvento(env, m, evento.id))) throw new ErroHttp(403, 'Você não é jurado deste evento', 'nao_jurado');
  const agora = Date.now();
  if (agora < evento.abre_em) throw new ErroHttp(403, 'O evento ainda não foi aberto para avaliação', 'evento_nao_aberto');
  if (!dentroDaJanelaDeEnvio(evento)) throw new ErroHttp(403, 'Prazo de avaliação encerrado', 'prazo_encerrado');

  const { nota } = await lerJson(request, 1024);
  const anterior = await env.DB.prepare('SELECT nota FROM notas WHERE coreografia_id = ?1 AND jurado_id = ?2').bind(c.id, m.id).first();
  if (nota === null || nota === '') {
    await env.DB.prepare('DELETE FROM notas WHERE coreografia_id = ?1 AND jurado_id = ?2').bind(c.id, m.id).run();
    if (anterior) await auditar(env, request, { eventoId: evento.id, ator: ator(m), acao: 'nota_removida', alvo: c.id, detalhes: { numero: c.numero, anterior: anterior.nota } });
    return json({ ok: true, nota: null });
  }
  const valor = validarNota(nota, evento);
  if (anterior?.nota === valor) return json({ ok: true, nota: valor });
  await env.DB.prepare(
    `INSERT INTO notas (coreografia_id, jurado_id, evento_id, nota, criado_em, atualizado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT (coreografia_id, jurado_id) DO UPDATE SET nota = excluded.nota, atualizado_em = excluded.atualizado_em`,
  )
    .bind(c.id, m.id, evento.id, valor, agora)
    .run();
  await auditar(env, request, {
    eventoId: evento.id, ator: ator(m), acao: anterior ? 'nota_alterada' : 'nota_lancada', alvo: c.id,
    detalhes: { numero: c.numero, nota: valor, ...(anterior ? { anterior: anterior.nota } : {}) },
  });
  return json({ ok: true, nota: valor });
}

/** Gravação do próprio jurado, com a escala no evento ativa. 404 quando é de outra pessoa: não revela que existe. */
async function gravacaoDoJurado(env, id, juradoId) {
  if (!RE_UUID.test(id)) throw new ErroHttp(400, 'Identificador de gravação inválido', 'id_invalido');
  const g = await env.DB.prepare(
    `SELECT g.* FROM gravacoes g
       JOIN evento_jurados ej ON ej.evento_id = g.evento_id AND ej.jurado_id = g.jurado_id
      WHERE g.id = ?1 AND g.jurado_id = ?2 AND ej.ativo = 1`,
  )
    .bind(id, juradoId)
    .first();
  if (!g) throw new ErroHttp(404, 'Gravação não encontrada', 'nao_encontrada');
  return g;
}

const dentroDaJanelaDeEnvio = (evento) => Date.now() <= evento.fecha_em + LIMITES.TOLERANCIA_ENVIO_MS;

function resumoGravacao(g) {
  return { id: g.id, versao: g.versao, identificador: g.identificador, status: g.status, sha256: g.sha256 };
}

/* PUT /api/gravacoes/:id  { coreografia_id, mime, iniciado_em }  (idempotente) */
export async function criarGravacao(request, env, { id }) {
  const m = await exigirJurado(request, env);
  if (!RE_UUID.test(id)) throw new ErroHttp(400, 'Identificador de gravação inválido', 'id_invalido');
  const corpo = await lerJson(request, 4096);

  const existente = await env.DB.prepare('SELECT * FROM gravacoes WHERE id = ?1').bind(id).first();
  if (existente) {
    if (existente.jurado_id !== m.id) throw new ErroHttp(404, 'Gravação não encontrada', 'nao_encontrada');
    return json(resumoGravacao(existente));
  }

  const coreografia = await env.DB.prepare('SELECT * FROM coreografias WHERE id = ?1').bind(String(corpo.coreografia_id || '')).first();
  if (!coreografia) throw new ErroHttp(422, 'Coreografia inválida', 'coreografia_invalida');
  const evento = await carregarEvento(env, coreografia.evento_id);
  const jurado = await juradoNoEvento(env, m, evento.id);
  if (!jurado) throw new ErroHttp(403, 'Você não é jurado deste evento', 'nao_jurado');

  const agora = Date.now();
  if (agora < evento.abre_em) throw new ErroHttp(403, 'O evento ainda não foi aberto para gravação', 'evento_nao_aberto');
  if (!dentroDaJanelaDeEnvio(evento)) throw new ErroHttp(403, 'Prazo de envio encerrado', 'prazo_encerrado');

  const mime = mimeBase(corpo.mime);
  if (!mime) throw new ErroHttp(422, 'Formato de áudio não permitido', 'formato_invalido');

  // Horário do aparelho (já corrigido pela diferença de relógio). Se absurdo, usa o do servidor.
  let iniciadoEm = Number(corpo.iniciado_em);
  let relogioSuspeito = false;
  if (!Number.isFinite(iniciadoEm) || iniciadoEm < evento.abre_em - 3600_000 || iniciadoEm > agora + 5 * 60_000) {
    iniciadoEm = agora;
    relogioSuspeito = true;
  }

  // Versão calculada atomicamente: 1 para a primeira, 2+ para regravações
  const inserida = await env.DB.prepare(
    `INSERT INTO gravacoes (id, evento_id, coreografia_id, jurado_id, versao, identificador, identificador_publico,
                            mime, extensao, iniciado_em, criado_em, status)
     SELECT ?1, ?2, ?3, ?4, COALESCE(MAX(versao), 0) + 1, '', '', ?5, ?6, ?7, ?8, 'gravando'
       FROM gravacoes WHERE jurado_id = ?4 AND coreografia_id = ?3
     RETURNING versao`,
  )
    .bind(id, evento.id, coreografia.id, jurado.id, mime, EXTENSOES[mime], Math.round(iniciadoEm), agora)
    .first();

  const { interno, publico } = gerarIdentificadores({
    evento, coreografia, jurado, iniciadoEm, versao: inserida.versao, extensao: EXTENSOES[mime],
  });
  await env.DB.prepare('UPDATE gravacoes SET identificador = ?1, identificador_publico = ?2 WHERE id = ?3')
    .bind(interno, publico, id)
    .run();

  await auditar(env, request, {
    eventoId: evento.id, ator: ator(m), acao: 'gravacao_iniciada', alvo: id,
    detalhes: { identificador: interno, relogio_suspeito: relogioSuspeito || undefined },
  });
  return json({ id, versao: inserida.versao, identificador: interno, status: 'gravando' }, 201);
}

export const chaveTrecho = (g, seq) => `trechos/${g.evento_id}/${g.id}/${String(seq).padStart(4, '0')}`;
export const chaveAudio = (g) => `audios/${g.evento_id}/${g.id}.${g.extensao}`;

/* PUT /api/gravacoes/:id/trechos/:seq  (corpo binário; cópia de segurança durante a gravação) */
export async function enviarTrecho(request, env, { id, seq }) {
  const m = await exigirJurado(request, env);
  const g = await gravacaoDoJurado(env, id, m.id);
  if (g.status === 'completo') return json({ ok: true, ignorado: true });

  const n = Number.parseInt(seq, 10);
  if (!/^\d+$/.test(seq) || n >= LIMITES.MAX_TRECHOS) throw new ErroHttp(422, 'Sequência inválida', 'seq_invalida');

  const bytes = await lerBytes(request, LIMITES.TRECHO_MAX_BYTES);
  if (!bytes.byteLength) throw new ErroHttp(422, 'Trecho vazio', 'trecho_vazio');
  const sha = await sha256Hex(bytes);

  const existente = await env.DB.prepare('SELECT sha256 FROM trechos WHERE gravacao_id = ?1 AND seq = ?2').bind(id, n).first();
  if (existente) {
    if (existente.sha256 === sha) return json({ ok: true, repetido: true });
    throw new ErroHttp(409, 'Trecho já recebido com conteúdo diferente', 'trecho_conflito');
  }

  await env.AUDIOS.put(chaveTrecho(g, n), bytes, {
    httpMetadata: { contentType: g.mime },
    customMetadata: { gravacao_id: id, seq: String(n), sha256: sha },
  });
  await env.DB.prepare('INSERT OR IGNORE INTO trechos (gravacao_id, seq, tamanho, sha256, recebido_em) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, n, bytes.byteLength, sha, Date.now())
    .run();
  return json({ ok: true });
}

/* POST /api/gravacoes/:id/finalizar  (corpo = arquivo completo; X-Conteudo-SHA256; X-Duracao-Ms) */
export async function finalizarGravacao(request, env, { id }, ctx) {
  const m = await exigirJurado(request, env);
  const g = await gravacaoDoJurado(env, id, m.id);

  const bytes = await lerBytes(request, LIMITES.ARQUIVO_MAX_BYTES);
  if (!bytes.byteLength) throw new ErroHttp(422, 'Arquivo vazio', 'arquivo_vazio');
  const sha = await sha256Hex(bytes);

  const declarado = (request.headers.get('X-Conteudo-SHA256') || '').toLowerCase();
  if (declarado && declarado !== sha) throw new ErroHttp(422, 'Arquivo corrompido no envio', 'hash_divergente');

  if (g.status === 'completo') {
    if (g.sha256 === sha) return json({ ok: true, ...resumoGravacao(g) });
    throw new ErroHttp(409, 'Gravação já finalizada com outro conteúdo', 'ja_finalizada');
  }

  const evento = await carregarEvento(env, g.evento_id);
  if (!dentroDaJanelaDeEnvio(evento)) throw new ErroHttp(403, 'Prazo de envio encerrado', 'prazo_encerrado');

  const limiteDuracao = (evento.duracao_max_s + 120) * 1000;
  const duracao = Math.min(Math.max(Number.parseInt(request.headers.get('X-Duracao-Ms') || '0', 10) || 0, 0), limiteDuracao);

  const chave = chaveAudio(g);
  await env.AUDIOS.put(chave, bytes, {
    httpMetadata: { contentType: g.mime },
    customMetadata: { identificador: g.identificador, sha256: sha, jurado_id: g.jurado_id, coreografia_id: g.coreografia_id },
  });

  const r = await env.DB.prepare(
    `UPDATE gravacoes SET status = 'completo', finalizado_em = ?1, duracao_ms = ?2, tamanho = ?3, sha256 = ?4, r2_chave = ?5
      WHERE id = ?6 AND status = 'gravando'`,
  )
    .bind(Date.now(), duracao, bytes.byteLength, sha, chave, id)
    .run();

  if (r.meta.changes === 1) {
    await auditar(env, request, {
      eventoId: g.evento_id, ator: ator(m), acao: 'gravacao_finalizada', alvo: id,
      detalhes: { identificador: g.identificador, sha256: sha, tamanho: bytes.byteLength, duracao_ms: duracao },
    });
    ctx.waitUntil(removerTrechos(env, g)); // arquivo final confirmado: apaga as cópias de segurança
  }
  return json({ ok: true, id, identificador: g.identificador, sha256: sha, status: 'completo' });
}

async function removerTrechos(env, g) {
  const { results } = await env.DB.prepare('SELECT seq FROM trechos WHERE gravacao_id = ?1').bind(g.id).all();
  if (results.length) await env.AUDIOS.delete(results.map((t) => chaveTrecho(g, t.seq)));
}
