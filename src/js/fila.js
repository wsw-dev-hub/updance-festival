// Armazenamento local (IndexedDB): nenhum áudio depende da internet para existir.
// Cada trecho é salvo aqui ANTES de qualquer tentativa de envio.

const NOME_BANCO = 'jurados-audio';
const VERSAO = 1;
let bancoPromessa = null;

function abrir() {
  if (!bancoPromessa) {
    bancoPromessa = new Promise((resolve, reject) => {
      const req = indexedDB.open(NOME_BANCO, VERSAO);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('gravacoes')) db.createObjectStore('gravacoes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('trechos')) {
          const t = db.createObjectStore('trechos', { keyPath: ['gravacao_id', 'seq'] });
          t.createIndex('por_gravacao', 'gravacao_id');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return bancoPromessa;
}

function comoPromessa(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function fimTransacao(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transação abortada'));
  });
}

/** Pede ao navegador que não apague este armazenamento sob pressão de espaço. */
export async function pedirPersistencia() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* opcional */ }
}

export async function salvarGravacao(g) {
  const db = await abrir();
  const tx = db.transaction('gravacoes', 'readwrite');
  tx.objectStore('gravacoes').put(g);
  await fimTransacao(tx);
  return g;
}

export async function obterGravacao(id) {
  const db = await abrir();
  return comoPromessa(db.transaction('gravacoes').objectStore('gravacoes').get(id));
}

export async function atualizarGravacao(id, mudancas) {
  const db = await abrir();
  const tx = db.transaction('gravacoes', 'readwrite');
  const store = tx.objectStore('gravacoes');
  const atual = await comoPromessa(store.get(id));
  if (atual) store.put({ ...atual, ...mudancas });
  await fimTransacao(tx);
  return atual ? { ...atual, ...mudancas } : null;
}

export async function listarGravacoes() {
  const db = await abrir();
  const todas = await comoPromessa(db.transaction('gravacoes').objectStore('gravacoes').getAll());
  return todas.sort((a, b) => a.iniciado_em - b.iniciado_em);
}

export async function adicionarTrecho(gravacaoId, seq, blob) {
  const db = await abrir();
  const tx = db.transaction(['trechos', 'gravacoes'], 'readwrite');
  tx.objectStore('trechos').put({ gravacao_id: gravacaoId, seq, blob, enviado: false });
  const store = tx.objectStore('gravacoes');
  const g = await comoPromessa(store.get(gravacaoId));
  if (g) store.put({ ...g, total_trechos: Math.max(g.total_trechos || 0, seq + 1) });
  await fimTransacao(tx);
}

export async function trechosDe(gravacaoId) {
  const db = await abrir();
  const idx = db.transaction('trechos').objectStore('trechos').index('por_gravacao');
  const lista = await comoPromessa(idx.getAll(IDBKeyRange.only(gravacaoId)));
  return lista.sort((a, b) => a.seq - b.seq);
}

export async function marcarTrechoEnviado(gravacaoId, seq) {
  const db = await abrir();
  const tx = db.transaction('trechos', 'readwrite');
  const store = tx.objectStore('trechos');
  const t = await comoPromessa(store.get([gravacaoId, seq]));
  if (t) store.put({ ...t, enviado: true });
  await fimTransacao(tx);
}

/** Apaga o áudio local. Chamado SOMENTE depois que o servidor confirmou o hash do arquivo final. */
export async function apagarAudioLocal(gravacaoId) {
  const db = await abrir();
  const tx = db.transaction('trechos', 'readwrite');
  const store = tx.objectStore('trechos');
  const chaves = await comoPromessa(store.index('por_gravacao').getAllKeys(IDBKeyRange.only(gravacaoId)));
  for (const k of chaves) store.delete(k);
  await fimTransacao(tx);
}

/** Remove registros já enviados há mais de 2 dias (mantém o histórico curto). */
export async function limparHistorico() {
  const limite = Date.now() - 2 * 86400_000;
  const db = await abrir();
  const tx = db.transaction('gravacoes', 'readwrite');
  const store = tx.objectStore('gravacoes');
  const todas = await comoPromessa(store.getAll());
  for (const g of todas) if (g.status === 'enviada' && g.iniciado_em < limite) store.delete(g.id);
  await fimTransacao(tx);
}
