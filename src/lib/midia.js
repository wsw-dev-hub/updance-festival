// Envio de áudio do R2 com suporte a Range (o Safari/iOS exige 206 para tocar <audio>).

import { CABECALHOS_SEGURANCA, disposicao, ErroHttp } from './http.js';

function analisarRange(cabecalho, tamanho) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(cabecalho || '');
  if (!m || (!m[1] && !m[2])) return null;
  let inicio, fim;
  if (!m[1]) {
    const sufixo = Number(m[2]);
    inicio = Math.max(tamanho - sufixo, 0);
    fim = tamanho - 1;
  } else {
    inicio = Number(m[1]);
    fim = m[2] ? Math.min(Number(m[2]), tamanho - 1) : tamanho - 1;
  }
  if (inicio > fim || inicio >= tamanho) return 'invalido';
  return { offset: inicio, length: fim - inicio + 1 };
}

/**
 * @param {Request} request
 * @param {R2Bucket} bucket
 * @param {string} chave
 * @param {object} opcoes { nomeArquivo, tipoMime, download }
 */
export async function servirAudio(request, bucket, chave, { nomeArquivo, tipoMime, download = false }) {
  const cabecalho = await bucket.head(chave);
  if (!cabecalho) throw new ErroHttp(404, 'Áudio não encontrado', 'nao_encontrado');
  const tamanho = cabecalho.size;

  const range = analisarRange(request.headers.get('Range'), tamanho);
  if (range === 'invalido') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${tamanho}`, ...CABECALHOS_SEGURANCA } });
  }

  const obj = await bucket.get(chave, range ? { range } : {});
  if (!obj) throw new ErroHttp(404, 'Áudio não encontrado', 'nao_encontrado');

  const headers = {
    'Content-Type': tipoMime || cabecalho.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Disposition': disposicao(download ? 'attachment' : 'inline', nomeArquivo),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    ...CABECALHOS_SEGURANCA,
  };
  if (range) {
    headers['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${tamanho}`;
    headers['Content-Length'] = String(range.length);
    return new Response(obj.body, { status: 206, headers });
  }
  headers['Content-Length'] = String(tamanho);
  return new Response(obj.body, { status: 200, headers });
}
