// Dashboard da organização (nível "geral"): eventos, jurados, grupos, administradores, conta e auditoria.
// Cada evento abre na sua tela exclusiva (/admin/evento/?id=…), a mesma usada pelos responsáveis do evento.

import {
  $, api, aviso, tentar, el, icone, botao, selo, vazio, fmtHora, fmtData, comFuso, situacaoEvento, situacaoConta,
  copiar, mostrarSenha, ligarCaixaSenha, guardar, ler, trocarMinhaSenha, sair,
} from './comum.js';

const CHAVE_SECAO = 'udx-festival.admin.secao';
const estado = { eu: null, secao: 'eventos', jurados: [], grupos: [] };

/* ------------------------------ navegação ------------------------------ */

const CARREGAR_SECAO = {
  eventos: carregarEventos,
  jurados: carregarJurados,
  grupos: carregarGrupos,
  admins: carregarAdmins,
  conta: async () => {},
  auditoria: carregarAuditoriaGeral,
};

function trocarSecao(nome) {
  if (!CARREGAR_SECAO[nome]) nome = 'eventos';
  estado.secao = nome;
  guardar(CHAVE_SECAO, nome);
  for (const b of document.querySelectorAll('[data-secao]')) b.classList.toggle('is-active', b.dataset.secao === nome);
  for (const s of document.querySelectorAll('main > .secao')) s.hidden = s.id !== `secao-${nome}`;
  return tentar(CARREGAR_SECAO[nome]);
}

/* ================================ EVENTOS ================================ */

const urlEvento = (id) => `/admin/evento/?id=${encodeURIComponent(id)}`;

async function carregarEventos() {
  const eventos = await api('GET', '/api/admin/eventos');
  $('c-eventos').textContent = eventos.length;
  if (!eventos.length) {
    $('grade-eventos').replaceChildren(el('p', { class: 'card muted', textContent: 'Nenhum evento criado. Use "Novo evento" acima.' }));
    return;
  }
  $('grade-eventos').replaceChildren(
    ...eventos.map((e) => {
      const sit = situacaoEvento(e);
      const esperadas = e.n_coreografias * e.n_jurados;
      const pct = esperadas ? Math.round((e.n_notas / esperadas) * 100) : 0;
      return el('article', { class: 'card cartao-evento' },
        el('div', { class: 'cartao-evento-topo' },
          el('span', { class: 'cartao-evento-data', textContent: fmtData(e.data) }),
          selo(sit.classe, sit.texto),
        ),
        el('h2', { textContent: e.nome }),
        el('p', { class: 'muted', textContent: e.local || 'Local a definir' }),
        el('dl', { class: 'numeros-evento' },
          el('div', {}, el('dt', { textContent: 'Coreografias' }), el('dd', { textContent: e.n_coreografias })),
          el('div', {}, el('dt', { textContent: 'Jurados' }), el('dd', { textContent: e.n_jurados })),
          el('div', {}, el('dt', { textContent: 'Áudios' }), el('dd', { textContent: e.n_gravacoes })),
          el('div', {}, el('dt', { textContent: 'Notas' }), el('dd', { textContent: `${pct}%` })),
        ),
        el('div', { class: 'barra-progresso', title: `${e.n_notas} de ${esperadas} notas lançadas` }, el('span', { style: { width: `${pct}%` } })),
        el('p', { class: 'muted cartao-evento-resp' }, icone('account-tie'), ` ${e.responsaveis || 'Sem responsável definido'}`),
        el('div', { class: 'linha' },
          el('a', { class: 'btn btn-hot', href: urlEvento(e.id) }, icone('open-in-app'), ' Abrir tela do evento'),
          botao('Link dos jurados', 'link-variant', async () => {
            const link = `${location.origin}/?evento=${e.id}`;
            aviso((await copiar(link)) ? `Link do app copiado: ${link}` : `Link do app: ${link}`);
          }),
        ),
      );
    }),
  );
}

