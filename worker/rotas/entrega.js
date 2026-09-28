// Página pública de NOTAS e ÁUDIOS de uma coreografia, para a escola/grupo: /ouvir/:token
// O token (256 bits aleatórios) é exclusivo de UMA coreografia; só o hash fica no banco.
// Cada jurado aparece com a nota e os comentários em áudio depois que FINALIZA a avaliação.
// (Áudio aprovado pela organização também aparece antes disso.) A nota final (média) aparece
// quando todos os jurados ativos finalizaram.

import { ErroHttp, CABECALHOS_SEGURANCA } from '../lib/http.js';
import { sha256Hex } from '../lib/cripto.js';
import { servirAudio } from '../lib/midia.js';

const FAIXAS = { baby: 'Baby', infantil: 'Infantil', juvenil: 'Juvenil', adulto: 'Adulto', profissional: 'Profissional' };
const RE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

async function validarToken(env, token) {
  if (!RE_TOKEN.test(token)) throw new ErroHttp(404, 'Link inválido', 'link_invalido');
  const link = await env.DB.prepare(
    `SELECT l.*, c.numero, c.nome AS coreografia, c.faixa, c.formacao, gr.nome AS grupo, e.nome AS evento, e.anonimizar_jurados, e.nota_casas
       FROM links_entrega l
       JOIN coreografias c ON c.id = l.coreografia_id
       LEFT JOIN grupos gr ON gr.id = c.grupo_id
       JOIN eventos e ON e.id = l.evento_id
      WHERE l.token_hash = ?1`,
  )
    .bind(await sha256Hex(token))
    .first();
  if (!link || link.revogado || link.expira_em < Date.now()) throw new ErroHttp(404, 'Link inválido ou expirado', 'link_invalido');
  return link;
}

/** Áudio liberado no link: completo E (jurado finalizou a avaliação OU a organização aprovou). */
const SQL_AUDIO_LIBERADO = `g.status = 'completo' AND (g.aprovada = 1 OR EXISTS (
  SELECT 1 FROM finalizacoes f WHERE f.coreografia_id = g.coreografia_id AND f.jurado_id = g.jurado_id))`;

