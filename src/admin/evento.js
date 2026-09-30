// Tela exclusiva do evento — usada pela organização (nível geral) e pelos responsáveis do evento.
// Abas: Notas (quadro coreografias × jurados, com status dos áudios e média), Ranking (pódio + lista,
// por formação), Áudios, Coreografias, Grupos/escolas, Jurados (cadastro e escala) e Minha conta.
// Os responsáveis do evento são cadastrados na tela "Eventos e responsáveis" (/admin/eventos/).

import {
  $, num, api, aviso, tentar, el, icone, botao, selo, vazio, fmtDuracao, fmtHora, fmtData, paraCampo, comFuso, fmtNota,
  FORMACOES, rotuloFormacao, FAIXAS, rotuloFaixa, situacaoEvento, situacaoConta, copiar, mostrarSenha, ligarCaixaSenha, guardar, ler,
  trocarMinhaSenha, sair, baixarCsv,
} from './comum.js';
import { montarZip } from './zip.js';

const CHAVE_ABA = 'udx-festival.evento.aba';
const ABAS = ['notas', 'ranking', 'gravacoes', 'jurados', 'grupos', 'coreografias', 'conta'];
const estado = {
  eu: null,
  eventos: [],
  eventoId: null,
  detalhe: null,
  quadro: null,
  grupos: [],
  aba: 'notas',
  segmento: null,
  timer: null,
  gravacoes: [],
  tocando: null, // id da gravação no player da aba Áudios
  baixando: false,
};
const geral = () => estado.eu?.nivel === 'geral';
const casas = () => estado.quadro?.evento?.nota_casas ?? 1;
/** ms → dd/mm/aaaa (horário de Brasília) */
const diaDe = (ms) => new Date(ms).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fmtMedia = (m) => fmtNota(m, Math.min(casas() + 1, 3));

/* ================================ NAVEGAÇÃO ================================ */

function trocarAba(nome) {
  if (!ABAS.includes(nome)) nome = 'notas';
  estado.aba = nome;
  guardar(CHAVE_ABA, nome);
  for (const b of document.querySelectorAll('[data-aba]')) b.classList.toggle('is-active', b.dataset.aba === nome);
  for (const s of document.querySelectorAll('.aba')) s.hidden = s.id !== `aba-${nome}`;
  if (nome === 'coreografias' && estado.detalhe) renderizarCoreografias();
  const carregar = { gravacoes: carregarGravacoes }[nome];
  if (carregar && estado.eventoId) tentar(carregar);
}

async function abrirEvento(id) {
  estado.eventoId = id;
  const u = new URL(location.href);
  u.searchParams.set('id', id);
  history.replaceState(null, '', u.pathname + u.search);
  $('sel-evento').value = id;
  $('form-evento').hidden = true;
  clearInterval(estado.timer);
  await Promise.all([carregarDetalhe(), carregarQuadro(), carregarGrupos()]);
  if (estado.aba === 'gravacoes') await carregarGravacoes();
  // Notas e áudios chegam durante o evento: atualiza sozinho
  estado.timer = setInterval(() => {
    if (document.hidden) return;
    carregarQuadro().catch(() => {});
    if (estado.aba === 'gravacoes') carregarGravacoes().catch(() => {});
  }, 15_000);
}

/* ================================ CABEÇALHO ================================ */

async function carregarDetalhe() {
  estado.detalhe = await api('GET', `/api/admin/eventos/${estado.eventoId}`);
  const { evento, coreografias, jurados, responsaveis, link_jurados } = estado.detalhe;
  $('ev-responsaveis').textContent = responsaveis.length
    ? `Responsáveis: ${responsaveis.map((r) => r.nome).join(', ')}`
    : 'Sem responsável definido.';
  $('link-responsaveis').href = `/admin/eventos/#evento-${evento.id}`;
  document.title = `${evento.nome} · UpDance Festival`;
  $('ev-nome').textContent = evento.nome;
  $('ev-data').textContent = fmtData(evento.data);
  $('ev-local').textContent = evento.local || 'Local a definir';
  const sit = situacaoEvento(evento);
  $('ev-situacao').replaceChildren(selo(sit.classe, sit.texto));
  $('link-jurados-url').textContent = link_jurados;
  $('c-coreografias').textContent = coreografias.length;
  $('c-jurados').textContent = jurados.filter((j) => j.ativo).length;
  renderizarCoreografias();
  renderizarEscala();

}

function preencherFormEvento() {
  const ev = estado.detalhe.evento;
  const f = $('form-evento');
  f.nome.value = ev.nome;
  f.data.value = ev.data;
  f.local.value = ev.local || '';
  f.abre_em.value = paraCampo(ev.abre_em);
  f.fecha_em.value = paraCampo(ev.fecha_em);
  f.duracao_max_min.value = Math.round((ev.duracao_max_s || 480) / 60);
  f.nota_min.value = ev.nota_min ?? 0;
  f.nota_max.value = ev.nota_max ?? 10;
  f.nota_casas.value = String(ev.nota_casas ?? 1);
  f.anonimizar_jurados.checked = !!ev.anonimizar_jurados;
  f.hidden = false;
  f.nome.focus();
}

async function salvarEvento(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api('PATCH', `/api/admin/eventos/${estado.eventoId}`, {
    json: {
      nome: f.get('nome'),
      data: f.get('data'),
      local: f.get('local'),
      abre_em: comFuso(f.get('abre_em')),
      fecha_em: comFuso(f.get('fecha_em')),
      duracao_max_s: Number(f.get('duracao_max_min') || 8) * 60,
      anonimizar_jurados: f.get('anonimizar_jurados') === 'on',
      nota_min: f.get('nota_min'),
      nota_max: f.get('nota_max'),
      nota_casas: Number(f.get('nota_casas')),
    },
  });
  $('form-evento').hidden = true;
  aviso(`Evento "${r.nome}" atualizado.`);
  await Promise.all([carregarDetalhe(), carregarQuadro(), carregarListaEventos()]);
}

function renderizarIndicadores() {
  const { resumo, coreografias } = estado.quadro;
  let audios = 0;
  for (const c of coreografias) for (const a of Object.values(c.audios)) if (a.status !== 'gravando') audios++;
  const pct = resumo.notas_esperadas ? Math.round((resumo.notas_lancadas / resumo.notas_esperadas) * 100) : 0;
  $('ind-coreografias').textContent = resumo.coreografias;
  $('ind-jurados').textContent = resumo.jurados_ativos;
  $('ind-notas').textContent = `${resumo.notas_lancadas}/${resumo.notas_esperadas}`;
  $('ind-notas-barra').style.width = `${pct}%`;
  $('ind-audios').textContent = audios;
}

