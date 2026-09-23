// Captura de áudio com MediaRecorder: gravar, pausar, retomar, encerrar.
// Entrega um trecho a cada INTERVALO_TRECHO_MS para ser salvo localmente e enviado.

export const INTERVALO_TRECHO_MS = 10_000;
const TAXA_BITS = 32_000; // voz em Opus: ~14 MB por hora

const CANDIDATOS = [
  'audio/webm;codecs=opus', // Chrome, Edge, Android, Firefox
  'audio/mp4;codecs=mp4a.40.2', // Safari / iOS
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

export function suportado() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

export function escolherFormato() {
  return CANDIDATOS.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export class Gravador {
  constructor() {
    this.stream = null;
    this.recorder = null;
    this.seq = 0;
    this.inicioAtivo = 0;   // quando começou o trecho ativo atual (para o cronômetro)
    this.acumulado = 0;     // tempo gravado antes da última pausa
    this.analisador = null;
    this.ctxAudio = null;
    /** Chamado se o microfone cair (ligação, outro app, fone desconectado, tela bloqueada no iOS). */
    this.aoPerderMicrofone = null;
  }

  get microfoneAtivo() {
    return !!this.stream?.active && this.stream.getAudioTracks().some((t) => t.readyState === 'live');
  }

  /** Abre o microfone uma vez (a permissão fica ativa durante a sessão). Precisa de um toque do usuário. */
  async preparar() {
    if (this.microfoneAtivo) return;
    this.liberar();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true, // ajuda a destacar a voz sobre a música
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (e) {
      // Alguns aparelhos recusam as opções acima: tenta o pedido mais simples antes de desistir
      if (e?.name !== 'OverconstrainedError' && e?.name !== 'TypeError') throw e;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    for (const trilha of this.stream.getAudioTracks()) {
      trilha.addEventListener('ended', () => this.aoPerderMicrofone?.());
    }
    try {
      const Contexto = window.AudioContext || window.webkitAudioContext;
      this.ctxAudio = new Contexto();
      const fonte = this.ctxAudio.createMediaStreamSource(this.stream);
      this.analisador = this.ctxAudio.createAnalyser();
      this.analisador.fftSize = 512;
      fonte.connect(this.analisador);
    } catch {
      this.analisador = null; // medidor de nível é opcional
    }
  }

  /** Nível de 0 a 1 para o medidor visual. */
  nivel() {
    if (!this.analisador) return 0;
    if (this.ctxAudio.state === 'suspended') this.ctxAudio.resume().catch(() => {});
    const dados = new Uint8Array(this.analisador.fftSize);
    this.analisador.getByteTimeDomainData(dados);
    let soma = 0;
    for (const v of dados) soma += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(soma / dados.length) * 4);
  }

  get estado() {
    return this.recorder?.state || 'inactive'; // inactive | recording | paused
  }

  get mimeType() {
    return this.recorder?.mimeType || escolherFormato();
  }

  duracaoMs() {
    if (this.estado === 'recording') return this.acumulado + (performance.now() - this.inicioAtivo);
    return this.acumulado;
  }

  /**
   * @param {(seq:number, blob:Blob) => void} aoReceberTrecho
   */
  iniciar(aoReceberTrecho) {
    if (!this.stream?.active) throw new Error('Microfone não preparado');
    const mimeType = escolherFormato();
    this.recorder = new MediaRecorder(this.stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: TAXA_BITS });
    this.seq = 0;
    this.acumulado = 0;
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) aoReceberTrecho(this.seq++, e.data);
    };
    this.recorder.start(INTERVALO_TRECHO_MS);
    this.inicioAtivo = performance.now();
  }

  pausar() {
    if (this.estado !== 'recording') return;
    this.acumulado += performance.now() - this.inicioAtivo;
    this.recorder.pause();
    // Força a entrega do trecho atual: a pausa é um bom momento para salvar
    try { this.recorder.requestData(); } catch { /* alguns navegadores não permitem em pausa */ }
  }

  retomar() {
    if (this.estado !== 'paused') return;
    this.recorder.resume();
    this.inicioAtivo = performance.now();
  }

  /** Encerra e resolve depois que o último trecho foi entregue. */
  parar() {
    return new Promise((resolve) => {
      if (!this.recorder || this.estado === 'inactive') return resolve(this.acumulado);
      if (this.estado === 'recording') this.acumulado += performance.now() - this.inicioAtivo;
      const duracao = this.acumulado;
      this.recorder.addEventListener('stop', () => resolve(duracao), { once: true });
      this.recorder.stop();
    });
  }

  /** Libera o microfone (ao sair). */
  liberar() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctxAudio?.close().catch(() => {});
    this.ctxAudio = null;
    this.analisador = null;
  }
}
