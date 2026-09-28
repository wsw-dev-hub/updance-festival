// Página pública de entrega ao participante: /ouvir/:token
// O token (256 bits aleatórios) é vinculado a UMA coreografia; só o hash fica no banco.
// Só aparecem gravações completas E aprovadas pela organização.

import { ErroHttp, CABECALHOS_SEGURANCA } from '../lib/http.js';
import { sha256Hex } from '../lib/cripto.js';
import { auditar } from '../lib/auditoria.js';
import { servirAudio } from '../lib/midia.js';

const FAIXAS = { baby: 'Baby', infantil: 'Infantil', juvenil: 'Juvenil', adulto: 'Adulto', profissional: 'Profissional' };
const RE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

async function validarToken(env, token) {
  if (!RE_TOKEN.test(token)) throw new ErroHttp(404, 'Link inválido', 'link_invalido');
  const link = await env.DB.prepare(
    `SELECT l.*, c.numero, c.nome AS coreografia, c.faixa, gr.nome AS grupo, e.nome AS evento, e.anonimizar_jurados
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

async function gravacoesAprovadas(env, coreografiaId) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.identificador_publico, g.duracao_ms, g.mime, j.nome AS jurado, ej.ordem
       FROM gravacoes g
       JOIN jurados j ON j.id = g.jurado_id
       LEFT JOIN evento_jurados ej ON ej.evento_id = g.evento_id AND ej.jurado_id = g.jurado_id
      WHERE g.coreografia_id = ?1 AND g.status = 'completo' AND g.aprovada = 1
      ORDER BY ej.ordem, g.versao`,
  )
    .bind(coreografiaId)
    .all();
  return results;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function minutos(ms) {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* GET /ouvir/:token */
export async function paginaEntrega(request, env, { token }) {
  let link;
  try {
    link = await validarToken(env, token);
  } catch {
    return paginaHtml('Link indisponível', '<p>Este link é inválido, expirou ou foi revogado. Fale com a organização do festival.</p>', 404);
  }
  const gravacoes = await gravacoesAprovadas(env, link.coreografia_id);
  await auditar(env, request, { eventoId: link.evento_id, ator: 'publico', acao: 'entrega_acessada', alvo: link.coreografia_id });

  const itens = gravacoes.length
    ? gravacoes
        .map((g) => {
          const rotulo = link.anonimizar_jurados ? `Jurado ${g.ordem}` : g.jurado;
          const src = `/ouvir/${token}/${g.id}`;
          return `<li>
            <h2>${esc(rotulo)} <small>${minutos(g.duracao_ms)}</small></h2>
            <audio controls preload="metadata" src="${src}"></audio>
            <a href="${src}?download=1">Baixar áudio</a>
          </li>`;
        })
        .join('')
    : '<p>Os comentários ainda não foram liberados. Tente novamente mais tarde.</p>';

  const corpo = `
    <p class="evento">${esc(link.evento)}</p>
    <h1>${String(link.numero).padStart(3, '0')} · ${esc(link.coreografia)}</h1>
    ${link.grupo || link.faixa ? `<p class="grupo">${esc([link.grupo, FAIXAS[link.faixa]].filter(Boolean).join(' · '))}</p>` : ''}
    <ul>${itens}</ul>
    <p class="aviso">Link pessoal. Não compartilhe. Disponível até ${new Date(link.expira_em).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.</p>`;
  return paginaHtml(`${link.coreografia} — comentários dos jurados`, corpo);
}

/* GET /ouvir/:token/:gravacao */
export async function audioEntrega(request, env, { token, gravacao }) {
  const link = await validarToken(env, token);
  const g = await env.DB.prepare(
    `SELECT id, r2_chave, mime, identificador_publico FROM gravacoes
      WHERE id = ?1 AND coreografia_id = ?2 AND status = 'completo' AND aprovada = 1`,
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
  h2 { font-size:16px; margin:0 0 10px; display:flex; justify-content:space-between; font-weight:600; }
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