/* ================================ NOTAS ================================ */

async function carregarQuadro() {
  estado.quadro = await api('GET', `/api/admin/eventos/${estado.eventoId}/notas`);
  renderizarIndicadores();
  montarFiltroFormacao();
  renderizarNotas();
  renderizarRanking();
  if (estado.detalhe) renderizarCoreografias();
}

function montarFiltroFormacao() {
  const sel = $('filtro-formacao-notas');
  const atual = sel.options.length ? sel.value : '*'; // 1ª montagem: "todas"
  const tem = new Set(estado.quadro.coreografias.map((c) => c.formacao || ''));
  sel.replaceChildren(
    el('option', { value: '*', textContent: 'Todas as formações' }),
    ...FORMACOES.filter((f) => tem.has(f.id)).map((f) => el('option', { value: f.id, textContent: f.rotulo })),
    tem.has('') ? el('option', { value: '', textContent: 'Sem formação' }) : null,
  );
  sel.value = [...sel.options].some((o) => o.value === atual) ? atual : '*';
  montarFiltroFaixa($('filtro-faixa-notas'), estado.quadro.coreografias);
}

/** Select de faixa só com as faixas que existem na lista (some quando nenhuma coreografia tem faixa). */
function montarFiltroFaixa(sel, lista) {
  const atual = sel.options.length ? sel.value : '*'; // 1ª montagem: "todas"
  const tem = new Set(lista.map((c) => c.faixa || ''));
  sel.replaceChildren(
    el('option', { value: '*', textContent: 'Todas as faixas' }),
    ...FAIXAS.filter((f) => tem.has(f.id)).map((f) => el('option', { value: f.id, textContent: f.rotulo })),
    tem.has('') ? el('option', { value: '', textContent: 'Sem faixa' }) : null,
  );
  sel.value = [...sel.options].some((o) => o.value === atual) ? atual : '*';
  sel.hidden = !FAIXAS.some((f) => tem.has(f.id));
}

const STATUS_AUDIO = {
  nenhum: { glifo: '–', texto: 'sem áudio' },
  gravando: { glifo: '…', texto: 'áudio chegando (parcial)' },
  completo: { glifo: '✓', texto: 'áudio completo' },
  aprovado: { glifo: '★', texto: 'áudio aprovado' },
};

function flagAudio(a, jurado, c) {
  const st = a?.status || 'nenhum';
  const info = STATUS_AUDIO[st];
  const titulo = `${jurado.nome}: ${info.texto}${a?.duracao_ms ? ` (${fmtDuracao(a.duracao_ms)})` : ''}`;
  if (!a) return el('span', { class: 'flag f-nenhum', title: titulo, textContent: info.glifo });
  return el('button', {
    class: `flag f-${st}`, type: 'button', title: `${titulo} — tocar`, ariaLabel: `Ouvir: ${titulo}`, textContent: info.glifo,
    onclick: () => ouvir(a.gravacao_id, `${num(c.numero)} · ${c.nome} — ${jurado.nome}${st === 'gravando' ? ' (parcial)' : ''}`),
  });
}

/**
 * Áudio gravado pelo MediaRecorder às vezes chega sem duração no cabeçalho (WebM): o player mostra
 * "Infinity" e não deixa avançar. Truque padrão: pular para o fim força o navegador a calcular a duração.
 */
function corrigirDuracao(player) {
  if (player.dataset.corrigido) return;
  player.dataset.corrigido = '1';
  player.addEventListener('loadedmetadata', () => {
    if (player.duration !== Infinity) return;
    const voltar = () => {
      player.removeEventListener('timeupdate', voltar);
      player.currentTime = 0;
    };
    player.addEventListener('timeupdate', voltar);
    player.currentTime = 1e101;
  });
}

/**
 * Player único da tela (barra fixa): usado pelos sinais da aba Notas, pela aba Áudios e pela lista
 * de coreografias. Clicar de novo no mesmo áudio alterna tocar/pausar.
 */
function ouvir(gravacaoId, titulo) {
  const player = $('player');
  if (estado.tocando === gravacaoId && player.src) {
    if (player.paused) player.play().catch(() => {});
    else player.pause();
    return;
  }
  corrigirDuracao(player);
  estado.tocando = gravacaoId;
  $('player-titulo').textContent = titulo;
  $('barra-player').hidden = false;
  player.src = `/api/admin/gravacoes/${gravacaoId}/audio`;
  player.play().catch(() => aviso('Não foi possível tocar este áudio neste navegador. Use "Baixar" e abra no seu player.', true));
}

const estaTocando = (gravacaoId) => estado.tocando === gravacaoId && !$('player').paused;

