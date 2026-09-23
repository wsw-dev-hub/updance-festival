// Painel do UpDance Festival.
// Acesso pela sessão de ADMIN do ecossistema (cookie a_session, validado no servidor).
// Se a sessão expirar, recarregar a página leva de novo à ponte de login do blog.

const $ = (id) => document.getElementById(id);
const num = (n) => String(n).padStart(3, '0');
const CHAVE_EVENTO = 'udx-festival.admin.evento';
let eventoId = null;
let abaAtual = 'gravacoes';
let timerAtualizar = null;

/* ------------------------------ API ------------------------------ */

async function api(metodo, caminho, { json, texto } = {}) {
  const headers = { 'X-UDX-Festival': '1' };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (texto !== undefined) {
    headers['Content-Type'] = 'text/csv; charset=utf-8';
    body = texto;
  }
  const resp = await fetch(caminho, { method: metodo, headers, body, credentials: 'same-origin', cache: 'no-store' });
  if (resp.status === 401) {
    // Sessão de admin expirou: o gate do servidor leva à ponte de login
    location.reload();
    throw new Error('Sessão de administrador expirada. Redirecionando…');
  }
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(dados.erro || `Erro ${resp.status}`);
  return dados;
}

function aviso(texto, erro = false) {
  $('mensagem').textContent = texto;
  $('mensagem').className = `mensagem${erro ? ' erro' : ''}`;
}

async function tentar(fn) {
  try {
    await fn();
  } catch (e) {
    aviso(e.message, true);
  }
}

function el(tag, props = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v; // somente com conteúdo fixo (ícones)
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e[k] = v;
  }
  e.append(...filhos.filter((f) => f != null));
  return e;
}

const icone = (nome) => el('i', { class: `mdi mdi-${nome}` });
const botao = (rotulo, nomeIcone, onclick, classe = 'btn btn-sec') => el('button', { class: classe, type: 'button', onclick }, icone(nomeIcone), ` ${rotulo}`);
const fmtDuracao = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtHora = (ms) => new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/* ------------------------------ Eventos ------------------------------ */

async function carregarEventos(selecionar) {
  const eventos = await api('GET', '/api/admin/eventos');
  $('sel-evento').replaceChildren(
    el('option', { value: '', textContent: eventos.length ? 'Escolha um evento…' : 'Nenhum evento criado' }),
    ...eventos.map((e) => el('option', { value: e.id, textContent: `${e.data.split('-').reverse().join('/')} · ${e.nome}` })),
  );
  let alvo = selecionar;
  try { alvo = alvo || localStorage.getItem(CHAVE_EVENTO); } catch { /* ignora */ }
  if (alvo && eventos.some((e) => e.id === alvo)) {
    $('sel-evento').value = alvo;
    await abrirEvento(alvo);
  }
}

async function criarEvento(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const comFuso = (v) => (v ? `${v}:00-03:00` : undefined);
  const r = await api('POST', '/api/admin/eventos', {
    json: {
      nome: f.get('nome'),
      data: f.get('data'),
      local: f.get('local'),
      abre_em: comFuso(f.get('abre_em')),
      fecha_em: comFuso(f.get('fecha_em')),
      duracao_max_s: Number(f.get('duracao_max_min') || 8) * 60,
      anonimizar_jurados: f.get('anonimizar_jurados') === 'on',
    },
  });
  e.target.reset();
  e.target.closest('details').open = false;
  aviso(`Evento "${r.nome}" criado.`);
  await carregarEventos(r.id);
}

async function abrirEvento(id) {
  eventoId = id || null;
  try { localStorage.setItem(CHAVE_EVENTO, eventoId || ''); } catch { /* ignora */ }
  $('conteudo-evento').hidden = !eventoId;
  $('link-jurados').hidden = !eventoId;
  clearInterval(timerAtualizar);
  if (!eventoId) return;
  await Promise.all([carregarDetalhes(), carregarGravacoes()]);
  if (abaAtual === 'auditoria') await carregarAuditoria();
  timerAtualizar = setInterval(() => carregarGravacoes().catch(() => {}), 10_000);
}

function trocarAba(nome) {
  abaAtual = nome;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('is-active', b.dataset.tab === nome);
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `panel-${nome}`;
  if (nome === 'auditoria' && eventoId) tentar(carregarAuditoria);
}

