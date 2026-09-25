// UpDance Festival — app do jurado.
// Login próprio (e-mail + senha), definição de senha no 1º acesso, escolha do evento,
// teste do microfone, e gravar / pausar / encerrar com fila offline.

import * as api from './api.js';
import * as fila from './fila.js';
import { Gravador, suportado } from './gravador.js';
import { Sincronizador } from './sincronizador.js';
import { detectarPlataforma, verificarAmbiente, estadoPermissao, explicarErroMicrofone } from './microfone.js';

const $ = (id) => document.getElementById(id);
const TEMPO_SEGURAR_MS = 900;
const CHAVE_MIC_OK = 'udx-festival.microfoneTestado';
const TELAS = ['tela-carregando', 'tela-acesso', 'tela-senha', 'tela-eventos', 'tela-microfone', 'tela-principal'];
const plataforma = detectarPlataforma();

const estado = {
  sessao: null,
  offline: false,
  indice: 0,
  gravacaoAtual: null,
  escritas: Promise.resolve(),
  gravador: new Gravador(),
  sessaoInvalida: false,
  avisoFinal: false,
  encerrando: false,
  wakeLock: null,
  timerTela: null,
  timerSessao: null,
  gravadasServidor: new Set(),
  gravadasLocal: new Set(),
};

const sinc = new Sincronizador({
  obterSessao: () => (estado.sessaoInvalida ? null : estado.sessao),
  aoMudar: renderizarStatus,
  aoSessaoInvalida: tratarSemSessao,
});

const mostrarTelas = (nome) => TELAS.forEach((t) => ($(t).hidden = t !== nome));
const num = (n) => String(n).padStart(3, '0');
const agoraServidor = () => Date.now() + (estado.sessao?.diferenca_relogio || 0);
const hora = (ms) => new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

/* ------------------------------ Início ------------------------------ */

async function iniciar() {
  // Só no build de produção: no `vite` dev o SW guardaria arquivos que mudam a cada edição
  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {});
  fila.pedirPersistencia();
  fila.limparHistorico().catch(() => {});

  window.addEventListener('online', () => { sinc.agendar(0); if (estado.offline) atualizarDoServidor(); });
  window.addEventListener('offline', () => sinc.notificar());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      manterTelaLigada();
      sinc.agendar(0);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (estado.gravador.estado !== 'inactive') {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Se o microfone cair (ligação, outro app, fone desconectado, tela bloqueada no iPhone)
  estado.gravador.aoPerderMicrofone = () => {
    if (estado.gravador.estado === 'inactive') return;
    mostrarAlerta('O microfone foi interrompido (ligação, outro app ou tela bloqueada). A gravação foi encerrada e o que foi gravado está salvo.');
    vibrar([300, 100, 300]);
    encerrar();
  };

  ligarEventos();
  const problemas = mostrarAvisosDoNavegador();
  if (problemas.some((p) => p.fatal) || !suportado()) {
    mostrarLogin();
    $('btn-entrar').disabled = true;
    $('msg-entrar').textContent = 'Este navegador não grava áudio. Use o Chrome (Android/computador) ou o Safari (iPhone) atualizados.';
    return;
  }
  await carregar();
}

/* ------------------------------ Acesso / evento ------------------------------ */

/** Busca a sessão no servidor. Sem rede, usa o cache do último acesso para continuar gravando. */
async function carregar(eventoEscolhido) {
  const pedido = eventoEscolhido || new URLSearchParams(location.search).get('evento') || api.lerCache()?.evento?.id || '';
  let d;
  try {
    d = await api.carregarSessao(pedido);
  } catch (e) {
    if (e.status === 0) {
      const cache = api.lerCache();
      if (cache?.evento) {
        estado.sessao = cache;
        estado.offline = true;
        await entrarNoApp();
        mostrarAlerta('Sem conexão: usando os dados salvos neste aparelho. As gravações serão enviadas quando a rede voltar.');
        return;
      }
      mostrarLogin('Sem conexão. O primeiro acesso precisa de internet.');
      return;
    }
    if (e.status === 401) return mostrarLogin();
    if (e.codigo === 'trocar_senha') return mostrarTrocaSenha();
    if (e.codigo === 'nao_jurado') return mostrarLogin(`${e.message} Fale com a organização ou entre com outra conta.`);
    mostrarLogin(e.message);
    return;
  }

  estado.offline = false;
  if (!d.evento) return mostrarEventos(d);
  aplicarDados(d);
  await entrarNoApp();
}

