// Geração do identificador descritivo dos áudios.
//
// Formato:
//   {numero}_{coreografia}_{evento}_{jurado}_{AAAA-MM-DD}_{HHhMMmSS}[_vN].{ext}
// Exemplo:
//   012_bolero-de-ravel_festival-danca-sul-2026_maria-aparecida-silva_2026-10-15_14h32m07.webm
//
// O identificador é usado SOMENTE como nome do arquivo no download
// (Content-Disposition). No R2 o arquivo fica sob uma chave aleatória (UUID),
// para que ninguém consiga acessar um áudio adivinhando o nome.

export const LIMITE_POR_PARTE = 40;

export const EXTENSOES = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
};

/** Tipo MIME base (sem parâmetros de codec), ou null se não permitido. */
export function mimeBase(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return Object.hasOwn(EXTENSOES, base) ? base : null;
}

/**
 * Normaliza um texto para uso seguro em nome de arquivo:
 * minúsculas, sem acentos, só [a-z0-9] e hífen, até `limite` caracteres
 * (cortando em palavra inteira quando possível).
 */
export function normalizar(texto, limite = LIMITE_POR_PARTE) {
  let s = String(texto ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'o')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (s.length > limite) {
    const corte = s.slice(0, limite + 1);
    const ultimoHifen = corte.lastIndexOf('-');
    // Corta na última palavra inteira, se isso não encurtar demais
    s = ultimoHifen >= limite / 2 ? corte.slice(0, ultimoHifen) : s.slice(0, limite);
    s = s.replace(/-+$/g, '');
  }
  return s || 'sem-nome';
}

/** Número da coreografia com 3 dígitos (ordena corretamente em listagens). */
export function formatarNumero(numero) {
  const n = Number.parseInt(numero, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error('numero de coreografia invalido');
  return String(n).padStart(3, '0');
}

/**
 * Data e hora locais do evento, sem ":" (proibido em nomes de arquivo no Windows).
 * Retorna { data: "2026-10-15", hora: "14h32m07" }.
 */
export function formatarDataHora(ms, fuso = 'America/Sao_Paulo') {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: fuso,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return {
    data: `${partes.year}-${partes.month}-${partes.day}`,
    hora: `${partes.hour}h${partes.minute}m${partes.second}`,
  };
}

/**
 * Monta o identificador completo.
 * @param {object} p
 * @param {number} p.numero          número da coreografia
 * @param {string} p.coreografia     nome da coreografia
 * @param {string} p.evento          nome do evento
 * @param {string} p.jurado          nome do jurado (ou "jurado-N" na versão anonimizada)
 * @param {number} p.iniciadoEm      início da gravação, ms UTC
 * @param {string} [p.fuso]          fuso do evento
 * @param {number} [p.versao]        1 = original; 2+ = regravação (_v2, _v3...)
 * @param {string} p.extensao        webm | m4a | ogg
 */
export function gerarIdentificador({ numero, coreografia, evento, jurado, iniciadoEm, fuso, versao = 1, extensao }) {
  if (!Object.values(EXTENSOES).includes(extensao)) throw new Error('extensao invalida');
  const { data, hora } = formatarDataHora(iniciadoEm, fuso);
  const partes = [
    formatarNumero(numero),
    normalizar(coreografia),
    normalizar(evento),
    normalizar(jurado),
    data,
    hora,
  ];
  if (versao > 1) partes.push(`v${versao}`);
  return `${partes.join('_')}.${extensao}`;
}

/** Gera as duas versões: interna (com nome do jurado) e pública (anonimizada se o evento exigir). */
export function gerarIdentificadores({ evento, coreografia, jurado, iniciadoEm, versao, extensao }) {
  const base = {
    numero: coreografia.numero,
    coreografia: coreografia.nome,
    evento: evento.nome,
    iniciadoEm,
    fuso: evento.fuso,
    versao,
    extensao,
  };
  const interno = gerarIdentificador({ ...base, jurado: jurado.nome });
  const publico = evento.anonimizar_jurados
    ? gerarIdentificador({ ...base, jurado: `jurado-${jurado.ordem}` })
    : interno;
  return { interno, publico };
}