async function carregarDetalhes() {
  const { coreografias, jurados, link_jurados } = await api('GET', `/api/admin/eventos/${eventoId}`);
  $('link-jurados-url').textContent = link_jurados;
  $('c-jurados').textContent = jurados.length;
  $('c-coreografias').textContent = coreografias.length;

  $('tb-jurados').replaceChildren(
    ...jurados.map((j) =>
      el('tr', {},
        el('td', { textContent: j.ordem }),
        el('td', { textContent: j.nome }),
        el('td', { class: 'ident', textContent: j.email }),
        el('td', {}, el('span', { class: `st ${j.ativo ? 'completo' : 'inativo'}`, textContent: j.ativo ? 'Ativo' : 'Desativado' })),
        el('td', { class: 'acoes' },
          j.ativo
            ? botao('Desativar', 'account-off', () => tentar(() => alterarJurado(j, false)), 'btn btn-sec btn-perigo')
            : botao('Reativar', 'account-check', () => tentar(() => alterarJurado(j, true))),
        ),
      ),
    ),
  );

  $('tb-coreografias').replaceChildren(
    ...coreografias.map((c) =>
      el('tr', {},
        el('td', {}, el('span', { class: 'num', textContent: num(c.numero) })),
        el('td', { textContent: c.nome }),
        el('td', { textContent: c.grupo || '' }),
        el('td', { textContent: c.categoria || '' }),
        el('td', { class: 'acoes' },
          botao('Gerar link', 'link-plus', () => tentar(() => gerarLink(c))),
          botao('Revogar', 'link-off', () => tentar(() => revogarLinks(c)), 'btn btn-sec btn-perigo'),
        ),
      ),
    ),
  );
}

/* ------------------------------ Jurados ------------------------------ */

async function adicionarJurado(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api('POST', `/api/admin/eventos/${eventoId}/jurados`, { json: { nome: f.get('nome'), email: f.get('email') } });
  e.target.reset();
  aviso(`${r.nome} adicionado. Envie o link do app: ele entra com a conta UpDance (${r.email}).`);
  await carregarDetalhes();
}

async function alterarJurado(j, ativo) {
  if (!ativo && !confirm(`Desativar ${j.nome}? O acesso ao festival é cortado na hora (a conta UpDance continua normal).`)) return;
  await api('PATCH', `/api/admin/jurados/${j.id}`, { json: { ativo } });
  aviso(`${j.nome} ${ativo ? 'reativado' : 'desativado'}.`);
  await carregarDetalhes();
}

/* ------------------------------ Coreografias ------------------------------ */

async function importarCsv() {
  let texto = $('csv').value.trim();
  const arquivo = $('arquivo-csv').files[0];
  if (arquivo) texto = await arquivo.text();
  if (!texto) return aviso('Cole o CSV ou escolha um arquivo.', true);
  const r = await api('POST', `/api/admin/eventos/${eventoId}/coreografias`, { texto });
  aviso(`${r.importadas} coreografias importadas.`);
  $('csv').value = '';
  $('arquivo-csv').value = '';
  await carregarDetalhes();
}

async function copiar(textoCopiar) {
  try {
    await navigator.clipboard.writeText(textoCopiar);
    return true;
  } catch {
    return false;
  }
}

async function gerarLink(c) {
  const r = await api('POST', `/api/admin/coreografias/${c.id}/link`, { json: { dias: 30 } });
  const ok = await copiar(r.url);
  prompt(`Link de ${num(c.numero)} · ${c.nome}${ok ? ' (copiado)' : ''}. Válido até ${fmtHora(r.expira_em)}:`, r.url);
}

async function revogarLinks(c) {
  if (!confirm(`Revogar todos os links de entrega de ${c.nome}?`)) return;
  const r = await api('POST', `/api/admin/coreografias/${c.id}/revogar-links`);
  aviso(`${r.revogados} link(s) revogado(s).`);
}

/* ------------------------------ Gravações ------------------------------ */

