// Utilidades compartilhadas pela área de admin (dashboard) e pela tela exclusiva do evento.

export const $ = (id) => document.getElementById(id);
export const num = (n) => String(n).padStart(3, '0');
const FUSO_MS = 3 * 3600_000; // America/Sao_Paulo (UTC-3, sem horário de verão)

/* ------------------------------ API ------------------------------ */

export async function api(metodo, caminho, { json, texto } = {}) {
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
  const dados = await resp.json().catch(() => ({}));
  if (resp.status === 401 || (resp.status === 403 && dados.codigo === 'trocar_senha')) {
    location.href = `/admin-login/?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Sessão encerrada. Redirecionando para o login…');
  }
  if (!resp.ok) {
    const e = new Error(dados.erro || `Erro ${resp.status}`);
    e.status = resp.status;
    e.codigo = dados.codigo;
    throw e;
  }
  return dados;
}

/* ------------------------------ mensagens ------------------------------ */

export function aviso(texto, erro = false) {
  $('mensagem').textContent = texto;
  $('mensagem').className = `mensagem${erro ? ' erro' : ''}`;
}

export async function tentar(fn) {
  try {
    await fn();
  } catch (e) {
    aviso(e.message, true);
  }
}

/* ------------------------------ DOM ------------------------------ */

export function el(tag, props = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'style') Object.assign(e.style, v); // CSSOM: permitido pela CSP (sem style inline)
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e[k] = v;
  }
  e.append(...filhos.flat().filter((f) => f != null && f !== false));
  return e;
}

export const icone = (nome) => el('i', { class: `mdi mdi-${nome}`, ariaHidden: 'true' });
export const botao = (rotulo, nomeIcone, onclick, classe = 'btn btn-sec') =>
  el('button', { class: classe, type: 'button', onclick: () => tentar(onclick) }, icone(nomeIcone), ` ${rotulo}`);
export const selo = (classe, texto) => el('span', { class: `st ${classe}`, textContent: texto });
export const vazio = (colunas, texto) => el('tr', {}, el('td', { colSpan: colunas, class: 'muted', textContent: texto }));

/* ------------------------------ formatação ------------------------------ */

export const fmtDuracao = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const fmtHora = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—');
export const fmtData = (d) => (d ? d.split('-').reverse().join('/') : '');
/** ms → valor de <input type="datetime-local"> no horário de Brasília */
export const paraCampo = (ms) => (ms ? new Date(ms - FUSO_MS).toISOString().slice(0, 16) : '');
export const comFuso = (v) => (v ? `${v}:00-03:00` : undefined);
export const fmtNota = (n, casas = 1) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

export const FORMACOES = [
  { id: 'solo', rotulo: 'Solos', um: 'Solo' },
  { id: 'duo', rotulo: 'Duos', um: 'Duo' },
  { id: 'trio', rotulo: 'Trios', um: 'Trio' },
  { id: 'grupo', rotulo: 'Grupos', um: 'Grupo' },
];
export const rotuloFormacao = (f) => FORMACOES.find((x) => x.id === f)?.um || 'Sem formação';

/** Situação do evento pelo horário. */
export function situacaoEvento(e, agora = Date.now()) {
  if (agora < e.abre_em) return { classe: 'provisoria', texto: 'Em breve' };
  if (agora <= e.fecha_em) return { classe: 'completo', texto: 'Aberto para avaliação' };
  return { classe: 'inativo', texto: 'Encerrado' };
}

export function situacaoConta(c) {
  if (!c.ativo) return selo('inativo', 'Desativada');
  if (c.bloqueado_ate && c.bloqueado_ate > Date.now()) return selo('bloqueado', 'Bloqueada (tentativas)');
  if (c.trocar_senha) return selo('provisoria', 'Senha provisória');
  return selo('completo', 'Ativa');
}

/* ------------------------------ diversos ------------------------------ */

export async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    return false;
  }
}

/** Quadro da senha provisória (aparece uma única vez). */
export function mostrarSenha(titulo, senha) {
  $('caixa-senha-titulo').textContent = titulo;
  $('caixa-senha-valor').textContent = senha;
  $('caixa-senha').hidden = false;
  $('caixa-senha').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function ligarCaixaSenha() {
  $('btn-copiar-senha').addEventListener('click', async () =>
    aviso((await copiar($('caixa-senha-valor').textContent)) ? 'Senha copiada.' : 'Copie a senha manualmente.'));
  $('btn-fechar-senha').addEventListener('click', () => {
    $('caixa-senha').hidden = true;
    $('caixa-senha-valor').textContent = '';
  });
}

export function guardar(chave, valor) {
  try { localStorage.setItem(chave, valor); } catch { /* armazenamento indisponível */ }
}
export function ler(chave) {
  try { return localStorage.getItem(chave); } catch { return null; }
}

/** Troca da própria senha (form com campos atual, nova, confirma). */
export async function trocarMinhaSenha(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get('nova') !== f.get('confirma')) return aviso('As senhas novas não conferem.', true);
  await api('POST', '/api/admin/senha', { json: { atual: f.get('atual'), nova: f.get('nova') } });
  e.target.reset();
  aviso('Senha alterada. Suas sessões em outros aparelhos foram encerradas.');
}

export async function sair() {
  if (!confirm('Sair da área de admin?')) return;
  try { await api('POST', '/api/admin/logout'); } catch { /* segue para o login mesmo assim */ }
  location.href = '/admin-login/';
}

/** Baixa um CSV (separador ;, com BOM para abrir certo no Excel). */
export function baixarCsv(nome, linhas) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const texto = '﻿' + linhas.map((l) => l.map(esc).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: nome });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
