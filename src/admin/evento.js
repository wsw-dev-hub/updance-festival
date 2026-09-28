// Tela exclusiva do evento — usada pela organização (nível geral) e pelos responsáveis do evento.
// Abas: Notas (quadro coreografias × jurados, com status dos áudios e média), Ranking (pódio + lista,
// por formação), Áudios, Coreografias, Jurados (escala), Responsáveis (só geral), Auditoria e Minha conta.

import {
  $, num, api, aviso, tentar, el, icone, botao, selo, vazio, fmtDuracao, fmtHora, fmtData, paraCampo, comFuso, fmtNota,
  FORMACOES, rotuloFormacao, situacaoEvento, situacaoConta, copiar, mostrarSenha, ligarCaixaSenha, guardar, ler,
  trocarMinhaSenha, sair, baixarCsv,
} from './comum.js';
import { montarZip } from './zip.js';

const CHAVE_ABA = 'udx-festival.evento.aba';
const ABAS = ['notas', 'ranking', 'gravacoes', 'coreografias', 'jurados', 'responsaveis', 'auditoria', 'conta'];
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
const fmtMedia = (m) => fmtNota(m, Math.min(casas() + 1, 3));

/* ================================ NAVEGAÇÃO ================================ */

function trocarAba(nome) {
  if (!ABAS.includes(nome) || (nome === 'responsaveis' && !geral())) nome = 'notas';
  estado.aba = nome;
  guardar(CHAVE_ABA, nome);
  for (const b of document.querySelectorAll('[data-aba]')) b.classList.toggle('is-active', b.dataset.aba === nome);
  for (const s of document.querySelectorAll('.aba')) s.hidden = s.id !== `aba-${nome}`;
  const carregar = { gravacoes: carregarGravacoes, auditoria: carregarAuditoria }[nome];
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
  if (estado.aba === 'auditoria') await carregarAuditoria();
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
  renderizarResponsaveis(responsaveis);
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
}