/** Jurados ativos do evento com a nota (se finalizou) e os áudios liberados desta coreografia. */
async function avaliacoes(env, link) {
  const [jur, not, fin, gra] = await env.DB.batch([
    env.DB.prepare(
      `SELECT j.id, j.nome, ej.ordem FROM evento_jurados ej JOIN jurados j ON j.id = ej.jurado_id
        WHERE ej.evento_id = ?1 AND ej.ativo = 1 ORDER BY ej.ordem`,
    ).bind(link.evento_id),
    env.DB.prepare('SELECT jurado_id, nota FROM notas WHERE coreografia_id = ?1').bind(link.coreografia_id),
    env.DB.prepare('SELECT jurado_id FROM finalizacoes WHERE coreografia_id = ?1').bind(link.coreografia_id),
    env.DB.prepare(
      `SELECT g.id, g.jurado_id, g.versao, g.duracao_ms FROM gravacoes g
        WHERE g.coreografia_id = ?1 AND ${SQL_AUDIO_LIBERADO} ORDER BY g.versao`,
    ).bind(link.coreografia_id),
  ]);
  const notas = new Map(not.results.map((n) => [n.jurado_id, n.nota]));
  const finalizados = new Set(fin.results.map((f) => f.jurado_id));
  return jur.results.map((j) => ({
    ...j,
    finalizada: finalizados.has(j.id),
    nota: finalizados.has(j.id) ? notas.get(j.id) ?? null : null,
    audios: gra.results.filter((g) => g.jurado_id === j.id),
  }));
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function minutos(ms) {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const FORMACOES = { solo: 'Solo', duo: 'Duo', trio: 'Trio', grupo: 'Grupo' };
const fmtNota = (n, casas) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

/* GET /ouvir/:token */
export async function paginaEntrega(request, env, { token }) {
  let link;
  try {
    link = await validarToken(env, token);
  } catch {
    return paginaHtml('Link indisponível', '<p>Este link é inválido, expirou ou foi substituído por um novo. Fale com a organização do festival.</p>', 404);
  }
  const lista = await avaliacoes(env, link);
  const casas = link.nota_casas ?? 1;
  const concluidas = lista.filter((j) => j.finalizada);
  const todas = lista.length > 0 && concluidas.length === lista.length && concluidas.every((j) => j.nota !== null);
  const media = todas ? concluidas.reduce((s, j) => s + j.nota, 0) / concluidas.length : null;

  const resumo = todas
    ? `<section class="resumo"><span>Nota final (média dos jurados)</span><strong>${fmtNota(media, Math.min(casas + 1, 3))}</strong></section>`
    : `<section class="resumo parcial"><span>Avaliações concluídas</span><strong>${concluidas.length} de ${lista.length}</strong>
         <em>A nota final aparece quando todos os jurados concluírem. Volte mais tarde.</em></section>`;

  const itens = lista.length
    ? lista
        .map((j) => {
          const rotulo = link.anonimizar_jurados ? `Jurado ${j.ordem}` : j.nome;
          const nota = j.finalizada && j.nota !== null
            ? `<span class="nota">${fmtNota(j.nota, casas)}</span>`
            : '<span class="nota pendente">em avaliação</span>';
          const audios = j.audios.length
            ? j.audios
                .map((g, i) => {
                  const src = `/ouvir/${token}/${g.id}`;
                  return `<div class="audio">
                    <p>${j.audios.length > 1 ? `Comentário ${i + 1}` : 'Comentário'} <small>${minutos(g.duracao_ms)}</small></p>
                    <audio controls preload="metadata" src="${src}"></audio>
                    <a href="${src}?download=1">Baixar áudio</a>
                  </div>`;
                })
                .join('')
            : `<p class="sem">${j.finalizada ? 'Sem comentário em áudio.' : 'Os comentários aparecem quando o jurado concluir a avaliação.'}</p>`;
          return `<li><h2>${esc(rotulo)} ${nota}</h2>${audios}</li>`;
        })
        .join('')
    : '<p>A avaliação desta coreografia ainda não começou.</p>';

  const detalhes = [link.grupo, FORMACOES[link.formacao], FAIXAS[link.faixa]].filter(Boolean).join(' · ');
  const corpo = `
    <p class="evento">${esc(link.evento)}</p>
    <h1>${String(link.numero).padStart(3, '0')} · ${esc(link.coreografia)}</h1>
    ${detalhes ? `<p class="grupo">${esc(detalhes)}</p>` : ''}
    ${resumo}
    <ul>${itens}</ul>
    <p class="aviso">Link exclusivo desta coreografia. Não compartilhe. Disponível até ${new Date(link.expira_em).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.</p>`;
  return paginaHtml(`${link.coreografia} — notas e comentários dos jurados`, corpo);
}

/* GET /ouvir/:token/:gravacao */
export async function audioEntrega(request, env, { token, gravacao }) {
  const link = await validarToken(env, token);
  const g = await env.DB.prepare(
    `SELECT g.id, g.r2_chave, g.mime, g.identificador_publico FROM gravacoes g
      WHERE g.id = ?1 AND g.coreografia_id = ?2 AND ${SQL_AUDIO_LIBERADO}`,
  )
    .bind(gravacao, link.coreografia_id)
    .first();
  if (!g) throw new ErroHttp(404, 'Áudio não encontrado', 'nao_encontrado');
  const download = new URL(request.url).searchParams.get('download') === '1';
  return servirAudio(request, env.AUDIOS, g.r2_chave, { nomeArquivo: g.identificador_publico, tipoMime: g.mime, download });
}

function paginaHtml(titulo, corpo, status = 200) {
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(titulo)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=Bebas+Neue&family=DM+Mono:wght@400;500&display=swap">
<style>
  /* Paleta UpDance (--udx-*) — tema escuro padrão do ecossistema */
  :root { color-scheme: dark; --udx-bg:#02021a; --udx-deep:#110273; --udx-primary:#BF0449; --udx-primary-hot:#FA33A1;
          --udx-primary-orange:#F27405; --udx-accent:#5708A6; --udx-text:#DFE0F2; --udx-text-muted:rgba(223,224,242,.68);
          --udx-card:rgba(255,255,255,.045); --udx-border:rgba(223,224,242,.12); }
  body { margin:0; min-height:100vh; color:var(--udx-text); font:16px/1.55 'Poppins', system-ui, sans-serif;
         background: radial-gradient(900px 500px at 0% -10%, rgba(87,8,166,.45), transparent 60%),
                     radial-gradient(700px 420px at 110% 0%, rgba(191,4,73,.28), transparent 60%), var(--udx-bg); }
  main { max-width:640px; margin:0 auto; padding:32px 16px 48px; }
  .marca { font-family:'Bebas Neue', 'Poppins', sans-serif; font-size:28px; letter-spacing:.04em; line-height:1; margin:0 0 24px; display:grid; grid-template-columns:auto 1fr; column-gap:10px; align-items:center; }
  .marca img { grid-row:span 2; border-radius:10px; }
  .marca span { display:block; font-family:'DM Mono', ui-monospace, monospace; font-size:11px; letter-spacing:.3em; color:var(--udx-text-muted); text-transform:uppercase; }
  .evento { color:var(--udx-primary-hot); margin:0; text-transform:uppercase; letter-spacing:.08em; font-size:12px; font-weight:600; }
  h1 { margin:4px 0; font-size:24px; font-weight:700; } .grupo { color:var(--udx-text-muted); margin:0 0 24px; }
  ul { list-style:none; padding:0; display:grid; gap:12px; }
  li { background:var(--udx-card); border:1px solid var(--udx-border); border-radius:16px; padding:16px; position:relative; overflow:hidden; }
  li::before { content:""; position:absolute; inset:0 auto 0 0; width:4px; background:linear-gradient(180deg, #FA33A1, #5708A6); }
  h2 { font-size:17px; margin:0 0 10px; display:flex; justify-content:space-between; align-items:center; gap:10px; font-weight:600; }
  .nota { font-family:'Bebas Neue', 'Poppins', sans-serif; font-size:30px; letter-spacing:.03em; color:var(--udx-primary-hot); line-height:1; }
  .nota.pendente { font-family:'Poppins', sans-serif; font-size:12px; letter-spacing:0; color:var(--udx-primary-orange); border:1px solid currentColor; border-radius:999px; padding:3px 10px; }
  .resumo { display:grid; gap:2px; justify-items:center; text-align:center; padding:18px; margin:0 0 16px; border-radius:18px;
            background:linear-gradient(135deg, rgba(191,4,73,.35), rgba(87,8,166,.35)); border:1px solid rgba(250,51,161,.45); }
  .resumo span { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--udx-text-muted); }
  .resumo strong { font-family:'Bebas Neue', 'Poppins', sans-serif; font-size:56px; line-height:1; letter-spacing:.03em; }
  .resumo.parcial strong { font-size:40px; } .resumo em { font-size:13px; color:var(--udx-text-muted); }
  .audio { border-top:1px solid var(--udx-border); padding-top:10px; margin-top:10px; } .audio p { margin:0 0 6px; font-size:14px; display:flex; justify-content:space-between; }
  .sem { margin:0; color:var(--udx-text-muted); font-size:14px; }
  small { color:var(--udx-text-muted); font-weight:400; font-family:'DM Mono', monospace; }
  audio { width:100%; } a { color:var(--udx-primary-hot); font-size:14px; font-weight:500; }
  .aviso { color:var(--udx-text-muted); font-size:13px; margin-top:24px; }
</style></head>
<body><main><p class="marca"><img src="/images/icons/udx-icon.png" alt="" width="40" height="40">UpDance<span>Festival</span></p>${corpo}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...CABECALHOS_SEGURANCA,
    },
  });
}