function fecharPlayer() {
  const player = $('player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  estado.tocando = null;
  $('barra-player').hidden = true;
  rerenderizarListasDeAudio();
}

/** Mantém os botões Ouvir/Pausar das listas iguais ao estado do player. */
function rerenderizarListasDeAudio() {
  if (estado.aba === 'gravacoes') renderizarGravacoes();
  if (estado.aba === 'coreografias' && estado.detalhe) renderizarCoreografias();
}

function filtrarNotas(lista) {
  const f = $('filtro-formacao-notas').value;
  const fx = $('filtro-faixa-notas').value;
  const q = $('busca-notas').value.trim().toLowerCase();
  return lista.filter((c) => {
    if (f !== '*' && (c.formacao || '') !== f) return false;
    if (fx !== '*' && (c.faixa || '') !== fx) return false;
    if (!q) return true;
    return `${num(c.numero)} ${c.nome} ${c.grupo || ''} ${c.categoria || ''} ${rotuloFaixa(c.faixa)}`.toLowerCase().includes(q);
  });
}

/** Cadeado: o jurado finalizou a avaliação desta coreografia. Clicar reabre (com confirmação). */
function cadeadoFinalizada(c, j) {
  const quando = fmtHora(c.finalizadas[j.id]);
  return el('button', {
    class: 'flag f-finalizada', type: 'button', textContent: '🔒',
    title: `${j.nome} finalizou em ${quando} — clique para reabrir`, ariaLabel: `Reabrir avaliação de ${j.nome}`,
    onclick: () => tentar(async () => {
      if (!confirm(`${j.nome} finalizou a avaliação de ${num(c.numero)} · ${c.nome} em ${quando}.\n\nReabrir? O jurado poderá alterar a nota e gravar de novo, e precisará finalizar outra vez.`)) return;
      await api('DELETE', `/api/admin/eventos/${estado.eventoId}/finalizacoes/${c.id}/${j.id}`);
      aviso(`Avaliação de ${j.nome} na ${num(c.numero)} reaberta.`);
      await carregarQuadro();
    }),
  });
}

function renderizarNotas() {
  const { jurados, coreografias, resumo } = estado.quadro;
  const pct = resumo.notas_esperadas ? Math.round((resumo.notas_lancadas / resumo.notas_esperadas) * 100) : 0;
  $('resumo-notas').textContent = `${resumo.notas_lancadas} de ${resumo.notas_esperadas} notas (${pct}%) · ${resumo.finalizadas ?? 0} finalizada(s) · atualizado ${fmtHora(estado.quadro.gerado_em)}`;
  $('th-notas').replaceChildren(
    el('tr', {},
      el('th', { class: 'col-fixa', textContent: 'Nº' }),
      el('th', { class: 'col-fixa2', textContent: 'Coreografia' }),
      ...jurados.map((j) =>
        el('th', { class: `col-jurado${j.ativo ? '' : ' suspenso'}`, title: j.ativo ? j.nome : `${j.nome} (suspenso: fora da média)` },
          el('span', { class: 'jurado-ordem', textContent: `J${j.ordem}` }), el('span', { class: 'jurado-nome', textContent: j.nome }),
        ),
      ),
      el('th', { class: 'col-media', textContent: 'Média' }),
    ),
  );
  const lista = filtrarNotas(coreografias);
  if (!coreografias.length || !jurados.length) {
    $('tb-notas').replaceChildren(vazio(jurados.length + 3, !coreografias.length ? 'Cadastre as coreografias na aba Coreografias.' : 'Adicione jurados na aba Jurados.'));
    return;
  }
  const ativos = jurados.filter((j) => j.ativo).length;
  $('tb-notas').replaceChildren(
    ...(lista.length
      ? lista.map((c) =>
          el('tr', {},
            el('td', { class: 'col-fixa' }, el('span', { class: 'num', textContent: num(c.numero) })),
            el('td', { class: 'col-fixa2' },
              el('div', { class: 'coreo-nome', textContent: c.nome }),
              el('div', { class: 'muted', textContent: [c.grupo, rotuloFormacao(c.formacao), rotuloFaixa(c.faixa), c.categoria].filter(Boolean).join(' · ') }),
            ),
            ...jurados.map((j) =>
              el('td', { class: `celula-nota${j.ativo ? '' : ' suspenso'}` },
                el('span', { class: `nota-valor${c.notas[j.id] == null ? ' sem' : ''}`, textContent: fmtNota(c.notas[j.id], casas()) }),
                flagAudio(c.audios[j.id], j, c),
                c.finalizadas?.[j.id] ? cadeadoFinalizada(c, j) : null,
              ),
            ),
            el('td', { class: 'col-media' },
              el('span', { class: `media-valor${c.media == null ? ' sem' : ''}`, textContent: fmtMedia(c.media) }),
              el('div', {},
                c.qtd_notas && c.qtd_notas >= ativos
                  ? selo('completo', `${c.qtd_notas}/${ativos}`)
                  : selo(c.qtd_notas ? 'gravando' : 'provisoria', c.qtd_notas ? `${c.qtd_notas}/${ativos} parcial` : 'sem notas'),
              ),
            ),
          ),
        )
      : [vazio(jurados.length + 3, 'Nenhuma coreografia com esse filtro.')]),
  );
}

/* ================================ RANKING ================================ */

/** Classificação com empates dividindo a posição (1, 1, 3…). */
function classificar(lista) {
  const comNota = lista.filter((c) => c.media != null).sort((a, b) => b.media - a.media || a.numero - b.numero);
  let pos = 0;
  let anterior = null;
  const ranqueadas = comNota.map((c, i) => {
    if (anterior === null || Math.abs(c.media - anterior) > 1e-9) pos = i + 1;
    anterior = c.media;
    return { ...c, posicao: pos, empate: false };
  });
  for (const c of ranqueadas) c.empate = ranqueadas.filter((x) => x.posicao === c.posicao).length > 1;
  const semNota = lista.filter((c) => c.media == null).sort((a, b) => a.numero - b.numero).map((c) => ({ ...c, posicao: null }));
  return [...ranqueadas, ...semNota];
}

function segmentosDisponiveis() {
  const coreos = estado.quadro.coreografias;
  const segs = FORMACOES.map((f) => ({ ...f, total: coreos.filter((c) => c.formacao === f.id).length }));
  const sem = coreos.filter((c) => !c.formacao).length;
  if (sem) segs.push({ id: '', rotulo: 'Sem formação', total: sem });
  return segs;
}

const TODAS = '*';

/** Escolhe a formação do ranking (abas e select sincronizados; faixa e categoria voltam para "todas"). TODAS = ranking geral. */
function escolherFormacao(id) {
  estado.segmento = id;
  $('filtro-categoria').value = '*';
  $('filtro-faixa').value = '*';
  renderizarRanking();
}

/** Filtros ativos (formação, faixa, categoria) — título do pódio e nome do CSV. Vazio = ranking geral. */
function tituloRanking() {
  const fx = $('filtro-faixa').value;
  const cat = $('filtro-categoria').value;
  const form = estado.segmento === TODAS ? null : segmentosDisponiveis().find((s) => s.id === estado.segmento)?.rotulo;
  return [form, fx !== '*' ? rotuloFaixa(fx) || 'Sem faixa' : null, cat !== '*' ? cat : null].filter(Boolean);
}

function cartaoPodio(c, i, ativos) {
  return el('article', { class: `podio-item podio-${i + 1}` },
    el('div', { class: 'podio-posicao' }, el('span', { textContent: `${c.posicao}º` }), c.empate ? el('small', { textContent: 'empate' }) : null),
    el('div', { class: 'podio-media', textContent: fmtMedia(c.media) }),
    el('div', { class: 'podio-nome' }, el('span', { class: 'num', textContent: num(c.numero) }), ` ${c.nome}`),
    el('div', { class: 'muted', textContent: [estado.segmento === TODAS ? rotuloFormacao(c.formacao) : null, c.grupo, rotuloFaixa(c.faixa), c.categoria].filter(Boolean).join(' · ') || rotuloFormacao(c.formacao) }),
    c.qtd_notas < ativos ? selo('gravando', `parcial · ${c.qtd_notas}/${ativos} notas`) : selo('completo', `${c.qtd_notas}/${ativos} notas`),
  );
}

function renderizarRanking() {
  const segs = segmentosDisponiveis();
  const todas = estado.quadro.coreografias;
  // Sem filtro escolhido = ranking geral (todas as coreografias juntas, sem segmentar)
  if (estado.segmento === null || (estado.segmento !== TODAS && !segs.some((s) => s.id === estado.segmento && s.total))) {
    estado.segmento = TODAS;
  }
  const opcoes = [{ id: TODAS, rotulo: 'Geral', total: todas.length }, ...segs];

  // Filtro de formação: abas (atalho) + select na linha de filtros
  $('segmentos').replaceChildren(
    ...opcoes.map((s) =>
      el('button', {
        class: `tab${s.id === estado.segmento ? ' is-active' : ''}`, type: 'button', role: 'tab', disabled: !s.total,
        onclick: () => escolherFormacao(s.id),
      }, s.rotulo, el('span', { class: 'contador', textContent: ` ${s.total}` })),
    ),
  );
  $('filtro-formacao-ranking').replaceChildren(
    ...opcoes.map((s) => el('option', {
      value: s.id, disabled: !s.total,
      textContent: s.id === TODAS ? `Todas (${s.total})` : `${s.rotulo} (${s.total})`,
    })),
  );
  $('filtro-formacao-ranking').value = estado.segmento;

  const daFormacao = estado.segmento === TODAS ? todas : todas.filter((c) => (c.formacao || '') === estado.segmento);
  montarFiltroFaixa($('filtro-faixa'), daFormacao);
  const fx = $('filtro-faixa').value;
  const doSegmento = daFormacao.filter((c) => fx === '*' || (c.faixa || '') === fx);
  const cats = [...new Set(doSegmento.map((c) => c.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const sel = $('filtro-categoria');
  const atual = sel.options.length ? sel.value : '*'; // 1ª montagem: "todas"
  sel.replaceChildren(el('option', { value: '*', textContent: 'Todas as categorias' }), ...cats.map((c) => el('option', { value: c, textContent: c })));
  sel.value = cats.includes(atual) ? atual : '*';
  sel.hidden = !cats.length;
  const filtradas = doSegmento.filter((c) => sel.value === '*' || c.categoria === sel.value);

  // Classificação sobre o conjunto filtrado: sem filtros = ranking geral; com filtros = só as coreografias selecionadas
  const lista = classificar(filtradas);
  estado.rankingAtual = lista;
  const ativos = estado.quadro.resumo.jurados_ativos;
  const comNota = lista.filter((c) => c.posicao);
  const filtros = tituloRanking();
  $('resumo-ranking').textContent = `${comNota.length} de ${lista.length} coreografias com nota`;
  $('btn-limpar-filtros-ranking').hidden = !filtros.length;

  // Pódio: as 3 maiores médias do conjunto filtrado
  const top = comNota.slice(0, 3);
  $('podio').replaceChildren(
    el('section', { class: 'podio-bloco' },
      el('h3', { class: 'podio-titulo' }, icone('podium-gold'), ' Pódio · ', filtros.length ? filtros.join(' · ') : 'Ranking geral'),
      el('div', { class: 'podio' },
        ...(top.length
          ? top.map((c, i) => cartaoPodio(c, i, ativos))
          : [el('p', { class: 'muted podio-vazio', textContent: lista.length ? 'O pódio aparece assim que as primeiras notas forem lançadas.' : 'Nenhuma coreografia com estes filtros.' })]),
      ),
    ),
  );

  $('tb-ranking').replaceChildren(
    ...(lista.length
      ? lista.map((c) =>
          el('tr', { class: c.posicao && c.posicao <= 3 ? `destaque-top top-${c.posicao}` : '' },
            el('td', {}, c.posicao ? el('span', { class: 'posicao', textContent: `${c.posicao}º` }) : el('span', { class: 'muted', textContent: '—' })),
            el('td', {}, el('span', { class: 'num', textContent: num(c.numero) })),
            el('td', { textContent: c.nome }),
            el('td', { textContent: c.grupo || '—' }),
            el('td', { textContent: rotuloFormacao(c.formacao) }),
            el('td', { textContent: rotuloFaixa(c.faixa) || '—' }),
            el('td', { textContent: c.categoria || '—' }),
            el('td', {}, el('strong', { class: 'media-valor', textContent: fmtMedia(c.media) })),
            el('td', {}, c.posicao
              ? (c.qtd_notas < ativos ? selo('gravando', `${c.qtd_notas}/${ativos} parcial`) : selo('completo', `${c.qtd_notas}/${ativos}`))
              : selo('provisoria', 'sem notas')),
          ),
        )
      : [vazio(9, 'Nenhuma coreografia com estes filtros.')]),
  );
}

function exportarRanking() {
  const lista = estado.rankingAtual || [];
  const ev = estado.quadro.evento;
  const jurados = estado.quadro.jurados.filter((j) => j.ativo);
  const filtros = tituloRanking();
  const nome = ['ranking', ev.data, ...(filtros.length ? filtros : ['geral'])].join('_');
  baixarCsv(`${nome}.csv`.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9._-]+/g, '-'), [
    ['posicao', 'formacao', 'numero', 'coreografia', 'grupo', 'faixa', 'categoria', 'media', 'notas_lancadas', ...jurados.map((j) => `J${j.ordem} ${j.nome}`)],
    ...lista.map((c) => [
      c.posicao ?? '', rotuloFormacao(c.formacao), c.numero, c.nome, c.grupo || '', rotuloFaixa(c.faixa), c.categoria || '',
      c.media == null ? '' : fmtMedia(c.media), c.qtd_notas, ...jurados.map((j) => (c.notas[j.id] == null ? '' : fmtNota(c.notas[j.id], casas()))),
    ]),
  ]);
}

/* ================================ ÁUDIOS ================================ */

const ZIP_LIMITE_BYTES = 400 * 1024 * 1024; // o ZIP é montado na memória do navegador
const statusDe = (g) => (g.status !== 'completo' ? 'gravando' : g.aprovada ? 'aprovado' : 'completo');

async function carregarGravacoes() {
  estado.gravacoes = await api('GET', `/api/admin/eventos/${estado.eventoId}/gravacoes`);
  const lista = estado.gravacoes;
  $('c-gravacoes').textContent = lista.length;
  $('resumo-gravacoes').textContent =
    `${lista.length} áudios · ${lista.filter((g) => g.status === 'completo').length} completos · ${lista.filter((g) => g.aprovada).length} aprovados`;
  // filtro de jurado: só quem já gravou
  const sel = $('filtro-jurado-audios');
  const atual = sel.value;
  const jurados = [...new Map(lista.map((g) => [g.jurado, g.jurado_ordem])).entries()].sort((a, b) => (a[1] ?? 99) - (b[1] ?? 99));
  sel.replaceChildren(el('option', { value: '*', textContent: 'Todos os jurados' }), ...jurados.map(([nome, ordem]) => el('option', { value: nome, textContent: ordem ? `J${ordem} · ${nome}` : nome })));
  sel.value = jurados.some(([n]) => n === atual) ? atual : '*';
  renderizarGravacoes();
}

function gravacoesFiltradas() {
  const q = $('busca-audios').value.trim().toLowerCase();
  const jur = $('filtro-jurado-audios').value;
  const st = $('filtro-status-audios').value;
  return estado.gravacoes.filter((g) => {
    if (jur !== '*' && g.jurado !== jur) return false;
    if (st !== '*' && statusDe(g) !== st) return false;
    return !q || `${num(g.numero)} ${g.coreografia} ${g.grupo || ''} ${rotuloFaixa(g.faixa)}`.toLowerCase().includes(q);
  });
}

function renderizarGravacoes() {
  const lista = gravacoesFiltradas();
  const completos = lista.filter((g) => g.status === 'completo');
  const bytes = completos.reduce((s, g) => s + (g.tamanho || 0), 0);
  if (!estado.baixando) {
    $('btn-zip-texto').textContent = completos.length ? `Baixar ZIP (${completos.length} · ${fmtBytes(bytes)})` : 'Baixar ZIP';
    $('btn-zip').disabled = !completos.length;
  }
  $('tb-gravacoes').replaceChildren(
    ...(lista.length
      ? lista.map((g) => {
          const st = statusDe(g);
          const status = st === 'gravando'
            ? selo('gravando', `Chegando · ${g.trechos} trechos`)
            : selo(st === 'aprovado' ? 'aprovada' : 'completo', st === 'aprovado' ? 'Aprovado' : 'Completo');
          const urlAudio = `/api/admin/gravacoes/${g.id}/audio`;
          const tocandoEste = estaTocando(g.id);
          return el('tr', { class: estado.tocando === g.id ? 'tocando' : '', dataset: { id: g.id } },
            el('td', {}, el('span', { class: 'num', textContent: num(g.numero) })),
            el('td', {},
              el('div', { textContent: `${g.coreografia}${g.versao > 1 ? ` (v${g.versao})` : ''}` }),
              g.grupo || g.faixa ? el('div', { class: 'muted', textContent: [g.grupo, rotuloFaixa(g.faixa)].filter(Boolean).join(' · ') }) : null,
              el('div', { class: 'ident', textContent: g.identificador }),
            ),
            el('td', {}, g.jurado_ordem ? el('span', { class: 'muted', textContent: `J${g.jurado_ordem} ` }) : null, g.jurado),
            el('td', {}, el('strong', { textContent: fmtNota(g.nota, casas()) })),
            el('td', {}, status),
            el('td', { textContent: g.duracao_ms ? fmtDuracao(g.duracao_ms) : '—' }),
            el('td', { class: 'acoes' },
              botao(tocandoEste ? 'Pausar' : 'Ouvir', tocandoEste ? 'pause-circle-outline' : 'play-circle-outline', () => alternarAudio(g), tocandoEste ? 'btn btn-hot' : 'btn btn-sec'),
              el('a', { class: 'btn btn-sec', href: `${urlAudio}?download=1`, download: '', title: st === 'gravando' ? 'Baixa o que já chegou (parcial)' : 'Baixar o arquivo' },
                icone('download'), st === 'gravando' ? ' Baixar parcial' : ' Baixar'),
              g.status === 'completo'
                ? botao(g.aprovada ? 'Retirar aprovação' : 'Aprovar', g.aprovada ? 'close-circle-outline' : 'check-decagram', () => aprovar(g, !g.aprovada), g.aprovada ? 'btn btn-sec' : 'btn btn-hot')
                : null,
            ),
          );
        })
      : [vazio(7, estado.gravacoes.length ? 'Nenhum áudio com esse filtro.' : 'Nenhum áudio ainda.')]),
  );
}

function alternarAudio(g) {
  ouvir(g.id, `${num(g.numero)} · ${g.coreografia} — ${g.jurado}${g.status !== 'completo' ? ' (parcial)' : ''}`);
}

async function aprovar(g, aprovada) {
  await api('POST', `/api/admin/gravacoes/${g.id}/aprovar`, { json: { aprovada } });
  await Promise.all([carregarGravacoes(), carregarQuadro()]);
}

const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const pastaDe = (g) => `${num(g.numero)}_${g.coreografia}`.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);

/** Aba Áudios: ZIP dos áudios completos da lista filtrada. */
function baixarZip() {
  const filtro = [$('filtro-jurado-audios').value, $('filtro-status-audios').value].filter((v) => v !== '*').join('_');
  return montarEBaixarZip(gravacoesFiltradas().filter((g) => g.status === 'completo'), filtro, (t) => ($('btn-zip-texto').textContent = t));
}

/**
 * Baixa os áudios, um por um, e monta um ZIP no navegador (pastas por coreografia).
 * @param {{id, identificador, numero, coreografia, tamanho, finalizado_em, iniciado_em}[]} lista
 */
async function montarEBaixarZip(lista, sufixo, progresso) {
  if (estado.baixando) return;
  const total = lista.reduce((s, g) => s + (g.tamanho || 0), 0);
  if (!lista.length) return aviso('Nenhum áudio completo para baixar.', true);
  if (total > ZIP_LIMITE_BYTES) {
    return aviso(`São ${fmtBytes(total)} de áudio: acima de ${fmtBytes(ZIP_LIMITE_BYTES)}, o navegador pode travar. Filtre por jurado ou coreografia e baixe em partes.`, true);
  }
  estado.baixando = true;
  $('btn-zip').disabled = true;
  try {
    const arquivos = [];
    for (const [i, g] of lista.entries()) {
      progresso(`Baixando ${i + 1}/${lista.length}…`);
      const r = await fetch(`/api/admin/gravacoes/${g.id}/audio?download=1`, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error(`Falha ao baixar ${g.identificador} (erro ${r.status})`);
      arquivos.push({ nome: `${pastaDe(g)}/${g.identificador}`, bytes: new Uint8Array(await r.arrayBuffer()), data: new Date(g.finalizado_em || g.iniciado_em) });
    }
    progresso('Montando o ZIP…');
    const zip = montarZip(arquivos);
    const ev = estado.detalhe.evento;
    const nome = `audios_${ev.data}_${ev.nome}${sufixo ? `_${sufixo}` : ''}.zip`.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^A-Za-z0-9._-]+/g, '-').toLowerCase();
    const url = URL.createObjectURL(zip);
    const a = el('a', { href: url, download: nome });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    aviso(`ZIP pronto: ${lista.length} áudio(s), ${fmtBytes(zip.size)}.`);
  } finally {
    estado.baixando = false;
    renderizarGravacoes();
    if (estado.detalhe) renderizarCoreografias();
  }
}