function montarFiltroFormacao() {
  const sel = $('filtro-formacao-notas');
  const atual = sel.value;
  const tem = new Set(estado.quadro.coreografias.map((c) => c.formacao || ''));
  sel.replaceChildren(
    el('option', { value: '*', textContent: 'Todas as formações' }),
    ...FORMACOES.filter((f) => tem.has(f.id)).map((f) => el('option', { value: f.id, textContent: f.rotulo })),
    tem.has('') ? el('option', { value: '', textContent: 'Sem formação' }) : null,
  );
  sel.value = [...sel.options].some((o) => o.value === atual) ? atual : '*';
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
    onclick: () => tocar($('player-notas'), a.gravacao_id, `${num(c.numero)} · ${c.nome} — ${jurado.nome}`),
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

function tocar(player, gravacaoId, rotulo, { avisar = true } = {}) {
  corrigirDuracao(player);
  player.src = `/api/admin/gravacoes/${gravacaoId}/audio`;
  player.hidden = false;
  player.play().catch(() => aviso('Não foi possível tocar este áudio neste navegador. Use "Baixar" e abra no seu player.', true));
  if (avisar) aviso(`Tocando: ${rotulo}`);
}

function filtrarNotas(lista) {
  const f = $('filtro-formacao-notas').value;
  const q = $('busca-notas').value.trim().toLowerCase();
  return lista.filter((c) => {
    if (f !== '*' && (c.formacao || '') !== f) return false;
    if (!q) return true;
    return `${num(c.numero)} ${c.nome} ${c.grupo || ''} ${c.categoria || ''}`.toLowerCase().includes(q);
  });
}

function renderizarNotas() {
  const { jurados, coreografias, resumo } = estado.quadro;
  const pct = resumo.notas_esperadas ? Math.round((resumo.notas_lancadas / resumo.notas_esperadas) * 100) : 0;
  $('resumo-notas').textContent = `${resumo.notas_lancadas} de ${resumo.notas_esperadas} notas (${pct}%) · atualizado ${fmtHora(estado.quadro.gerado_em)}`;
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
              el('div', { class: 'muted', textContent: [c.grupo, rotuloFormacao(c.formacao), c.categoria].filter(Boolean).join(' · ') }),
            ),
            ...jurados.map((j) =>
              el('td', { class: `celula-nota${j.ativo ? '' : ' suspenso'}` },
                el('span', { class: `nota-valor${c.notas[j.id] == null ? ' sem' : ''}`, textContent: fmtNota(c.notas[j.id], casas()) }),
                flagAudio(c.audios[j.id], j, c),
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

function renderizarRanking() {
  const segs = segmentosDisponiveis();
  if (estado.segmento === null || !segs.some((s) => s.id === estado.segmento && s.total)) {
    estado.segmento = (segs.find((s) => s.total) || segs[0]).id;
  }
  $('segmentos').replaceChildren(
    ...segs.map((s) =>
      el('button', {
        class: `tab${s.id === estado.segmento ? ' is-active' : ''}`, type: 'button', role: 'tab', disabled: !s.total,
        onclick: () => { estado.segmento = s.id; $('filtro-categoria').value = '*'; renderizarRanking(); },
      }, s.rotulo, el('span', { class: 'contador', textContent: ` ${s.total}` })),
    ),
  );

  const doSegmento = estado.quadro.coreografias.filter((c) => (c.formacao || '') === estado.segmento);
  const cats = [...new Set(doSegmento.map((c) => c.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const sel = $('filtro-categoria');
  const atual = sel.value;
  sel.replaceChildren(el('option', { value: '*', textContent: 'Todas as categorias' }), ...cats.map((c) => el('option', { value: c, textContent: c })));
  sel.value = cats.includes(atual) ? atual : '*';
  sel.hidden = !cats.length;

  const lista = classificar(doSegmento.filter((c) => sel.value === '*' || c.categoria === sel.value));
  estado.rankingAtual = lista;
  const ativos = estado.quadro.resumo.jurados_ativos;
  const comNota = lista.filter((c) => c.posicao);
  $('resumo-ranking').textContent = `${comNota.length} de ${lista.length} coreografias com nota`;

  // Pódio: as 3 maiores médias
  const top = comNota.slice(0, 3);
  $('podio').replaceChildren(
    ...(top.length
      ? top.map((c, i) =>
          el('article', { class: `podio-item podio-${i + 1}` },
            el('div', { class: 'podio-posicao' }, el('span', { textContent: `${c.posicao}º` }), c.empate ? el('small', { textContent: 'empate' }) : null),
            el('div', { class: 'podio-media', textContent: fmtMedia(c.media) }),
            el('div', { class: 'podio-nome' }, el('span', { class: 'num', textContent: num(c.numero) }), ` ${c.nome}`),
            el('div', { class: 'muted', textContent: [c.grupo, c.categoria].filter(Boolean).join(' · ') || rotuloFormacao(c.formacao) }),
            c.qtd_notas < ativos ? selo('gravando', `parcial · ${c.qtd_notas}/${ativos} notas`) : selo('completo', `${c.qtd_notas}/${ativos} notas`),
          ),
        )
      : [el('p', { class: 'muted podio-vazio', textContent: 'O pódio aparece assim que as primeiras notas forem lançadas.' })]),
  );

  $('tb-ranking').replaceChildren(
    ...(lista.length
      ? lista.map((c) =>
          el('tr', { class: c.posicao && c.posicao <= 3 ? `destaque-top top-${c.posicao}` : '' },
            el('td', {}, c.posicao ? el('span', { class: 'posicao', textContent: `${c.posicao}º` }) : el('span', { class: 'muted', textContent: '—' })),
            el('td', {}, el('span', { class: 'num', textContent: num(c.numero) })),
            el('td', { textContent: c.nome }),
            el('td', { textContent: c.grupo || '—' }),
            el('td', { textContent: c.categoria || '—' }),
            el('td', {}, el('strong', { class: 'media-valor', textContent: fmtMedia(c.media) })),
            el('td', {}, c.posicao
              ? (c.qtd_notas < ativos ? selo('gravando', `${c.qtd_notas}/${ativos} parcial`) : selo('completo', `${c.qtd_notas}/${ativos}`))
              : selo('provisoria', 'sem notas')),
          ),
        )
      : [vazio(7, 'Nenhuma coreografia nesta formação.')]),
  );
}

function exportarRanking() {
  const lista = estado.rankingAtual || [];
  const seg = segmentosDisponiveis().find((s) => s.id === estado.segmento)?.rotulo || 'ranking';
  const cat = $('filtro-categoria').value;
  const ev = estado.quadro.evento;
  const jurados = estado.quadro.jurados.filter((j) => j.ativo);
  baixarCsv(`ranking_${ev.data}_${seg}${cat !== '*' ? `_${cat}` : ''}.csv`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'), [
    ['posicao', 'numero', 'coreografia', 'grupo', 'categoria', 'formacao', 'media', 'notas_lancadas', ...jurados.map((j) => `J${j.ordem} ${j.nome}`)],
    ...lista.map((c) => [
      c.posicao ?? '', c.numero, c.nome, c.grupo || '', c.categoria || '', rotuloFormacao(c.formacao),
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
    return !q || `${num(g.numero)} ${g.coreografia} ${g.grupo || ''}`.toLowerCase().includes(q);
  });
}

function renderizarGravacoes() {
  const lista = gravacoesFiltradas();
  const player = $('player');
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
          const tocandoEste = estado.tocando === g.id && !player.paused;
          return el('tr', { class: estado.tocando === g.id ? 'tocando' : '', dataset: { id: g.id } },
            el('td', {}, el('span', { class: 'num', textContent: num(g.numero) })),
            el('td', {},
              el('div', { textContent: `${g.coreografia}${g.versao > 1 ? ` (v${g.versao})` : ''}` }),
              g.grupo ? el('div', { class: 'muted', textContent: g.grupo }) : null,
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
  const player = $('player');
  if (estado.tocando === g.id) {
    if (player.paused) player.play().catch(() => {});
    else player.pause();
    return;
  }
  estado.tocando = g.id;
  $('player-titulo').textContent = `${num(g.numero)} · ${g.coreografia} — ${g.jurado}${g.status !== 'completo' ? ' (parcial)' : ''}`;
  $('barra-player').hidden = false;
  tocar(player, g.id, g.identificador, { avisar: false }); // o título já aparece na barra do player
}

async function aprovar(g, aprovada) {
  await api('POST', `/api/admin/gravacoes/${g.id}/aprovar`, { json: { aprovada } });
  await Promise.all([carregarGravacoes(), carregarQuadro()]);
}

const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const pastaDe = (g) => `${num(g.numero)}_${g.coreografia}`.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);

/** Baixa os áudios completos da lista filtrada, um por um, e monta um ZIP (pastas por coreografia). */
async function baixarZip() {
  if (estado.baixando) return;
  const lista = gravacoesFiltradas().filter((g) => g.status === 'completo');
  const total = lista.reduce((s, g) => s + (g.tamanho || 0), 0);
  if (!lista.length) return aviso('Nenhum áudio completo na lista filtrada.', true);
  if (total > ZIP_LIMITE_BYTES) {
    return aviso(`São ${fmtBytes(total)} de áudio: acima de ${fmtBytes(ZIP_LIMITE_BYTES)}, o navegador pode travar. Filtre por jurado ou coreografia e baixe em partes.`, true);
  }
  estado.baixando = true;
  $('btn-zip').disabled = true;
  try {
    const arquivos = [];
    for (const [i, g] of lista.entries()) {
      $('btn-zip-texto').textContent = `Baixando ${i + 1}/${lista.length}…`;
      const r = await fetch(`/api/admin/gravacoes/${g.id}/audio?download=1`, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error(`Falha ao baixar ${g.identificador} (erro ${r.status})`);
      arquivos.push({ nome: `${pastaDe(g)}/${g.identificador}`, bytes: new Uint8Array(await r.arrayBuffer()), data: new Date(g.finalizado_em || g.iniciado_em) });
    }
    $('btn-zip-texto').textContent = 'Montando o ZIP…';
    const zip = montarZip(arquivos);
    const ev = estado.detalhe.evento;
    const filtro = [$('filtro-jurado-audios').value, $('filtro-status-audios').value].filter((v) => v !== '*').join('_');
    const nome = `audios_${ev.data}_${ev.nome}${filtro ? `_${filtro}` : ''}.zip`.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^A-Za-z0-9._-]+/g, '-').toLowerCase();
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
  }
}

/* ================================ COREOGRAFIAS ================================ */

async function carregarGrupos() {
  estado.grupos = await api('GET', '/api/admin/grupos');
  $('sel-grupo-coreografia').replaceChildren(
    el('option', { value: '', textContent: 'Sem grupo' }),
    ...estado.grupos.map((g) => el('option', { value: g.id, textContent: g.cidade ? `${g.nome} (${g.cidade})` : g.nome })),
  );
}

function renderizarCoreografias() {
  const { coreografias } = estado.detalhe;
  $('tb-coreografias').replaceChildren(
    ...(coreografias.length
      ? coreografias.map((c) => {
          const emUso = c.n_gravacoes || c.n_notas;
          return el('tr', {},
            el('td', {}, el('span', { class: 'num', textContent: num(c.numero) })),
            el('td', { textContent: c.nome }),
            el('td', { textContent: c.grupo || '—' }),
            el('td', { textContent: c.categoria || '—' }),
            el('td', {}, c.formacao ? rotuloFormacao(c.formacao) : selo('bloqueado', 'definir')),
            el('td', { class: 'muted', textContent: `${c.n_gravacoes} áudio(s) · ${c.n_notas} nota(s)` }),
            el('td', { class: 'acoes' },
              botao('Editar', 'pencil', () => editarCoreografia(c)),
              botao('Link de entrega', 'link-plus', () => gerarLink(c)),
              botao('Revogar links', 'link-off', () => revogarLinks(c), 'btn btn-sec btn-perigo'),
              emUso ? null : botao('Excluir', 'delete-outline', () => excluirCoreografia(c), 'btn btn-sec btn-perigo'),
            ),
          );
        })
      : [vazio(7, 'Nenhuma coreografia cadastrada.')]),
  );
}

function editarCoreografia(c) {
  const f = $('form-coreografia');
  f.numero.value = c.numero;
  f.nome.value = c.nome;
  f.grupo_id.value = c.grupo_id || '';
  f.categoria.value = c.categoria || '';
  f.formacao.value = c.formacao || '';
  f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  f.nome.focus();
}

async function salvarCoreografia(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  await api('POST', `/api/admin/eventos/${estado.eventoId}/coreografias`, {
    json: { numero: f.get('numero'), nome: f.get('nome'), grupo_id: f.get('grupo_id') || null, categoria: f.get('categoria'), formacao: f.get('formacao') || null },
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
  aviso(`${r.importadas} coreografia(s) importada(s) · ${r.grupos} grupo(s)${r.sem_formacao ? ` · ${r.sem_formacao} sem formação (defina para entrar no ranking certo)` : ''}.`);
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

async function gerarLink(c) {
  const r = await api('POST', `/api/admin/coreografias/${c.id}/link`, { json: { dias: 30 } });
  const ok = await copiar(r.url);
  prompt(`Link de ${num(c.numero)} · ${c.nome}${ok ? ' (copiado)' : ''}. Válido até ${fmtHora(r.expira_em)}:`, r.url);
}

async function revogarLinks(c) {
  if (!confirm(`Revogar todos os links de entrega de ${c.nome}?`)) return;
  const r = await api('POST', `/api/admin/coreografias/${c.id}/revogar-links`);
  aviso(`${r.revogados} link(s) revogado(s).`);
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
            el('td', { class: 'ident', textContent: j.email }),
            el('td', {},
              j.ativo ? selo('completo', 'Escalado') : selo('inativo', 'Suspenso'),
              !j.conta_ativa ? el('div', {}, selo('inativo', 'Conta desativada')) : j.trocar_senha ? el('div', {}, selo('provisoria', 'Senha provisória')) : null,
            ),
            el('td', { textContent: fmtHora(j.ultimo_acesso) }),
            el('td', { class: 'acoes' },
              j.ativo
                ? botao('Suspender', 'account-off', () => alterarEscala(j, false), 'btn btn-sec btn-perigo')
                : botao('Reativar', 'account-check', () => alterarEscala(j, true)),
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

async function novaSenhaJurado(j) {
  if (!confirm(`Gerar nova senha provisória para ${j.nome}? A senha atual deixa de valer.`)) return;
  const r = await api('POST', `/api/admin/jurados/${j.id}/redefinir-senha`);
  mostrarSenha(`Nova senha provisória de ${j.nome} (${r.email})`, r.senha_provisoria);
  await carregarDetalhe();
}

/* ================================ RESPONSÁVEIS ================================ */

function renderizarResponsaveis(lista) {
  $('tb-responsaveis').replaceChildren(
    ...(lista.length
      ? lista.map((a) =>
          el('tr', {},
            el('td', { textContent: a.nome }),
            el('td', { class: 'ident', textContent: a.email }),
            el('td', {}, situacaoConta(a)),
            el('td', { textContent: fmtHora(a.ultimo_acesso) }),
            el('td', { class: 'acoes' }, geral() ? botao('Remover do evento', 'account-remove', () => removerResponsavel(a), 'btn btn-sec btn-perigo') : null),
          ),
        )
      : [vazio(5, 'Nenhum responsável ligado a este evento.')]),
  );
}

async function adicionarResponsavel(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api('POST', `/api/admin/eventos/${estado.eventoId}/responsaveis`, { json: { nome: f.get('nome'), email: f.get('email') } });
  e.target.reset();
  if (r.senha_provisoria) mostrarSenha(`Conta de responsável criada: ${r.nome} (${r.email}) · acesso: ${r.link}`, r.senha_provisoria);
  aviso(`${r.nome} agora é responsável por este evento.`);
  await carregarDetalhe();
}

async function removerResponsavel(a) {
  if (!confirm(`Remover ${a.nome} deste evento? A pessoa perde o acesso a esta tela na hora.`)) return;
  await api('DELETE', `/api/admin/eventos/${estado.eventoId}/responsaveis/${a.id}`);
  aviso(`${a.nome} removido do evento.`);
  await carregarDetalhe();
}

/* ================================ AUDITORIA ================================ */

async function carregarAuditoria() {
  const linhas = await api('GET', `/api/admin/auditoria?evento=${encodeURIComponent(estado.eventoId)}`);
  $('tb-auditoria').replaceChildren(
    ...(linhas.length
      ? linhas.map((l) =>
          el('tr', {},
            el('td', { textContent: fmtHora(l.criado_em) }),
            el('td', { class: 'ident', textContent: l.ator }),
            el('td', { textContent: l.acao }),
            el('td', { class: 'ident', textContent: l.alvo || '' }),
            el('td', { class: 'ident', textContent: l.detalhes || '' }),
          ),
        )
      : [vazio(5, 'Nenhum registro.')]),
  );
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
  $('btn-exportar-ranking').addEventListener('click', exportarRanking);
  $('busca-audios').addEventListener('input', renderizarGravacoes);
  $('filtro-jurado-audios').addEventListener('change', renderizarGravacoes);
  $('filtro-status-audios').addEventListener('change', renderizarGravacoes);
  $('btn-zip').addEventListener('click', () => tentar(baixarZip));
  // o botão da linha acompanha o player (tocar/pausar/terminar)
  for (const ev of ['play', 'pause', 'ended']) $('player').addEventListener(ev, () => { if (estado.aba === 'gravacoes') renderizarGravacoes(); });
  $('form-coreografia').addEventListener('submit', (e) => tentar(() => salvarCoreografia(e)));
  $('btn-importar').addEventListener('click', () => tentar(importarCsv));
  $('form-escala').addEventListener('submit', (e) => tentar(() => escalar(e)));
  $('form-responsavel').addEventListener('submit', (e) => tentar(() => adicionarResponsavel(e)));
  $('form-conta-senha').addEventListener('submit', (e) => tentar(() => trocarMinhaSenha(e)));
  $('btnSair').addEventListener('click', () => tentar(sair));
  ligarCaixaSenha();

  await tentar(async () => {
    estado.eu = await api('GET', '/api/admin/me');
    $('adminEmail').textContent = estado.eu.email;
    $('adminChip').hidden = false;
    $('link-dashboard').hidden = !geral();
    $('tab-responsaveis').hidden = !geral();
    $('form-responsavel').hidden = !geral();
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
    trocarAba(ler(CHAVE_ABA) || 'notas');
    await abrirEvento(id);
  });
}

iniciar();