async function criarEvento(e) {
  e.preventDefault();
  const f = new FormData(e.target);
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
    },
  });
  location.href = urlEvento(r.id); // segue para a tela do evento: escala, coreografias, responsáveis
}

/* ================================ JURADOS ================================ */

async function carregarJurados({ silencioso = false } = {}) {
  estado.jurados = await api('GET', '/api/admin/jurados');
  $('c-jurados-total').textContent = estado.jurados.length;
  if (silencioso && estado.secao !== 'jurados') return;
  $('tb-jurados').replaceChildren(
    ...(estado.jurados.length
      ? estado.jurados.map((j) =>
          el('tr', {},
            el('td', { textContent: j.nome }),
            el('td', { class: 'ident', textContent: j.email }),
            el('td', { textContent: j.telefone || '—' }),
            el('td', { textContent: j.eventos }),
            el('td', {}, situacaoConta(j), el('div', { class: 'muted', textContent: j.ultimo_acesso ? `Último acesso: ${fmtHora(j.ultimo_acesso)}` : 'Nunca acessou' })),
            el('td', { class: 'acoes' },
              botao('Editar', 'pencil', () => editarJurado(j)),
              botao('Nova senha', 'lock-reset', () => redefinirSenha('jurados', j)),
              j.ativo
                ? botao('Desativar', 'account-off', () => ativarJurado(j, false), 'btn btn-sec btn-perigo')
                : botao('Reativar', 'account-check', () => ativarJurado(j, true)),
            ),
          ),
        )
      : [vazio(6, 'Nenhum jurado cadastrado.')]),
  );
}

async function criarJurado(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api('POST', '/api/admin/jurados', { json: { nome: f.get('nome'), email: f.get('email'), telefone: f.get('telefone') } });
  e.target.reset();
  mostrarSenha(`Senha provisória de ${r.nome} (${r.email}) · app: ${r.link}`, r.senha_provisoria);
  aviso(`${r.nome} cadastrado. Escale-o na tela do evento → aba Jurados.`);
  await carregarJurados();
}

async function editarJurado(j) {
  const nome = prompt('Nome do jurado:', j.nome);
  if (nome == null) return;
  const telefone = prompt('Telefone (deixe vazio para remover):', j.telefone || '');
  if (telefone == null) return;
  await api('PATCH', `/api/admin/jurados/${j.id}`, { json: { nome, telefone } });
  aviso('Jurado atualizado.');
  await carregarJurados();
}

async function ativarJurado(j, ativo) {
  if (!ativo && !confirm(`Desativar a conta de ${j.nome}? Ele perde o acesso a todos os eventos na hora.`)) return;
  await api('PATCH', `/api/admin/jurados/${j.id}`, { json: { ativo } });
  aviso(`Conta de ${j.nome} ${ativo ? 'reativada' : 'desativada'}.`);
  await carregarJurados();
}

async function redefinirSenha(tipo, conta) {
  if (!confirm(`Gerar nova senha provisória para ${conta.nome}? A senha atual deixa de valer e as sessões abertas são encerradas.`)) return;
  const r = await api('POST', `/api/admin/${tipo}/${conta.id}/redefinir-senha`);
  mostrarSenha(`Nova senha provisória de ${conta.nome} (${r.email})`, r.senha_provisoria);
  await (tipo === 'jurados' ? carregarJurados() : carregarAdmins());
}

/* ================================ GRUPOS ================================ */

