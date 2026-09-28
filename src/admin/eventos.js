// Tela "Eventos e responsáveis": criar eventos e definir quem administra cada um.
//   • Responsável: vê e cria os SEUS eventos (quem cria vira responsável) e controla os responsáveis deles.
//   • Geral: vê todos os eventos e pode criar eventos já com os responsáveis.
// Grupos, jurados, coreografias, notas e áudios ficam na tela de cada evento (/admin/evento/?id=…).

import {
  $, api, aviso, tentar, el, icone, botao, selo, fmtHora, fmtData, comFuso, situacaoEvento, situacaoConta, copiar,
  trocarMinhaSenha, sair,
} from './comum.js';

const estado = { eu: null, eventos: [], credenciais: [] };
const geral = () => estado.eu?.nivel === 'geral';
const urlEvento = (id) => `/admin/evento/?id=${encodeURIComponent(id)}`;

/* ------------------------------ credenciais (senhas provisórias) ------------------------------ */

function mostrarCredenciais(titulo, novas) {
  if (!novas.length) return;
  estado.credenciais = novas;
  $('credenciais-titulo').textContent = titulo;
  $('link-login').textContent = `${location.origin}/admin-login/`;
  $('lista-credenciais').replaceChildren(
    ...novas.map((c) => el('li', {},
      el('div', {}, el('strong', { textContent: c.nome }), el('span', { class: 'muted', textContent: ` · ${c.email}` })),
      el('code', { textContent: c.senha_provisoria }),
    )),
  );
  $('caixa-credenciais').hidden = false;
  $('caixa-credenciais').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function textoCredenciais() {
  const login = `${location.origin}/admin-login/`;
  return estado.credenciais.map((c) => `${c.nome}\nAcesso: ${login}\nE-mail: ${c.email}\nSenha provisória: ${c.senha_provisoria}`).join('\n\n');
}

/* ------------------------------ novo evento ------------------------------ */

function linhaResponsavel(focar = true) {
  const linha = el('div', { class: 'linha-responsavel' },
    el('label', {}, 'Nome', el('input', { name: 'resp_nome', maxLength: 120, placeholder: 'obrigatório para conta nova' })),
    el('label', {}, 'E-mail', el('input', { name: 'resp_email', type: 'email', maxLength: 254 })),
    el('button', { class: 'btn btn-sec btn-perigo', type: 'button', ariaLabel: 'Remover linha', onclick: () => linha.remove() }, icone('close'), el('span', { class: 'rotulo-alt', textContent: 'Remover' })),
  );
  $('linhas-responsaveis').append(linha);
  if (focar === true) linha.querySelector('input').focus();
}

async function criarEvento(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const nomes = f.getAll('resp_nome');
  const responsaveis = f.getAll('resp_email')
    .map((email, i) => ({ nome: nomes[i], email: email.trim() }))
    .filter((r) => r.email);
  $('btn-criar-evento').disabled = true;
  try {
    const r = await api('POST', '/api/admin/eventos', {
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
        responsaveis,
      },
    });
    e.target.reset();
    $('linhas-responsaveis').replaceChildren();
    $('det-novo').open = false;
    aviso(`Evento "${r.nome}" criado. Abra a tela do evento para cadastrar grupos, jurados e coreografias.`);
    mostrarCredenciais(`Responsáveis de "${r.nome}" com conta nova`, r.responsaveis.filter((x) => x.senha_provisoria));
    await carregarEventos();
    destacar(r.id);
  } finally {
    $('btn-criar-evento').disabled = false;
  }
}

/* ------------------------------ lista de eventos ------------------------------ */

async function carregarEventos() {
  estado.eventos = await api('GET', '/api/admin/eventos');
  $('linha-busca').hidden = estado.eventos.length < 4;
  if (!estado.eventos.length) $('det-novo').open = true;
  renderizarEventos();
}

