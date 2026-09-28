// Notas do jurado — guardadas neste aparelho e enviadas ao servidor (PUT /api/notas/:coreografia).
// Sem rede, a nota fica "pendente" e é reenviada quando a conexão voltar, como os áudios.
//
// localStorage "udx-festival.notas" = { [dono]: { [coreografia_id]: { nota, pendente, erro?, em } } }
// dono = "<evento>:<email>" (a mesma chave usada pela fila de gravações).

import { salvarNota } from './api.js';

const CHAVE = 'udx-festival.notas';

function ler() {
  try { return JSON.parse(localStorage.getItem(CHAVE) || '{}'); } catch { return {}; }
}
function gravar(tudo) {
  try { localStorage.setItem(CHAVE, JSON.stringify(tudo)); } catch { /* sem armazenamento: segue só em memória */ }
}

export function notaDe(dono, coreografiaId) {
  return ler()[dono]?.[coreografiaId] || null;
}

export function todas(dono) {
  return ler()[dono] || {};
}

/** Notas que vieram do servidor valem, exceto as que ainda estão pendentes neste aparelho. */
export function mesclarServidor(dono, notasServidor = {}) {
  const tudo = ler();
  const minhas = tudo[dono] || {};
  const nova = {};
  for (const [id, nota] of Object.entries(notasServidor)) nova[id] = { nota, pendente: false, em: Date.now() };
  for (const [id, n] of Object.entries(minhas)) if (n.pendente || n.erro) nova[id] = n;
  tudo[dono] = nova;
  gravar(tudo);
}

/** Converte "8,7" / "8.7" em número e valida na escala do evento. Devolve { nota } ou { erro }. */
export function interpretar(texto, evento) {
  const s = String(texto ?? '').trim().replace(',', '.');
  if (!s) return { nota: null };
  if (!/^\d+(\.\d+)?$/.test(s)) return { erro: 'Digite um número, ex.: 8,5' };
  const n = Number(s);
  const min = evento.nota_min ?? 0;
  const max = evento.nota_max ?? 10;
  const casas = evento.nota_casas ?? 1;
  if (n < min || n > max) return { erro: `A nota vai de ${formatar(min, casas)} a ${formatar(max, casas)}` };
  const fator = 10 ** casas;
  if (Math.abs(Math.round(n * fator) - n * fator) > 1e-6) return { erro: `Use no máximo ${casas} casa(s) decimal(is)` };
  return { nota: Math.round(n * fator) / fator };
}

export function formatar(nota, casas = 1) {
  if (nota === null || nota === undefined) return '—';
  return Number(nota).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

/** Grava localmente como pendente (null = apagar). */
export function definir(dono, coreografiaId, nota) {
  const tudo = ler();
  tudo[dono] = tudo[dono] || {};
  tudo[dono][coreografiaId] = { nota, pendente: true, em: Date.now() };
  gravar(tudo);
}

let emAndamento = null;

/**
 * Envia as notas pendentes deste dono. Resultado por nota:
 *   ok → pendente=false · sem rede → continua pendente · recusada (fora da escala, prazo…) → erro visível
 * Devolve { enviadas, pendentes, sessaoInvalida }.
 */
export function sincronizar(dono) {
  if (emAndamento) return emAndamento;
  emAndamento = (async () => {
    let enviadas = 0;
    let sessaoInvalida = false;
    const pendentes = Object.entries(todas(dono)).filter(([, n]) => n.pendente);
    for (const [id, n] of pendentes) {
      try {
        const r = await salvarNota(id, n.nota);
        const tudo = ler();
        const atual = tudo[dono]?.[id];
        // só marca como enviada se ninguém alterou a nota durante o envio
        if (atual && atual.em === n.em) {
          if (r.nota === null) delete tudo[dono][id];
          else tudo[dono][id] = { nota: r.nota, pendente: false, em: n.em };
          gravar(tudo);
        }
        enviadas++;
      } catch (e) {
        if (e.status === 0) break; // sem rede: tenta depois
        if (e.status === 401) { sessaoInvalida = true; break; }
        const tudo = ler();
        if (tudo[dono]?.[id]?.em === n.em) {
          tudo[dono][id] = { ...n, pendente: false, erro: e.message };
          gravar(tudo);
        }
      }
    }
    const restantes = Object.values(todas(dono)).filter((n) => n.pendente).length;
    return { enviadas, pendentes: restantes, sessaoInvalida };
  })().finally(() => {
    emAndamento = null;
  });
  return emAndamento;
}