function aplicarDados(d) {
  const anterior = estado.sessao;
  estado.sessao = {
    conta: d.conta,
    jurado: d.jurado,
    evento: d.evento,
    eventos: d.eventos,
    coreografias: d.coreografias,
    gravacoes: d.gravacoes,
    diferenca_relogio: d.diferenca_relogio,
    dono: `${d.evento.id}:${d.conta.email}`,
  };
  if (anterior?.dono && anterior.dono !== estado.sessao.dono) estado.indice = 0;
  estado.sessaoInvalida = false;
  api.salvarCache(estado.sessao);
  const u = new URL(location.href);
  if (u.searchParams.get('evento') !== d.evento.id) {
    u.searchParams.set('evento', d.evento.id);
    history.replaceState(null, '', u.pathname + u.search);
  }
}

/** Sessão expirou ou foi encerrada. Nunca interrompe uma gravação. */
function tratarSemSessao() {
  estado.sessaoInvalida = true;
  if (estado.gravador.estado !== 'inactive') {
    mostrarAlerta('Sua sessão expirou. Termine este comentário: ele fica salvo e será enviado depois que você entrar de novo.');
    return;
  }
  mostrarLogin('Sua sessão expirou. Entre novamente: as gravações pendentes estão guardadas neste aparelho.');
}

function mostrarLogin(mensagem = '') {
  mostrarTelas('tela-acesso');
  $('msg-entrar').className = 'mensagem';
  $('msg-entrar').textContent = mensagem;
  const cache = api.lerCache();
  if (cache?.conta?.email && !$('campo-email').value) $('campo-email').value = cache.conta.email;
  ($('campo-email').value ? $('campo-senha') : $('campo-email')).focus();
}

async function enviarLogin(e) {
  e.preventDefault();
  $('btn-entrar').disabled = true;
  $('msg-entrar').className = 'mensagem';
  $('msg-entrar').textContent = '';
  try {
    const r = await api.entrar($('campo-email').value.trim(), $('campo-senha').value);
    $('campo-senha').value = '';
    estado.sessaoInvalida = false;
    if (r.trocar_senha) {
      $('senha-usuario').value = r.email;
      mostrarTrocaSenha();
    } else {
      mostrarTelas('tela-carregando');
      await carregar();
    }
  } catch (err) {
    $('msg-entrar').textContent = err.codigo === 'sem_rede' ? 'Sem conexão. Verifique a internet e tente de novo.' : err.message;
  } finally {
    $('btn-entrar').disabled = false;
  }
}

async function esqueciSenha() {
  const email = $('campo-email').value.trim();
  $('msg-entrar').className = 'mensagem';
  if (!$('campo-email').checkValidity() || !email) {
    $('msg-entrar').textContent = 'Digite seu e-mail acima e toque de novo em "Esqueci minha senha".';
    $('campo-email').focus();
    return;
  }
  $('btn-esqueci').disabled = true;
  try {
    await api.esqueciSenha(email);
    $('msg-entrar').className = 'mensagem ok';
    $('msg-entrar').textContent = `Se ${email} tiver conta de jurado, enviamos um link para criar uma nova senha (vale 30 min). Confira também o spam.`;
  } catch (err) {
    $('msg-entrar').textContent = err.codigo === 'sem_rede' ? 'Sem conexão. Tente de novo.' : err.message;
  } finally {
    setTimeout(() => { $('btn-esqueci').disabled = false; }, 5000);
  }
}

function mostrarTrocaSenha() {
  mostrarTelas('tela-senha');
  $('msg-senha').textContent = '';
  $('campo-nova').value = '';
  $('campo-confirma').value = '';
  $('campo-nova').focus();
}