/* ================================ COREOGRAFIAS ================================ */

async function carregarGrupos() {
  estado.grupos = await api('GET', `/api/admin/eventos/${estado.eventoId}/grupos`);
  $('c-grupos').textContent = estado.grupos.length;
  const sel = $('sel-grupo-coreografia');
  const atual = sel.value;
  sel.replaceChildren(
    el('option', { value: '', textContent: 'Sem grupo' }),
    ...estado.grupos.map((g) => el('option', { value: g.id, textContent: g.cidade ? `${g.nome} (${g.cidade})` : g.nome })),
  );
  sel.value = estado.grupos.some((g) => g.id === atual) ? atual : '';
  renderizarGrupos();
}

/* ================================ GRUPOS / ESCOLAS ================================ */

const CAMPOS_GRUPO = ['nome', 'cidade', 'responsavel', 'email', 'telefone', 'diretores', 'coordenadores'];
const nomesDe = (texto) => (texto ? texto.split('\n').filter(Boolean) : []);

function linhaEquipe(rotulo, texto) {
  const nomes = nomesDe(texto);
  return nomes.length ? el('div', {}, el('span', { class: 'rotulo-equipe', textContent: `${rotulo}: ` }), nomes.join(', ')) : null;
}


function renderizarGrupos() {
  $('tb-grupos').replaceChildren(
    ...(estado.grupos.length
      ? estado.grupos.map((g) =>
          el('tr', {},
            el('td', {},
              el('strong', { textContent: g.nome }),
              el('div', { class: 'muted', textContent: [g.cidade, g.responsavel && `Resp.: ${g.responsavel}`].filter(Boolean).join(' · ') }),
            ),
            el('td', { class: 'equipe' },
              linhaEquipe('Direção', g.diretores),
              linhaEquipe('Coordenação', g.coordenadores),
              !g.diretores && !g.coordenadores ? el('span', { class: 'muted', textContent: '—' }) : null,
            ),
            el('td', {}, el('div', { class: 'ident', textContent: g.email || '' }), el('div', { textContent: g.telefone || '' })),
            el('td', { textContent: g.coreografias }),
            el('td', { class: 'acoes' },
              botao('Editar', 'pencil', () => editarGrupo(g)),
              g.coreografias ? null : botao('Excluir', 'delete-outline', () => excluirGrupo(g), 'btn btn-sec btn-perigo'),
            ),
          ),
        )
      : [vazio(5, 'Nenhum grupo ou escola cadastrado neste evento.')]),
  );
}