async function carregarGrupos({ silencioso = false } = {}) {
  estado.grupos = await api('GET', '/api/admin/grupos');
  $('c-grupos').textContent = estado.grupos.length;
  if (silencioso && estado.secao !== 'grupos') return;
  $('tb-grupos').replaceChildren(
    ...(estado.grupos.length
      ? estado.grupos.map((g) =>
          el('tr', {},
            el('td', {},
              el('strong', { textContent: g.nome }),
              el('div', { class: 'muted', textContent: [g.cidade, g.responsavel && `Resp.: ${g.responsavel}`].filter(Boolean).join(' · ') }),
            ),
            el('td', { class: 'equipe' },
              linhaEquipe('Coreógrafo(a)/prof.', g.coreografo),
              linhaEquipe('Direção', g.diretores),
              linhaEquipe('Coordenação', g.coordenadores),
              !g.coreografo && !g.diretores && !g.coordenadores ? el('span', { class: 'muted', textContent: '—' }) : null,
            ),
            el('td', {}, listaIntegrantes(g.integrantes)),
            el('td', {}, el('div', { class: 'ident', textContent: g.email || '' }), el('div', { textContent: g.telefone || '' })),
            el('td', { textContent: g.coreografias }),
            el('td', { class: 'acoes' },
              botao('Editar', 'pencil', () => editarGrupo(g)),
              g.coreografias ? null : botao('Excluir', 'delete-outline', () => excluirGrupo(g), 'btn btn-sec btn-perigo'),
            ),
          ),
        )
      : [vazio(6, 'Nenhum grupo cadastrado. Eles também são criados ao importar o CSV de coreografias.')]),
  );
}

const CAMPOS_GRUPO = ['nome', 'cidade', 'responsavel', 'email', 'telefone', 'integrantes', 'coreografo', 'diretores', 'coordenadores'];
const nomesDe = (texto) => (texto ? texto.split('\n').filter(Boolean) : []);

function linhaEquipe(rotulo, texto) {
  const nomes = nomesDe(texto);
  return nomes.length ? el('div', {}, el('span', { class: 'rotulo-equipe', textContent: `${rotulo}: ` }), nomes.join(', ')) : null;
}

function listaIntegrantes(texto) {
  const nomes = nomesDe(texto);
  if (!nomes.length) return el('span', { class: 'muted', textContent: '—' });
  return el('details', { class: 'integrantes' },
    el('summary', { textContent: `${nomes.length} integrante${nomes.length > 1 ? 's' : ''}` }),
    el('ol', {}, ...nomes.map((n) => el('li', { textContent: n }))),
  );
}

function editarGrupo(g) {
  const f = $('form-grupo');
  for (const k of ['id', ...CAMPOS_GRUPO]) f[k].value = g[k] || '';
  $('btn-salvar-grupo').replaceChildren(icone('content-save-outline'), ' Salvar alterações');
  $('btn-cancelar-grupo').hidden = false;
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
  else await api('POST', '/api/admin/grupos', { json: dados });
  aviso(`Grupo "${dados.nome}" ${id ? 'atualizado' : 'cadastrado'}.`);
  cancelarGrupo();
  await carregarGrupos();
}

async function excluirGrupo(g) {
  if (!confirm(`Excluir o grupo "${g.nome}"?`)) return;
  await api('DELETE', `/api/admin/grupos/${g.id}`);
  aviso('Grupo excluído.');
  await carregarGrupos();
}

/* ================================ ADMINS ================================ */

async function carregarAdmins() {
  const admins = await api('GET', '/api/admin/admins');
  $('tb-admins').replaceChildren(
    ...admins.map((a) => {
      const souEu = a.id === estado.eu?.id;
      const geral = a.nivel === 'geral';
      return el('tr', {},
        el('td', {}, a.nome, souEu ? el('span', { class: 'muted', textContent: ' (você)' }) : null),
        el('td', { class: 'ident', textContent: a.email }),
        el('td', {},
          selo(geral ? 'aprovada' : 'provisoria', geral ? 'Geral' : 'Responsável de evento'),
          !geral ? el('div', { class: 'muted', textContent: a.eventos || 'Nenhum evento ligado ainda' }) : null,
        ),
        el('td', { textContent: fmtHora(a.ultimo_acesso) }),
        el('td', {}, situacaoConta(a)),
        el('td', { class: 'acoes' },
          ...(souEu
            ? [botao('Minha conta', 'account-cog', () => trocarSecao('conta'))]
            : [
                botao('Nova senha', 'lock-reset', () => redefinirSenha('admins', a)),
                botao(geral ? 'Tornar responsável' : 'Tornar geral', geral ? 'account-arrow-down' : 'account-arrow-up', () => mudarNivel(a, geral ? 'responsavel' : 'geral')),
                a.ativo
                  ? botao('Desativar', 'shield-off-outline', () => ativarAdmin(a, false), 'btn btn-sec btn-perigo')
                  : botao('Reativar', 'shield-check-outline', () => ativarAdmin(a, true)),
              ]),
        ),
      );
    }),
  );
}