function renderizarEventos() {
  const q = $('busca-eventos').value.trim().toLowerCase();
  const lista = estado.eventos.filter((e) =>
    !q || `${e.nome} ${e.local || ''} ${e.responsaveis_lista.map((r) => `${r.nome} ${r.email}`).join(' ')}`.toLowerCase().includes(q));
  if (!lista.length) {
    $('lista-eventos').replaceChildren(el('p', { class: 'card muted', textContent: estado.eventos.length ? 'Nenhum evento com essa busca.' : 'Você ainda não tem eventos. Crie o primeiro acima.' }));
    return;
  }
  $('lista-eventos').replaceChildren(...lista.map(cartaoEvento));
}

function cartaoEvento(e) {
  const sit = situacaoEvento(e);
  const esperadas = e.n_coreografias * e.n_jurados;
  const pct = esperadas ? Math.round((e.n_notas / esperadas) * 100) : 0;
  const form = el('form', { class: 'form-add-responsavel', onsubmit: (ev) => tentar(() => adicionarResponsavel(ev, e)) },
    el('input', { name: 'nome', maxLength: 120, placeholder: 'Nome (conta nova)', ariaLabel: 'Nome do responsável' }),
    el('input', { name: 'email', type: 'email', required: true, maxLength: 254, placeholder: 'E-mail', ariaLabel: 'E-mail do responsável' }),
    el('button', { class: 'btn btn-hot', type: 'submit' }, icone('account-plus'), ' Adicionar'),
  );
  return el('article', { class: 'card cartao-evento', id: `evento-${e.id}` },
    el('div', { class: 'cartao-evento-topo' },
      el('span', { class: 'cartao-evento-data', textContent: fmtData(e.data) }),
      selo(sit.classe, sit.texto),
    ),
    el('h2', { textContent: e.nome }),
    el('p', { class: 'muted', textContent: e.local || 'Local a definir' }),
    el('dl', { class: 'numeros-evento' },
      el('div', {}, el('dt', { textContent: 'Coreografias' }), el('dd', { textContent: e.n_coreografias })),
      el('div', {}, el('dt', { textContent: 'Grupos' }), el('dd', { textContent: e.n_grupos })),
      el('div', {}, el('dt', { textContent: 'Jurados' }), el('dd', { textContent: e.n_jurados })),
      el('div', {}, el('dt', { textContent: 'Notas' }), el('dd', { textContent: `${pct}%` })),
    ),
    el('div', { class: 'barra-progresso', title: `${e.n_notas} de ${esperadas} notas lançadas` }, el('span', { style: { width: `${pct}%` } })),
    el('h3', { class: 'titulo-responsaveis' }, icone('account-tie'), ' Responsáveis'),
    el('ul', { class: 'lista-responsaveis' },
      ...(e.responsaveis_lista.length
        ? e.responsaveis_lista.map((r) => {
            const souEu = r.id === estado.eu.id;
            return el('li', {},
              el('div', { class: 'resp-info' },
                el('strong', { textContent: r.nome }), souEu ? el('span', { class: 'muted', textContent: ' (você)' }) : null,
                el('div', { class: 'ident', textContent: r.email }),
                el('div', {}, situacaoConta(r), el('span', { class: 'muted', textContent: ` · último acesso ${fmtHora(r.ultimo_acesso)}` })),
              ),
              el('div', { class: 'acoes' },
                souEu ? null : botao('Nova senha', 'lock-reset', () => novaSenha(e, r)),
                botao(souEu ? 'Sair do evento' : 'Remover', 'account-remove', () => removerResponsavel(e, r, souEu), 'btn btn-sec btn-perigo'),
              ),
            );
          })
        : [el('li', { class: 'muted' }, selo('bloqueado', 'sem responsável'), ' Adicione quem vai administrar este evento.')]),
    ),
    form,
    el('div', { class: 'linha' },
      el('a', { class: 'btn btn-hot', href: urlEvento(e.id) }, icone('open-in-app'), ' Abrir tela do evento'),
      botao('Link dos jurados', 'link-variant', async () => {
        const link = `${location.origin}/?evento=${e.id}`;
        aviso((await copiar(link)) ? `Link do app copiado: ${link}` : `Link do app: ${link}`);
      }),
    ),
  );
}