function editarGrupo(g) {
  const f = $('form-grupo');
  for (const k of ['id', ...CAMPOS_GRUPO]) f[k].value = g[k] || '';
  $('btn-salvar-grupo').replaceChildren(icone('content-save-outline'), ' Salvar alterações');
  $('btn-cancelar-grupo').hidden = false;
  f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  f.nome.focus();
}

function cancelarGrupo() {
  $('form-grupo').reset();
  $('form-grupo').id.value = '';
  $('btn-salvar-grupo').replaceChildren(icone('plus'), ' Cadastrar');
  $('btn-cancelar-grupo').hidden = true;
}

async function salvarGrupo(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const id = f.get('id');
  const dados = Object.fromEntries(CAMPOS_GRUPO.map((k) => [k, f.get(k)]));
  if (id) await api('PATCH', `/api/admin/grupos/${id}`, { json: dados });
  else await api('POST', `/api/admin/eventos/${estado.eventoId}/grupos`, { json: dados });
  aviso(`Grupo "${dados.nome}" ${id ? 'atualizado' : 'cadastrado'}.`);
  cancelarGrupo();
  await Promise.all([carregarGrupos(), carregarDetalhe()]);
}

async function excluirGrupo(g) {
  if (!confirm(`Excluir o grupo "${g.nome}"?`)) return;
  await api('DELETE', `/api/admin/grupos/${g.id}`);
  aviso('Grupo excluído.');
  await carregarGrupos();
}