async function criarAdmin(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api('POST', '/api/admin/admins', { json: { nome: f.get('nome'), email: f.get('email'), nivel: f.get('nivel') } });
  e.target.reset();
  const extra = r.nivel === 'responsavel' ? ' Ligue-o a um evento na tela do evento → Responsáveis.' : '';
  mostrarSenha(`Senha provisória de ${r.nome} (${r.email}) · acesso: ${location.origin}/admin-login/.${extra}`, r.senha_provisoria);
  await carregarAdmins();
}

async function mudarNivel(a, nivel) {
  const texto = nivel === 'geral' ? 'passará a acessar TODO o festival' : 'passará a acessar só os eventos ligados a ele';
  if (!confirm(`${a.nome} ${texto}. Confirmar?`)) return;
  await api('PATCH', `/api/admin/admins/${a.id}`, { json: { nivel } });
  aviso(`Nível de ${a.nome} alterado.`);
  await carregarAdmins();
}

async function ativarAdmin(a, ativo) {
  if (!ativo && !confirm(`Desativar o administrador ${a.nome}? O acesso é cortado na hora.`)) return;
  await api('PATCH', `/api/admin/admins/${a.id}`, { json: { ativo } });
  aviso(`Administrador ${a.nome} ${ativo ? 'reativado' : 'desativado'}.`);
  await carregarAdmins();
}

/* ================================ AUDITORIA ================================ */

async function carregarAuditoriaGeral() {
  const linhas = await api('GET', '/api/admin/auditoria');
  $('tb-auditoria').replaceChildren(
    ...(linhas.length
      ? linhas.map((l) =>
          el('tr', {},
            el('td', { textContent: fmtHora(l.criado_em) }),
            el('td', { class: 'ident', textContent: l.ator }),
            el('td', { textContent: l.acao }),
            el('td', { class: 'ident', textContent: l.alvo || '' }),
            el('td', { class: 'ident', textContent: l.ip || '' }),
          ),
        )
      : [vazio(5, 'Nenhum registro.')]),
  );
}

/* ================================ INÍCIO ================================ */

async function iniciar() {
  document.querySelectorAll('[data-secao]').forEach((b) => b.addEventListener('click', () => trocarSecao(b.dataset.secao)));
  $('form-evento').addEventListener('submit', (e) => tentar(() => criarEvento(e)));
  $('btn-atualizar').addEventListener('click', () => tentar(carregarEventos));
  $('form-jurado').addEventListener('submit', (e) => tentar(() => criarJurado(e)));
  $('form-grupo').addEventListener('submit', (e) => tentar(() => salvarGrupo(e)));
  $('btn-cancelar-grupo').addEventListener('click', cancelarGrupo);
  $('form-admin').addEventListener('submit', (e) => tentar(() => criarAdmin(e)));
  $('form-conta-senha').addEventListener('submit', (e) => tentar(() => trocarMinhaSenha(e)));
  $('btnSair').addEventListener('click', () => tentar(sair));
  ligarCaixaSenha();

  await tentar(async () => {
    estado.eu = await api('GET', '/api/admin/me');
    if (estado.eu.nivel !== 'geral') {
      location.replace('/admin/evento/'); // responsável de evento: só a tela do evento
      return;
    }
    $('adminEmail').textContent = estado.eu.email;
    $('adminChip').hidden = false;
    $('conta-nome').textContent = estado.eu.nome;
    $('conta-email').textContent = estado.eu.email;
    $('conta-usuario').value = estado.eu.email;
    await Promise.all([carregarJurados({ silencioso: true }), carregarGrupos({ silencioso: true })]);
    await trocarSecao(ler(CHAVE_SECAO) || 'eventos');
  });
}

iniciar();
