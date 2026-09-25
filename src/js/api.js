// Cliente da API do festival.
// A sessão é um cookie HttpOnly (m_session): nenhum token fica no JavaScript.
// Só os dados do evento ficam em cache local, para o app abrir e gravar mesmo sem rede.

const CHAVE_CACHE = 'udx-festival.sessao';

export class ErroApi extends Error {
  constructor(status, codigo, mensagem) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
  }
}

export function lerCache() {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_CACHE) || 'null');
  } catch {
    return null;
  }
}
export function salvarCache(s) {
  try { localStorage.setItem(CHAVE_CACHE, JSON.stringify(s)); } catch { /* sem armazenamento */ }
}
export function esquecerCache() {
  try { localStorage.removeItem(CHAVE_CACHE); } catch { /* ignora */ }
}

/** Diferença entre o relógio do servidor e o do aparelho (ms), pelo ponto médio da requisição. */
export function calcularDiferencaRelogio(horarioServidor, enviadoEm, recebidoEm) {
  return Math.round(horarioServidor - (enviadoEm + recebidoEm) / 2);
}

async function chamar(metodo, caminho, { json, corpo, cabecalhos = {}, tempoLimite = 30_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), tempoLimite);
  // Cabeçalho próprio: o servidor recusa escritas sem ele (proteção contra CSRF)
  const headers = { 'X-UDX-Festival': '1', ...cabecalhos };
  let body = corpo;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let resp;
  try {
    resp = await fetch(caminho, { method: metodo, headers, body, signal: ctrl.signal, cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw new ErroApi(0, 'sem_rede', 'Sem conexão');
  } finally {
    clearTimeout(timer);
  }
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new ErroApi(resp.status, dados.codigo || 'erro', dados.erro || `Erro ${resp.status}`);
  return dados;
}

export async function carregarSessao(eventoId) {
  const enviadoEm = Date.now();
  const q = eventoId ? `?evento=${encodeURIComponent(eventoId)}` : '';
  const d = await chamar('GET', `/api/sessao${q}`);
  d.diferenca_relogio = calcularDiferencaRelogio(d.horario_servidor, enviadoEm, Date.now());
  return d;
}

// Rotas de acesso no padrão do worker do blog UpDance (/api/member/*)
export const entrar = (email, password) => chamar('POST', '/api/member/login', { json: { email, password } });
export const trocarSenha = (nova, atual) => chamar('POST', '/api/member/senha', { json: { nova, atual } });
export const esqueciSenha = (email) => chamar('POST', '/api/member/forgot', { json: { email } });
export const sair = () => chamar('POST', '/api/member/logout', { tempoLimite: 8000 });

export const registrarGravacao = (g) =>
  chamar('PUT', `/api/gravacoes/${g.id}`, { json: { coreografia_id: g.coreografia_id, mime: g.mime, iniciado_em: g.iniciado_em } });

export const enviarTrecho = (gravacaoId, seq, blob) =>
  chamar('PUT', `/api/gravacoes/${gravacaoId}/trechos/${seq}`, { corpo: blob, cabecalhos: { 'Content-Type': 'application/octet-stream' } });

export const finalizar = (gravacaoId, blob, sha256, duracaoMs) =>
  chamar('POST', `/api/gravacoes/${gravacaoId}/finalizar`, {
    corpo: blob,
    cabecalhos: {
      'Content-Type': 'application/octet-stream',
      'X-Conteudo-SHA256': sha256,
      'X-Duracao-Ms': String(Math.round(duracaoMs)),
    },
    tempoLimite: 120_000,
  });