/* ================================ COREOGRAFIAS (lista) ================================ */

/** Célula "Áudios dos jurados": só a quantidade de áudios de cada jurado (ouvir e baixar ficam na aba Áudios). */
function audiosDaCoreografia(c) {
  const jurados = estado.detalhe?.jurados || [];
  if (!jurados.length) return [el('span', { class: 'muted', textContent: 'Nenhum jurado no evento' })];
  return [
    el('ul', { class: 'contagem-audios' },
      ...jurados.map((j) => {
        const n = c.audios_por_jurado?.[j.id] || 0;
        const chegando = c.chegando_por_jurado?.[j.id] || 0;
        return el('li', { class: n ? '' : 'sem-audio', title: j.nome },
          el('span', { class: 'audio-jurado' }, el('strong', { textContent: `J${j.ordem}` }), ` ${j.nome}`),
          el('span', { class: 'qtd-grupo' },
            chegando ? el('span', { class: 'muted qtd-chegando', textContent: `+${chegando} chegando` }) : null,
            el('span', { class: `qtd-audios${n ? ' tem' : ''}`, textContent: n === 1 ? '1 áudio' : `${n} áudios` }),
          ),
        );
      }),
    ),
  ];
}

function renderizarCoreografias() {
  const { coreografias } = estado.detalhe;
  $('tb-coreografias').replaceChildren(
    ...(coreografias.length
      ? coreografias.map((c) => {
          const emUso = c.n_gravacoes || c.n_notas || c.link_expira_em;
          return el('tr', {},
            el('td', {}, el('span', { class: 'num', textContent: num(c.numero) })),
            el('td', { textContent: c.nome }),
            el('td', { textContent: c.grupo || '—' }),
            el('td', { textContent: c.categoria || '—' }),
            el('td', {}, c.formacao ? rotuloFormacao(c.formacao) : selo('bloqueado', 'definir')),
            el('td', {}, c.faixa ? rotuloFaixa(c.faixa) : selo('bloqueado', 'definir')),
            el('td', { class: 'celula-audios' }, ...audiosDaCoreografia(c)),
            el('td', {}, c.link_expira_em ? selo('completo', `ativo até ${diaDe(c.link_expira_em)}`) : el('span', { class: 'muted', textContent: '—' })),
            el('td', { class: 'acoes' },
              botao('Editar', 'pencil', () => editarCoreografia(c)),
              botao(c.link_expira_em ? 'Novo link' : 'Gerar link', 'link-plus', () => tentar(() => gerarLink(c))),
              c.link_expira_em ? botao('Desativar', 'link-off', () => tentar(() => revogarLinks(c)), 'btn btn-sec btn-perigo') : null,
              emUso ? null : botao('Excluir', 'delete-outline', () => excluirCoreografia(c), 'btn btn-sec btn-perigo'),
            ),
          );
        })
      : [vazio(9, 'Nenhuma coreografia cadastrada.')]),
  );
}