async function carregarGravacoes() {
  const lista = await api('GET', `/api/admin/eventos/${eventoId}/gravacoes`);
  const completas = lista.filter((g) => g.status === 'completo').length;
  const aprovadas = lista.filter((g) => g.aprovada).length;
  $('c-gravacoes').textContent = lista.length;
  $('resumo-gravacoes').textContent = `${lista.length} gravações · ${completas} completas · ${aprovadas} aprovadas`;

  $('tb-gravacoes').replaceChildren(
    ...lista.map((g) => {
      const status = g.status === 'completo'
        ? el('span', { class: `st ${g.aprovada ? 'aprovada' : 'completo'}`, textContent: g.aprovada ? 'Aprovada' : 'Completa' })
        : el('span', { class: 'st gravando', textContent: `Em andamento · ${g.trechos} trechos` });
      const urlAudio = `/api/admin/gravacoes/${g.id}/audio`;
      return el('tr', {},
        el('td', {}, el('span', { class: 'num', textContent: num(g.numero) })),
        el('td', {}, el('div', { textContent: `${g.coreografia}${g.versao > 1 ? ` (v${g.versao})` : ''}` }), el('div', { class: 'ident', textContent: g.identificador })),
        el('td', { textContent: g.jurado }),
        el('td', {}, status),
        el('td', { textContent: g.duracao_ms ? fmtDuracao(g.duracao_ms) : '—' }),
        el('td', { class: 'acoes' },
          botao('Ouvir', 'play-circle-outline', () => ouvir(g, urlAudio)),
          el('a', { class: 'btn btn-sec', href: `${urlAudio}?download=1`, download: '' }, icone('download'), ' Baixar'),
          g.status === 'completo'
            ? botao(g.aprovada ? 'Retirar aprovação' : 'Aprovar', g.aprovada ? 'close-circle-outline' : 'check-decagram', () => tentar(() => aprovar(g, !g.aprovada)), g.aprovada ? 'btn btn-sec' : 'btn btn-hot')
            : null,
        ),
      );
    }),
  );
}

function ouvir(g, url) {
  const player = $('player');
  player.src = url; // cookie de admin segue junto (mesma origem); Range suportado
  player.hidden = false;
  player.play().catch(() => {});
  aviso(`Tocando: ${g.identificador}${g.status !== 'completo' ? ' (parcial, montado com os trechos recebidos)' : ''}`);
}

async function aprovar(g, aprovada) {
  await api('POST', `/api/admin/gravacoes/${g.id}/aprovar`, { json: { aprovada } });
  await carregarGravacoes();
}

/* ------------------------------ Auditoria ------------------------------ */

async function carregarAuditoria() {
  const linhas = await api('GET', `/api/admin/eventos/${eventoId}/auditoria`);
  $('tb-auditoria').replaceChildren(
    ...linhas.map((l) =>
      el('tr', {},
        el('td', { textContent: fmtHora(l.criado_em) }),
        el('td', { class: 'ident', textContent: l.ator }),
        el('td', { textContent: l.acao }),
        el('td', { class: 'ident', textContent: l.alvo || '' }),
        el('td', { class: 'ident', textContent: l.detalhes || '' }),
      ),
    ),
  );
}

/* ------------------------------ Sessão ------------------------------ */

async function sair() {
  if (!confirm('Sair da conta de administrador UpDance?')) return;
  let destino = '/';
  try { destino = (await api('POST', '/api/admin/logout')).redirect || '/'; } catch { /* segue */ }
  location.href = destino;
}

async function iniciar() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.tab)));
  $('form-evento').addEventListener('submit', (e) => tentar(() => criarEvento(e)));
  $('form-jurado').addEventListener('submit', (e) => tentar(() => adicionarJurado(e)));
  $('btn-importar').addEventListener('click', () => tentar(importarCsv));
  $('sel-evento').addEventListener('change', (e) => tentar(() => abrirEvento(e.target.value)));
  $('btn-atualizar').addEventListener('click', () => tentar(() => abrirEvento(eventoId)));
  $('btn-copiar-link').addEventListener('click', async () => aviso((await copiar($('link-jurados-url').textContent)) ? 'Link copiado.' : 'Copie o link manualmente.'));
  $('btnSair').addEventListener('click', () => tentar(sair));

  await tentar(async () => {
    const eu = await api('GET', '/api/admin/me');
    $('adminEmail').textContent = eu.email;
    $('adminChip').hidden = false;
    $('linkPainelUpdance').href = eu.painel_updance;
    $('linkPainelUpdance').hidden = false;
    await carregarEventos();
  });
}

iniciar();
