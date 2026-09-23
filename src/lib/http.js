// Respostas HTTP padronizadas, cabeçalhos de segurança e roteador mínimo.

export const CABECALHOS_SEGURANCA = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

export class ErroHttp extends Error {
  constructor(status, mensagem, codigo) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo || 'erro';
  }
}

export function json(dados, status = 200, extras = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CABECALHOS_SEGURANCA,
      ...extras,
    },
  });
}

export function erro(status, mensagem, codigo) {
  return json({ erro: mensagem, codigo: codigo || 'erro' }, status);
}

export async function lerJson(request, limiteBytes = 64 * 1024) {
  const tipo = request.headers.get('Content-Type') || '';
  if (!tipo.includes('application/json')) throw new ErroHttp(415, 'Envie JSON', 'tipo_invalido');
  const texto = await lerTexto(request, limiteBytes);
  try {
    return JSON.parse(texto);
  } catch {
    throw new ErroHttp(400, 'JSON inválido', 'json_invalido');
  }
}

export async function lerTexto(request, limiteBytes) {
  const buf = await lerBytes(request, limiteBytes);
  return new TextDecoder().decode(buf);
}

/** Lê o corpo inteiro respeitando um limite (não confia só no Content-Length). */
export async function lerBytes(request, limiteBytes) {
  const declarado = Number(request.headers.get('Content-Length') || 0);
  if (declarado > limiteBytes) throw new ErroHttp(413, 'Conteúdo grande demais', 'grande_demais');
  if (!request.body) return new Uint8Array(0);
  const leitor = request.body.getReader();
  const pedacos = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limiteBytes) {
      await leitor.cancel();
      throw new ErroHttp(413, 'Conteúdo grande demais', 'grande_demais');
    }
    pedacos.push(value);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of pedacos) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

export function ipDe(request) {
  return request.headers.get('CF-Connecting-IP') || '0.0.0.0';
}

/** Content-Disposition seguro (o identificador já é ASCII normalizado). */
export function disposicao(tipo, nomeArquivo) {
  const seguro = String(nomeArquivo).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${tipo}; filename="${seguro}"`;
}

/** Roteador simples: rota('GET', '/api/x/:id', fn). */
export class Roteador {
  constructor() {
    this.rotas = [];
  }
  rota(metodo, padrao, fn) {
    const nomes = [];
    const re = new RegExp(
      '^' +
        padrao.replace(/:([a-zA-Z_]+)/g, (_, nome) => {
          nomes.push(nome);
          return '([^/]+)';
        }) +
        '$',
    );
    this.rotas.push({ metodo, re, nomes, fn });
    return this;
  }
  encontrar(metodo, caminho) {
    let caminhoExiste = false;
    for (const r of this.rotas) {
      const m = caminho.match(r.re);
      if (!m) continue;
      caminhoExiste = true;
      if (r.metodo !== metodo) continue;
      const params = {};
      r.nomes.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      return { fn: r.fn, params };
    }
    return caminhoExiste ? { metodoNaoPermitido: true } : null;
  }
}