function editarCoreografia(c) {
  const f = $('form-coreografia');
  f.numero.value = c.numero;
  f.nome.value = c.nome;
  f.grupo_id.value = c.grupo_id || '';
  f.categoria.value = c.categoria || '';
  f.formacao.value = c.formacao || '';
  f.faixa.value = c.faixa || '';
  f.integrantes.value = c.integrantes || '';
  f.coreografo.value = c.coreografo || '';
  f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  f.nome.focus();
}

async function salvarCoreografia(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  await api('POST', `/api/admin/eventos/${estado.eventoId}/coreografias`, {
    json: { numero: f.get('numero'), nome: f.get('nome'), grupo_id: f.get('grupo_id') || null, categoria: f.get('categoria'), formacao: f.get('formacao') || null, faixa: f.get('faixa') || null,
      integrantes: f.get('integrantes'), coreografo: f.get('coreografo') },
  });
  aviso(`Coreografia ${num(f.get('numero'))} salva.`);
  e.target.reset();
  await Promise.all([carregarDetalhe(), carregarQuadro()]);
}

async function importarCsv() {
  let texto = $('csv').value.trim();
  const arquivo = $('arquivo-csv').files[0];
  if (arquivo) texto = await arquivo.text();
  if (!texto) return aviso('Cole o CSV ou escolha um arquivo.', true);
  const r = await api('POST', `/api/admin/eventos/${estado.eventoId}/coreografias`, { texto });
  aviso(`${r.importadas} coreografia(s) importada(s) · ${r.grupos} grupo(s)${r.sem_formacao ? ` · ${r.sem_formacao} sem formação (defina para entrar no ranking certo)` : ''}${r.sem_faixa ? ` · ${r.sem_faixa} sem faixa` : ''}.`);
  $('csv').value = '';
  $('arquivo-csv').value = '';
  await Promise.all([carregarDetalhe(), carregarQuadro(), carregarGrupos()]);
}

async function excluirCoreografia(c) {
  if (!confirm(`Excluir a coreografia ${num(c.numero)} · ${c.nome}?`)) return;
  await api('DELETE', `/api/admin/coreografias/${c.id}`);
  aviso('Coreografia excluída.');
  await Promise.all([carregarDetalhe(), carregarQuadro()]);
}

/** Link exclusivo da coreografia (notas + áudios) para a escola/grupo. Um novo desativa o anterior. */
async function gerarLink(c) {
  if (c.link_expira_em && !confirm(`${num(c.numero)} · ${c.nome} já tem um link ativo (até ${diaDe(c.link_expira_em)}).\n\nGerar um novo? O link anterior deixa de funcionar.`)) return;
  const r = await api('POST', `/api/admin/coreografias/${c.id}/link`, { json: { dias: Number($('links-dias').value) || 30 } });
  const ok = await copiar(r.url);
  prompt(`Link exclusivo de ${num(c.numero)} · ${c.nome}${ok ? ' (copiado)' : ''}. Válido até ${fmtHora(r.expira_em)}:`, r.url);
  await carregarDetalhe();
}

async function revogarLinks(c) {
  if (!confirm(`Desativar o link de ${num(c.numero)} · ${c.nome}? Quem tiver o link não conseguirá mais abrir.`)) return;
  await api('POST', `/api/admin/coreografias/${c.id}/revogar-links`);
  aviso(`Link de ${num(c.numero)} desativado.`);
  await carregarDetalhe();
}

/** Gera os links de todas as coreografias (ou só das que não têm link ativo) e baixa a planilha para enviar às escolas. */
async function gerarLinksDoEvento() {
  const soNovos = $('links-so-novos').checked;
  const dias = Number($('links-dias').value) || 30;
  const alvo = estado.detalhe.coreografias.filter((c) => !soNovos || !c.link_expira_em).length;
  if (!alvo) return aviso('Todas as coreografias já têm link ativo. Desmarque "Só coreografias ainda sem link ativo" para gerar links novos para todas.');
  const trocar = estado.detalhe.coreografias.filter((c) => c.link_expira_em).length;
  if (!confirm(`Gerar ${alvo} link(s) válido(s) por ${dias} dias?${!soNovos && trocar ? `\n\n${trocar} coreografia(s) já têm link: o link anterior delas deixa de funcionar.` : ''}`)) return;
  const r = await api('POST', `/api/admin/eventos/${estado.eventoId}/links`, { json: { dias, somente_sem_link: soNovos } });
  const ev = estado.detalhe.evento;
  baixarCsv(`links-grupos_${ev.data}_${ev.nome}.csv`.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9._-]+/g, '-'), [
    ['numero', 'coreografia', 'grupo', 'responsavel_do_grupo', 'email', 'telefone', 'link', 'valido_ate'],
    ...r.links.map((l) => [num(l.numero), l.coreografia, l.grupo || '', l.grupo_responsavel || '', l.grupo_email || '', l.grupo_telefone || '', l.url, diaDe(l.expira_em)]),
  ]);
  aviso(`${r.links.length} link(s) gerado(s). A planilha foi baixada: envie a cada escola/grupo o link da sua coreografia.`);
  await carregarDetalhe();
}

/* ================================ JURADOS (ESCALA) ================================ */

function renderizarEscala() {
  const { jurados } = estado.detalhe;
  $('tb-escala').replaceChildren(
    ...(jurados.length
      ? jurados.map((j) =>
          el('tr', {},
            el('td', {}, el('span', { class: 'num', textContent: j.ordem })),
            el('td', { textContent: j.nome }),
            el('td', {}, el('div', { class: 'ident', textContent: j.email }), j.telefone ? el('div', { textContent: j.telefone }) : null),
            el('td', {},
              j.ativo ? selo('completo', 'Escalado') : selo('inativo', 'Suspenso'),
              !j.conta_ativa ? el('div', {}, selo('inativo', 'Conta desativada')) : j.trocar_senha ? el('div', {}, selo('provisoria', 'Senha provisória')) : null,
            ),
            el('td', { textContent: fmtHora(j.ultimo_acesso) }),
            el('td', { class: 'acoes' },
              j.ativo
                ? botao('Suspender', 'account-off', () => alterarEscala(j, false), 'btn btn-sec btn-perigo')
                : botao('Reativar', 'account-check', () => alterarEscala(j, true)),
              botao('Editar', 'pencil', () => editarJurado(j)),
              botao('Nova senha', 'lock-reset', () => novaSenhaJurado(j)),
            ),
          ),
        )
      : [vazio(6, 'Nenhum jurado neste evento ainda.')]),
  );
}

