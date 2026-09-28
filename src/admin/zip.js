// ZIP sem compressão ("store"), montado no navegador.
// Áudio (WebM/MP4) já é comprimido: compactar de novo não reduz o tamanho e só gastaria CPU.
// Montar no navegador evita estourar o limite de CPU do Worker no plano gratuito.

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dataDos(d = new Date()) {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dia = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, dia };
}

/**
 * @param {{ nome: string, bytes: Uint8Array, data?: Date }[]} arquivos
 * @returns {Blob} application/zip
 */
export function montarZip(arquivos) {
  const enc = new TextEncoder();
  const partes = [];
  const central = [];
  let deslocamento = 0;

  for (const a of arquivos) {
    const nome = enc.encode(a.nome);
    const crc = crc32(a.bytes);
    const { hora, dia } = dataDos(a.data);
    const tam = a.bytes.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // assinatura
    local.setUint16(4, 20, true);         // versão necessária
    local.setUint16(6, 0x0800, true);     // bit 11: nomes em UTF-8
    local.setUint16(8, 0, true);          // método: store
    local.setUint16(10, hora, true);
    local.setUint16(12, dia, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, tam, true);
    local.setUint32(22, tam, true);
    local.setUint16(26, nome.length, true);
    local.setUint16(28, 0, true);
    partes.push(local.buffer, nome, a.bytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);            // feito por
    cd.setUint16(6, 20, true);            // versão necessária
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, hora, true);
    cd.setUint16(14, dia, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, tam, true);
    cd.setUint32(24, tam, true);
    cd.setUint16(28, nome.length, true);
    cd.setUint32(42, deslocamento, true);  // posição do cabeçalho local
    central.push(cd.buffer, nome);

    deslocamento += 30 + nome.length + tam;
  }

  const tamCentral = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  const fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true);
  fim.setUint16(8, arquivos.length, true);
  fim.setUint16(10, arquivos.length, true);
  fim.setUint32(12, tamCentral, true);
  fim.setUint32(16, deslocamento, true);
  return new Blob([...partes, ...central, fim.buffer], { type: 'application/zip' });
}