function destacar(id) {
  const card = document.getElementById(`evento-${id}`);
  if (!card) return;
  card.classList.add('destacado');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => card.classList.remove('destacado'), 2500);
}

async function adicionarResponsavel(ev, e) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const r = await api('POST', `/api/admin/eventos/${e.id}/responsaveis`, { json: { nome: f.get('nome'), email: f.get('email') } });
  aviso(`${r.nome} agora é responsável por "${e.nome}".${r.criado ? '' : ' Ele já tinha conta: entra com a senha que já usa.'}`);
  if (r.senha_provisoria) mostrarCredenciais(`Novo responsável de "${e.nome}"`, [r]);
  await carregarEventos();
}

async function removerResponsavel(e, r, souEu) {
  const texto = souEu
    ? `Sair de "${e.nome}"? Você perde o acesso a este evento.`
    : `Remover ${r.nome} de "${e.nome}"? A pessoa perde o acesso ao evento na hora.`;
  if (!confirm(texto)) return;
  await api('DELETE', `/api/admin/eventos/${e.id}/responsaveis/${r.id}`);
  aviso(souEu ? `Você saiu de "${e.nome}".` : `${r.nome} removido de "${e.nome}".`);
  await carregarEventos();
}

async function novaSenha(e, r) {
  if (!confirm(`Gerar nova senha provisória para ${r.nome}? A senha atual deixa de valer.`)) return;
  const x = await api('POST', `/api/admin/eventos/${e.id}/responsaveis/${r.id}/redefinir-senha`);
  mostrarCredenciais(`Nova senha provisória de ${r.nome}`, [{ nome: r.nome, email: x.email, senha_provisoria: x.senha_provisoria }]);
  await carregarEventos();
}

/* ------------------------------ início ------------------------------ */

async function iniciar() {
  $('form-evento').addEventListener('submit', (e) => tentar(() => criarEvento(e)));
  $('btn-mais-responsavel').addEventListener('click', linhaResponsavel);
  $('busca-eventos').addEventListener('input', renderizarEventos);
  $('form-conta-senha').addEventListener('submit', (e) => tentar(() => trocarMinhaSenha(e)));
  $('btnSair').addEventListener('click', () => tentar(sair));
  $('btn-copiar-credenciais').addEventListener('click', async () => aviso((await copiar(textoCredenciais())) ? 'Dados de acesso copiados.' : 'Copie os dados manualmente.'));
  $('btn-fechar-credenciais').addEventListener('click', () => {
    $('caixa-credenciais').hidden = true;
    $('lista-credenciais').replaceChildren();
    estado.credenciais = [];
  });

  await tentar(async () => {
    estado.eu = await api('GET', '/api/admin/me');
    $('adminEmail').textContent = estado.eu.email;
    $('adminChip').hidden = false;
    $('link-dashboard').hidden = !geral();
    $('aviso-criador').hidden = geral();
    $('conta-email').textContent = estado.eu.email;
    $('conta-usuario').value = estado.eu.email;
    $('texto-intro').textContent = geral()
      ? 'Crie eventos e defina quem administra cada um. Os responsáveis têm autonomia sobre os seus eventos: cadastram grupos, jurados, coreografias e outros responsáveis.'
      : 'Crie seus eventos e defina quem administra com você. Grupos, jurados e coreografias são cadastrados na tela de cada evento.';
    if (geral()) linhaResponsavel(false); // geral: já abre uma linha para o responsável
    await carregarEventos();
    irParaAncora();
    addEventListener('hashchange', irParaAncora);
  });
}

/* #novo abre o formulário; #evento-<id> destaca o cartão (links do painel e da tela do evento) */
function irParaAncora() {
  const alvo = location.hash.slice(1);
  if (alvo === 'novo') {
    $('det-novo').open = true;
    $('novo').scrollIntoView({ behavior: 'smooth' });
  } else if (alvo.startsWith('evento-')) destacar(alvo.slice(7));
}

iniciar();