async function escalar(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api('POST', `/api/admin/eventos/${estado.eventoId}/jurados`, {
    json: { nome: f.get('nome'), email: f.get('email'), telefone: f.get('telefone') },
  });
  e.target.reset();
  if (r.senha_provisoria) {
    mostrarSenha(`Conta criada: ${r.nome} (${r.email}) · Jurado ${r.ordem} · app: ${r.link}`, r.senha_provisoria);
  }
  aviso(`${r.nome} escalado como Jurado ${r.ordem}.${r.criado ? '' : ' Ele já tinha conta: entra com a senha que já usa.'}`);
  await Promise.all([carregarDetalhe(), carregarQuadro()]);
}

async function alterarEscala(j, ativo) {
  if (!ativo && !confirm(`Suspender ${j.nome} neste evento? O acesso é cortado na hora e as notas dele deixam de contar na média.`)) return;
  await api('PATCH', `/api/admin/eventos/${estado.eventoId}/jurados/${j.id}`, { json: { ativo } });
  aviso(`${j.nome} ${ativo ? 'reativado' : 'suspenso'} neste evento.`);
  await Promise.all([carregarDetalhe(), carregarQuadro()]);
}

async function editarJurado(j) {
  const nome = prompt('Nome do jurado:', j.nome);
  if (nome == null) return;
  const telefone = prompt('Telefone (deixe vazio para remover):', j.telefone || '');
  if (telefone == null) return;
  await api('PATCH', `/api/admin/jurados/${j.id}`, { json: { nome, telefone } });
  aviso('Jurado atualizado.');
  await Promise.all([carregarDetalhe(), carregarQuadro()]);
}

async function novaSenhaJurado(j) {
  if (!confirm(`Gerar nova senha provisória para ${j.nome}? A senha atual deixa de valer.`)) return;
  const r = await api('POST', `/api/admin/jurados/${j.id}/redefinir-senha`);
  mostrarSenha(`Nova senha provisória de ${j.nome} (${r.email})`, r.senha_provisoria);
  await carregarDetalhe();
}

/* ================================ INÍCIO ================================ */

async function carregarListaEventos() {
  estado.eventos = await api('GET', '/api/admin/eventos');
  $('sel-evento').replaceChildren(...estado.eventos.map((e) => el('option', { value: e.id, textContent: `${fmtData(e.data)} · ${e.nome}` })));
  $('linha-seletor').hidden = estado.eventos.length < 2;
  if (estado.eventoId) $('sel-evento').value = estado.eventoId;
}

async function iniciar() {
  document.querySelectorAll('[data-aba]').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.aba)));
  $('sel-evento').addEventListener('change', (e) => tentar(() => abrirEvento(e.target.value)));
  $('btn-atualizar').addEventListener('click', () => tentar(() => abrirEvento(estado.eventoId)));
  $('btn-editar-evento').addEventListener('click', preencherFormEvento);
  $('btn-cancelar-evento').addEventListener('click', () => ($('form-evento').hidden = true));
  $('form-evento').addEventListener('submit', (e) => tentar(() => salvarEvento(e)));
  $('btn-copiar-link').addEventListener('click', async () => aviso((await copiar($('link-jurados-url').textContent)) ? 'Link copiado.' : 'Copie o link manualmente.'));
  $('filtro-formacao-notas').addEventListener('change', renderizarNotas);
  $('busca-notas').addEventListener('input', renderizarNotas);
  $('filtro-categoria').addEventListener('change', renderizarRanking);
  $('filtro-formacao-ranking').addEventListener('change', (e) => escolherFormacao(e.target.value));
  $('btn-limpar-filtros-ranking').addEventListener('click', () => escolherFormacao(TODAS));
  $('filtro-faixa').addEventListener('change', () => { $('filtro-categoria').value = '*'; renderizarRanking(); });
  $('filtro-faixa-notas').addEventListener('change', renderizarNotas);
  $('btn-exportar-ranking').addEventListener('click', exportarRanking);
  $('busca-audios').addEventListener('input', renderizarGravacoes);
  $('filtro-jurado-audios').addEventListener('change', renderizarGravacoes);
  $('filtro-status-audios').addEventListener('change', renderizarGravacoes);
  $('btn-zip').addEventListener('click', () => tentar(baixarZip));
  // o botão da linha acompanha o player (tocar/pausar/terminar)
  for (const ev of ['play', 'pause', 'ended']) $('player').addEventListener(ev, rerenderizarListasDeAudio);
  $('btn-fechar-player').addEventListener('click', fecharPlayer);
  $('form-coreografia').addEventListener('submit', (e) => tentar(() => salvarCoreografia(e)));
  $('btn-gerar-links').addEventListener('click', () => tentar(gerarLinksDoEvento));
  $('btn-importar').addEventListener('click', () => tentar(importarCsv));
  $('form-escala').addEventListener('submit', (e) => tentar(() => escalar(e)));
  $('form-grupo').addEventListener('submit', (e) => tentar(() => salvarGrupo(e)));
  $('btn-cancelar-grupo').addEventListener('click', cancelarGrupo);
  $('form-conta-senha').addEventListener('submit', (e) => tentar(() => trocarMinhaSenha(e)));
  $('btnSair').addEventListener('click', () => tentar(sair));
  ligarCaixaSenha();

  await tentar(async () => {
    estado.eu = await api('GET', '/api/admin/me');
    $('adminEmail').textContent = estado.eu.email;
    $('adminChip').hidden = false;
    $('link-dashboard').hidden = !geral();
    $('conta-nome').textContent = estado.eu.nome;
    $('conta-email').textContent = estado.eu.email;
    $('conta-nivel').textContent = geral() ? 'Administrador geral' : 'Responsável de evento';
    $('conta-usuario').value = estado.eu.email;

    await carregarListaEventos();
    if (!estado.eventos.length) {
      for (const s of document.querySelectorAll('main > :not(#sem-eventos):not(#mensagem)')) s.hidden = true;
      $('sem-eventos').hidden = false;
      return;
    }
    const pedido = new URLSearchParams(location.search).get('id');
    const id = estado.eventos.some((e) => e.id === pedido) ? pedido : estado.eventos[0].id;
    trocarAba(location.hash.slice(1) || ler(CHAVE_ABA) || 'notas');
    await abrirEvento(id);
  });
}

iniciar();
