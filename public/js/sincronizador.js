// Envia em segundo plano tudo o que está no IndexedDB, com novas tentativas automáticas.
//
// Ordem por gravação:
//   1. registra a gravação no servidor (PUT, idempotente)
//   2. enquanto grava: envia os trechos de 10 s (cópia de segurança)
//   3. depois de encerrada: envia o arquivo completo + SHA-256
//   4. só apaga o áudio local quando o servidor confirma o mesmo hash

import * as fila from './fila.js';
import * as api from './api.js';

const ATRASO_MIN = 2_000;
const ATRASO_MAX = 60_000;

export async function sha256DoBlob(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Sincronizador {
  /**
   * @param {object} o
   * @param {() => object|null} o.obterSessao
   * @param {(resumo: object) => void} o.aoMudar
   * @param {() => void} o.aoSessaoInvalida
   */
  constructor({ obterSessao, aoMudar, aoSessaoInvalida }) {
    this.obterSessao = obterSessao;
    this.aoMudar = aoMudar;
    this.aoSessaoInvalida = aoSessaoInvalida;
    this.rodando = false;
    this.repetir = false;
    this.timer = null;
    this.atraso = ATRASO_MIN;
    this.offline = !navigator.onLine;
  }

  agendar(ms = 0) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.executar(), ms);
  }

  async resumo() {
    const s = this.obterSessao();
    const minhas = s ? (await fila.listarGravacoes()).filter((g) => g.dono === s.dono) : [];
    const pendentes = minhas.filter((g) => g.status !== 'enviada' && !g.erro).length;
    const comErro = minhas.filter((g) => g.erro && g.status !== 'enviada').length;
    return { pendentes, comErro, offline: this.offline, enviando: this.rodando, gravacoes: minhas };
  }

  async notificar() {
    try { this.aoMudar(await this.resumo()); } catch { /* UI */ }
  }

  async executar() {
    if (this.rodando) {
      this.repetir = true;
      return;
    }
    const sessao = this.obterSessao();
    if (!sessao) return;
    this.rodando = true;
    await this.notificar();

    let falhaTemporaria = false;
    try {
      const todas = await fila.listarGravacoes();
      for (const g of todas) {
        if (g.dono !== sessao.dono || g.status === 'enviada' || g.erro) continue;
        try {
          await this.processar(sessao, g);
        } catch (e) {
          if (e instanceof api.ErroApi) {
            if (e.status === 401) {
              this.aoSessaoInvalida();
              return;
            }
            if (e.status === 0 || e.status >= 500 || e.status === 429 || e.codigo === 'hash_divergente') {
              falhaTemporaria = true;
              this.offline = e.status === 0;
              break; // tenta tudo de novo mais tarde
            }
            // Erro definitivo (prazo encerrado, conflito...): marca e NÃO apaga o áudio local
            await fila.atualizarGravacao(g.id, { erro: e.message });
          } else {
            console.error(e);
            falhaTemporaria = true;
          }
        }
      }
      if (!falhaTemporaria) this.offline = false;
    } finally {
      this.rodando = false;
      await this.notificar();
    }

    if (this.repetir) {
      this.repetir = false;
      this.agendar(0);
    } else if (falhaTemporaria) {
      this.agendar(this.atraso);
      this.atraso = Math.min(this.atraso * 2, ATRASO_MAX);
    } else {
      this.atraso = ATRASO_MIN;
    }
  }

  async processar(sessao, g) {
    if (!g.registrada) {
      const r = await api.registrarGravacao(g);
      g = await fila.atualizarGravacao(g.id, { registrada: true, identificador: r.identificador, versao: r.versao });
    }

    const trechos = await fila.trechosDe(g.id);

    if (g.status === 'gravando') {
      for (const t of trechos) {
        if (t.enviado) continue;
        await api.enviarTrecho(g.id, t.seq, t.blob);
        await fila.marcarTrechoEnviado(g.id, t.seq);
      }
      return;
    }

    if (g.status === 'pendente') {
      if (!trechos.length) {
        await fila.atualizarGravacao(g.id, { erro: 'Nenhum áudio foi capturado' });
        return;
      }
      const arquivo = new Blob(trechos.map((t) => t.blob), { type: g.mime });
      const sha = await sha256DoBlob(arquivo);
      const r = await api.finalizar(g.id, arquivo, sha, g.duracao_ms || 0);
      if (r.sha256 !== sha) throw new api.ErroApi(422, 'hash_divergente', 'Hash divergente');
      await fila.apagarAudioLocal(g.id);
      await fila.atualizarGravacao(g.id, { status: 'enviada', sha256: sha, enviada_em: Date.now() });
    }
  }
}