async function salvarNovaSenha(e) {
  e.preventDefault();
  const nova = $('campo-nova').value;
  if (nova !== $('campo-confirma').value) {
    $('msg-senha').textContent = 'As senhas não conferem.';
    return;
  }
  $('btn-salvar-senha').disabled = true;
  try {
    await api.trocarSenha(nova);
    mostrarTelas('tela-carregando');
    await carregar();
  } catch (err) {
    if (err.status === 401) return mostrarLogin('Sua sessão expirou. Entre com a senha provisória de novo.');
    $('msg-senha').textContent = err.message;
  } finally {
    $('btn-salvar-senha').disabled = false;
  }
}

function mostrarEventos(d) {
  mostrarTelas('tela-eventos');
  $('lista-eventos').replaceChildren(
    ...d.eventos.map((e) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      const nome = document.createElement('strong');
      nome.textContent = e.nome;
      const info = document.createElement('small');
      info.textContent = [e.data.split('-').reverse().join('/'), e.local].filter(Boolean).join(' · ');
      b.append(nome, info);
      b.addEventListener('click', () => {
        mostrarTelas('tela-carregando');
        carregar(e.id);
      });
      return b;
    }),
  );
}

/** Mostra problemas do navegador (sem HTTPS, navegador interno de app...). */
function mostrarAvisosDoNavegador() {
  const problemas = verificarAmbiente(plataforma);
  const caixa = $('aviso-navegador');
  caixa.hidden = !problemas.length;
  caixa.replaceChildren(
    ...problemas.flatMap((p) => {
      const t = document.createElement('strong');
      t.textContent = p.titulo;
      const lista = document.createElement('ul');
      lista.append(...p.passos.map((x) => Object.assign(document.createElement('li'), { textContent: x })));
      return [t, lista];
    }),
  );
  return problemas;
}

/** Testa o microfone uma vez por sessão do navegador, depois vai para a tela principal. */
async function entrarNoApp() {
  if (sessionStorage.getItem(CHAVE_MIC_OK) === '1' || (await estadoPermissao()) === 'granted') {
    sessionStorage.setItem(CHAVE_MIC_OK, '1');
    await mostrarPrincipal();
  } else {
    await mostrarTesteMicrofone();
  }
}

/* -------------------------- Teste do microfone -------------------------- */

let medidorMic = null;

function ajudaMicrofone(explicacao) {
  $('mic-ajuda').hidden = !explicacao;
  if (!explicacao) return;
  $('mic-ajuda-titulo').textContent = explicacao.titulo;
  $('mic-ajuda-passos').replaceChildren(...explicacao.passos.map((x) => Object.assign(document.createElement('li'), { textContent: x })));
}

function statusMicrofone(texto, tipo = '') {
  $('mic-status').textContent = texto;
  $('mic-status').className = `mic-status ${tipo}`;
}

function rotuloBotaoMic(texto) {
  $('btn-testar-mic').innerHTML = `<i class="mdi mdi-microphone"></i> ${texto}`;
}

async function mostrarTesteMicrofone(erroAnterior) {
  mostrarTelas('tela-microfone');
  pararMedidorMic();
  $('btn-mic-continuar').disabled = !estado.gravador.microfoneAtivo;
  $('btn-testar-mic').disabled = false;
  $('btn-testar-mic').hidden = false;
  rotuloBotaoMic('Permitir e testar microfone');
  $('mic-nivel').style.width = '0';
  statusMicrofone('');
  ajudaMicrofone(null);

  if (erroAnterior) return falhaMicrofone(erroAnterior);

  const permissao = await estadoPermissao((novo) => {
    if (novo === 'granted' && !$('tela-microfone').hidden) testarMicrofone();
  });
  if (permissao === 'denied') {
    statusMicrofone('O microfone está bloqueado para este site.', 'erro');
    ajudaMicrofone({ titulo: 'Como liberar', passos: explicarErroMicrofone({ name: 'NotAllowedError' }, plataforma).passos });
    rotuloBotaoMic('Tentar de novo');
  } else if (permissao === 'granted' || estado.gravador.microfoneAtivo) {
    testarMicrofone();
  }
}

async function testarMicrofone() {
  $('btn-testar-mic').disabled = true;
  statusMicrofone('Aguardando a permissão… escolha "Permitir".');
  ajudaMicrofone(null);
  try {
    await estado.gravador.preparar();
  } catch (e) {
    return falhaMicrofone(e);
  }
  statusMicrofone('Microfone liberado. Fale algo para testar o volume…', 'ok');
  $('btn-testar-mic').hidden = true;

  let captou = false;
  const inicio = Date.now();
  pararMedidorMic();
  medidorMic = setInterval(() => {
    const n = estado.gravador.nivel();
    $('mic-nivel').style.width = `${Math.round(n * 100)}%`;
    if (!captou && n > 0.08) {
      captou = true;
      statusMicrofone('✓ Som captado. Tudo pronto!', 'ok');
      $('btn-mic-continuar').disabled = false;
    } else if (!captou && Date.now() - inicio > 4000 && $('btn-mic-continuar').disabled) {
      statusMicrofone('Microfone liberado. Se a barra não se mexer quando você fala, confira o microfone ou o fone conectado.', 'ok');
      $('btn-mic-continuar').disabled = false;
    }
  }, 100);
}

function falhaMicrofone(erro) {
  pararMedidorMic();
  statusMicrofone('Não foi possível usar o microfone.', 'erro');
  ajudaMicrofone(explicarErroMicrofone(erro, plataforma));
  $('btn-testar-mic').hidden = false;
  $('btn-testar-mic').disabled = false;
  rotuloBotaoMic('Tentar de novo');
  $('btn-mic-continuar').disabled = true;
}

function pararMedidorMic() {
  clearInterval(medidorMic);
  medidorMic = null;
}

async function concluirTesteMicrofone() {
  pararMedidorMic();
  sessionStorage.setItem(CHAVE_MIC_OK, '1');
  await mostrarPrincipal();
}

/* ---------------------------- Tela principal ---------------------------- */

function renderizarIdentificacao() {
  const s = estado.sessao;
  $('nome-jurado').textContent = s.jurado.nome;
  $('nome-evento').textContent = [s.evento.nome, s.evento.local].filter(Boolean).join(' · ');
  $('typeBadgeLabel').textContent = s.jurado?.ordem ? `Jurado ${s.jurado.ordem}` : 'Jurado';
  $('userChip').hidden = !s.conta?.email;
  $('userEmail').textContent = s.conta?.email || '';
}

async function mostrarPrincipal() {
  mostrarTelas('tela-principal');
  renderizarIdentificacao();
  await recuperarGravacoesInterrompidas();
  await recalcularGravadas();
  montarLista();
  if (!estado.gravacaoAtual) estado.indice = primeiraNaoGravada();
  renderizarCoreografia();
  manterTelaLigada();

  sinc.agendar(0);
  clearInterval(estado.timerSessao);
  estado.timerSessao = setInterval(atualizarDoServidor, 60_000);
}

/** Recarrega coreografias, horário e gravações do servidor (quando houver rede). */
async function atualizarDoServidor() {
  if (!estado.sessao || estado.sessaoInvalida || !navigator.onLine) return;
  try {
    const d = await api.carregarSessao(estado.sessao.evento.id);
    if (!d.evento) return;
    const atual = coreografiaAtual()?.id;
    aplicarDados(d);
    estado.offline = false;
    renderizarIdentificacao();
    await recalcularGravadas();
    montarLista();
    const novoIndice = estado.sessao.coreografias.findIndex((c) => c.id === atual);
    if (novoIndice >= 0) estado.indice = novoIndice;
    renderizarCoreografia();
  } catch (e) {
    if (e.status === 401) tratarSemSessao();
    else if (e.codigo === 'nao_jurado' && estado.gravador.estado === 'inactive') {
      mostrarLogin('A organização retirou seu acesso a este evento. As gravações pendentes continuam salvas neste aparelho.');
    }
  }
}

/** Se o app fechou no meio de uma gravação, finaliza com os trechos já salvos. */
async function recuperarGravacoesInterrompidas() {
  for (const g of await fila.listarGravacoes()) {
    if (g.dono === estado.sessao.dono && g.status === 'gravando' && g.id !== estado.gravacaoAtual?.id) {
      await fila.atualizarGravacao(g.id, { status: 'pendente', duracao_ms: (g.total_trechos || 0) * 10_000, interrompida: true });
    }
  }
}

async function recalcularGravadas() {
  estado.gravadasServidor = new Set((estado.sessao.gravacoes || []).map((g) => g.coreografia_id));
  const locais = (await fila.listarGravacoes()).filter((g) => g.dono === estado.sessao.dono);
  estado.gravadasLocal = new Set(locais.map((g) => g.coreografia_id));
}

const jaGravada = (id) => estado.gravadasServidor.has(id) || estado.gravadasLocal.has(id);
const coreografiaAtual = () => estado.sessao?.coreografias[estado.indice];

function primeiraNaoGravada() {
  const i = estado.sessao.coreografias.findIndex((c) => !jaGravada(c.id));
  return i >= 0 ? i : 0;
}

function montarLista() {
  $('lista-coreografias').replaceChildren(
    ...estado.sessao.coreografias.map((c, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${num(c.numero)} · ${c.nome}${jaGravada(c.id) ? ' ✓' : ''}`;
      return o;
    }),
  );
}

function renderizarCoreografia() {
  const c = coreografiaAtual();
  const vazio = !c;
  const gravando = estado.gravador.estado !== 'inactive';
  const aberto = agoraServidor() >= (estado.sessao.evento.abre_em || 0);
  $('numero').textContent = vazio ? '—' : num(c.numero);
  $('nome-coreografia').textContent = vazio ? 'Nenhuma coreografia cadastrada' : c.nome;
  $('grupo').textContent = c?.grupo || '';
  $('selo-gravada').hidden = vazio || !jaGravada(c.id);
  $('selo-gravada').textContent = '✓ comentário já gravado';
  $('lista-coreografias').value = String(estado.indice);
  $('btn-gravar').disabled = vazio || !aberto;
  if (!gravando) $('estado-texto').textContent = aberto ? 'Pronto para gravar' : `O evento abre em ${hora(estado.sessao.evento.abre_em)}`;
  $('btn-anterior').disabled = gravando || estado.indice <= 0;
  $('btn-proxima').disabled = gravando || estado.indice >= estado.sessao.coreografias.length - 1;
  $('lista-coreografias').disabled = gravando;
}

function irPara(indice) {
  if (estado.gravador.estado !== 'inactive') return;
  estado.indice = Math.min(Math.max(indice, 0), estado.sessao.coreografias.length - 1);
  renderizarCoreografia();
}

/* ------------------------------ Gravação ------------------------------ */

async function gravar() {
  const c = coreografiaAtual();
  if (!c || estado.gravador.estado !== 'inactive') return;
  if (jaGravada(c.id) && !confirm(`Já existe comentário para ${num(c.numero)} · ${c.nome}.\nGravar uma nova versão?`)) return;

  try {
    await estado.gravador.preparar();
  } catch (e) {
    await mostrarTesteMicrofone(e); // explica e mostra os passos para liberar
    return;
  }

  const g = {
    id: crypto.randomUUID(),
    dono: estado.sessao.dono,
    coreografia_id: c.id,
    numero: c.numero,
    nome: c.nome,
    iniciado_em: agoraServidor(),
    mime: '',
    status: 'gravando',
    registrada: false,
    total_trechos: 0,
  };

  estado.escritas = Promise.resolve();
  estado.gravador.iniciar((seq, blob) => {
    estado.escritas = estado.escritas
      .then(() => fila.adicionarTrecho(g.id, seq, blob))
      .then(() => sinc.agendar(0))
      .catch((err) => mostrarAlerta(`Falha ao salvar o áudio no aparelho: ${err.message}`));
  });
  g.mime = estado.gravador.mimeType || 'audio/webm';
  await fila.salvarGravacao(g);
  estado.gravacaoAtual = g;
  estado.avisoFinal = false;

  vibrar(60);
  aplicarEstadoVisual();
  iniciarTimerTela();
  sinc.agendar(0);
}

function alternarPausa() {
  const gr = estado.gravador;
  if (gr.estado === 'recording') gr.pausar();
  else if (gr.estado === 'paused') gr.retomar();
  vibrar(30);
  aplicarEstadoVisual();
}

async function encerrar() {
  const g = estado.gravacaoAtual;
  if (!g || estado.encerrando) return;
  estado.encerrando = true;
  pararTimerTela();
  let duracao;
  try {
    duracao = await estado.gravador.parar();
  } finally {
    estado.encerrando = false;
  }
  await estado.escritas; // garante que o último trecho foi salvo
  await fila.atualizarGravacao(g.id, { status: 'pendente', duracao_ms: Math.round(duracao) });
  estado.gravadasLocal.add(g.coreografia_id);
  estado.gravacaoAtual = null;
  vibrar([40, 60, 40]);
  aplicarEstadoVisual();

  montarLista();
  if (estado.indice < estado.sessao.coreografias.length - 1) estado.indice++; // próxima coreografia
  renderizarCoreografia();
  sinc.agendar(0);

  if (estado.sessaoInvalida) tratarSemSessao(); // sessão expirou durante a gravação: login agora
}

function aplicarEstadoVisual() {
  const st = estado.gravador.estado;
  document.body.classList.toggle('gravando', st === 'recording');
  document.body.classList.toggle('pausado', st === 'paused');
  $('btn-gravar').hidden = st !== 'inactive';
  $('btn-pausar').hidden = st === 'inactive';
  $('btn-encerrar').hidden = st === 'inactive';
  $('btn-pausar').innerHTML = st === 'paused' ? '<i class="mdi mdi-play"></i> <span>Retomar</span>' : '<i class="mdi mdi-pause"></i> <span>Pausar</span>';
  $('estado-texto').textContent = st === 'recording' ? 'Gravando…' : st === 'paused' ? 'Pausado' : 'Pronto para gravar';
  if (st === 'inactive') {
    $('cronometro').textContent = '00:00';
    $('nivel-barra').style.width = '0';
    if (!estado.offline) esconderAlerta();
  }
  renderizarCoreografia();
}

function iniciarTimerTela() {
  pararTimerTela();
  const maxMs = (estado.sessao.evento.duracao_max_s || 480) * 1000;
  estado.timerTela = setInterval(() => {
    const ms = estado.gravador.duracaoMs();
    const s = Math.floor(ms / 1000);
    $('cronometro').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    $('nivel-barra').style.width = estado.gravador.estado === 'recording' ? `${Math.round(estado.gravador.nivel() * 100)}%` : '0';
    // Limite de segurança contra "microfone aberto"
    if (!estado.avisoFinal && ms > maxMs - 60_000) {
      estado.avisoFinal = true;
      mostrarAlerta('Falta 1 minuto para o limite. A gravação será encerrada automaticamente.');
      vibrar([200, 100, 200]);
    }
    if (ms >= maxMs) encerrar();
  }, 200);
}

function pararTimerTela() {
  clearInterval(estado.timerTela);
  estado.timerTela = null;
}

/* Encerrar exige segurar o botão (evita toque acidental) */
function ligarSegurarParaEncerrar() {
  const btn = $('btn-encerrar');
  btn.style.setProperty('--tempo-segurar', `${TEMPO_SEGURAR_MS}ms`);
  let timer = null;
  const comecar = (e) => {
    if (e.type === 'keydown' && (e.repeat || (e.key !== 'Enter' && e.key !== ' '))) return;
    e.preventDefault();
    btn.classList.add('segurando');
    timer = setTimeout(() => {
      btn.classList.remove('segurando');
      encerrar();
    }, TEMPO_SEGURAR_MS);
  };
  const cancelar = () => {
    clearTimeout(timer);
    btn.classList.remove('segurando');
  };
  btn.addEventListener('pointerdown', comecar);
  btn.addEventListener('keydown', comecar);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'keyup', 'blur']) btn.addEventListener(ev, cancelar);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* ------------------------------ Status / fila ------------------------------ */

function renderizarStatus(r) {
  const el = $('status-envio');
  el.className = 'status-envio';
  if (r.comErro) {
    el.textContent = `⚠ ${r.comErro} com erro`;
    el.classList.add('erro');
  } else if (r.offline && r.pendentes) {
    el.textContent = `⚠ sem rede · ${r.pendentes}`;
    el.classList.add('offline');
  } else if (r.pendentes) {
    el.textContent = `↻ enviando ${r.pendentes}`;
    el.classList.add('enviando');
  } else {
    el.textContent = '✓ enviado';
    el.classList.add('ok');
  }

  const rotulos = { gravando: '● gravando', pendente: '↻ na fila', enviada: '✓ enviada' };
  $('lista-fila').replaceChildren(
    ...r.gravacoes.slice(-30).reverse().map((g) => {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.textContent = `${num(g.numero)} · ${g.nome}${g.versao > 1 ? ` (v${g.versao})` : ''}`;
      const b = document.createElement('span');
      b.textContent = g.erro ? `⚠ ${g.erro}` : rotulos[g.status] || g.status;
      li.append(a, b);
      return li;
    }),
  );
}

async function sairDaConta() {
  if (estado.gravador.estado !== 'inactive') {
    mostrarAlerta('Encerre a gravação antes de sair.');
    return;
  }
  const { pendentes } = await sinc.resumo();
  const aviso = pendentes
    ? `${pendentes} gravação(ões) ainda não foram enviadas. Elas ficam guardadas neste aparelho e serão enviadas quando você entrar de novo.\n\n`
    : '';
  if (!confirm(`${aviso}Sair da sua conta neste aparelho?`)) return;
  try { await api.sair(); } catch { /* sai mesmo sem rede */ }
  encerrarSessaoLocal();
  mostrarLogin();
}

function encerrarSessaoLocal() {
  const email = estado.sessao?.conta?.email;
  api.esquecerCache();
  if (email) $('campo-email').value = email;
  sessionStorage.removeItem(CHAVE_MIC_OK);
  clearInterval(estado.timerSessao);
  estado.gravador.liberar();
  estado.sessao = null;
  liberarTela();
}

/* ------------------------------ Utilidades ------------------------------ */

function mostrarAlerta(texto) {
  $('alerta').textContent = texto;
  $('alerta').hidden = false;
}
function esconderAlerta() {
  $('alerta').hidden = true;
}
function vibrar(padrao) {
  try { navigator.vibrate?.(padrao); } catch { /* opcional */ }
}
async function manterTelaLigada() {
  try {
    if ('wakeLock' in navigator && !estado.wakeLock && estado.sessao) {
      estado.wakeLock = await navigator.wakeLock.request('screen');
      estado.wakeLock.addEventListener('release', () => (estado.wakeLock = null));
    }
  } catch { /* sem suporte ou negado */ }
}
function liberarTela() {
  estado.wakeLock?.release().catch(() => {});
  estado.wakeLock = null;
}

function ligarEventos() {
  $('form-entrar').addEventListener('submit', enviarLogin);
  $('btn-esqueci').addEventListener('click', esqueciSenha);
  $('form-senha').addEventListener('submit', salvarNovaSenha);
  document.querySelectorAll('.olho').forEach((b) =>
    b.addEventListener('click', () => {
      const alvo = $(b.dataset.alvo);
      alvo.type = alvo.type === 'password' ? 'text' : 'password';
      b.setAttribute('aria-label', alvo.type === 'password' ? 'Mostrar senha' : 'Ocultar senha');
    }),
  );
  $('btn-gravar').addEventListener('click', gravar);
  $('btn-pausar').addEventListener('click', alternarPausa);
  $('btn-anterior').addEventListener('click', () => irPara(estado.indice - 1));
  $('btn-proxima').addEventListener('click', () => irPara(estado.indice + 1));
  $('lista-coreografias').addEventListener('change', (e) => irPara(Number(e.target.value)));
  $('btn-sair').addEventListener('click', sairDaConta);
  $('btn-testar-mic').addEventListener('click', testarMicrofone);
  $('btn-mic-continuar').addEventListener('click', concluirTesteMicrofone);
  $('btn-mic').addEventListener('click', () => {
    if (estado.gravador.estado !== 'inactive') return mostrarAlerta('Encerre a gravação antes de testar o microfone.');
    mostrarTesteMicrofone();
  });
  ligarSegurarParaEncerrar();
}

iniciar();
