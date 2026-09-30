// Painel de controle (nível "geral"): visão geral do sistema e gerenciamento de contas.
// Cadastros operacionais ficam fora daqui:
//   • eventos e responsáveis  → /admin/eventos/
//   • grupos, jurados, coreografias, notas, áudios → tela de cada evento (/admin/evento/?id=…)

import {
  $, api, aviso, tentar, el, icone, botao, selo, vazio, fmtHora, fmtData, situacaoEvento, situacaoConta,
  copiar, mostrarSenha, ligarCaixaSenha, guardar, ler, trocarMinhaSenha, sair, painelAuditoria,
} from './comum.js';

const CHAVE_SECAO = 'udx-festival.admin.secao';
const estado = { eu: null, secao: 'geral', jurados: [], grupos: [] };
const urlEvento = (id) => `/admin/evento/?id=${encodeURIComponent(id)}`;
const fmtBytes = (b) => (b >= 1073741824 ? `${(b / 1073741824).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} GB`
  : b >= 1048576 ? `${(b / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.round((b || 0) / 1024)} KB`);

/* ------------------------------ navegação ------------------------------ */

// Auditoria de contas e acessos: só consulta o banco na 1ª abertura da aba (depois, em "Atualizar")
const auditoria = painelAuditoria({ tbody: 'tb-auditoria', mais: 'btn-mais-auditoria', info: 'auditoria-info', evento: () => null });

const CARREGAR_SECAO = {
  geral: carregarVisaoGeral,
  admins: carregarAdmins,
  jurados: carregarJurados,
  grupos: carregarGrupos,
  auditoria: async () => { if (!auditoria.carregado) await auditoria.carregar(); },
  conta: async () => {},
};

function trocarSecao(nome) {
  if (!CARREGAR_SECAO[nome]) nome = 'geral';
  estado.secao = nome;
  guardar(CHAVE_SECAO, nome);
  for (const b of document.querySelectorAll('[data-secao]')) b.classList.toggle('is-active', b.dataset.secao === nome);
  for (const s of document.querySelectorAll('main > .secao')) s.hidden = s.id !== `secao-${nome}`;
  return tentar(CARREGAR_SECAO[nome]);
}

/* ================================ VISÃO GERAL ================================ */

const indicador = (valor, rotulo, extra) =>
  el('div', { class: 'indicador' }, el('span', { class: 'indicador-valor', textContent: valor }), el('span', { class: 'indicador-rotulo', textContent: rotulo }),
    extra ? el('span', { class: 'indicador-extra muted', textContent: extra }) : null);

async function carregarVisaoGeral() {
  const [r, eventos] = await Promise.all([api('GET', '/api/admin/resumo'), api('GET', '/api/admin/eventos')]);
  $('indicadores').replaceChildren(
    indicador(r.eventos, 'Eventos', `${r.eventos_abertos} aberto(s) · ${r.eventos_em_breve} em breve · ${r.eventos_encerrados} encerrado(s)`),
    indicador(r.responsaveis, 'Responsáveis', `${r.admins_gerais} administrador(es) geral(is)`),
    indicador(r.jurados_ativos, 'Jurados ativos', `${r.jurados} conta(s) no total`),
    indicador(r.grupos, 'Grupos / escolas', `${r.coreografias} coreografia(s)`),
    indicador(r.notas, 'Notas lançadas'),
    indicador(r.audios, 'Áudios completos', r.audios_parciais ? `${r.audios_parciais} chegando/parcial(is)` : null),
    indicador(fmtBytes(r.bytes_audios), 'Armazenamento de áudio', 'R2 gratuito: 10 GB'),
    indicador(r.contas_bloqueadas, 'Contas bloqueadas agora', 'após 5 senhas erradas (15 min)'),
  );

  const alertas = [];
  if (r.eventos_sem_responsavel) alertas.push(`${r.eventos_sem_responsavel} evento(s) sem responsável: defina em "Eventos e responsáveis".`);
  if (r.grupos_sem_evento) alertas.push(`${r.grupos_sem_evento} grupo(s) sem evento (vindos da versão anterior): revise na aba Grupos.`);
  if (r.contas_bloqueadas) alertas.push(`${r.contas_bloqueadas} conta(s) bloqueada(s) por senha errada: "Nova senha" desbloqueia.`);
  if (r.bytes_audios > 8 * 1073741824) alertas.push('O armazenamento de áudio passou de 8 GB (cota gratuita do R2: 10 GB).');
  $('alertas-controle').hidden = !alertas.length;
  $('alertas-controle').replaceChildren(...alertas.map((t) => el('p', {}, icone('alert-outline'), ` ${t}`)));

  $('tb-eventos').replaceChildren(
    ...(eventos.length
      ? eventos.map((e) => {
          const sit = situacaoEvento(e);
          const esperadas = e.n_coreografias * e.n_jurados;
          const pct = esperadas ? Math.round((e.n_notas / esperadas) * 100) : 0;
          return el('tr', {},
            el('td', {}, el('strong', { textContent: e.nome }), el('div', { class: 'muted', textContent: `${fmtData(e.data)}${e.local ? ` · ${e.local}` : ''}` })),
            el('td', {}, selo(sit.classe, sit.texto)),
            el('td', {}, e.responsaveis_lista.length
              ? e.responsaveis_lista.map((p) => el('div', { textContent: p.nome, title: p.email }))
              : selo('bloqueado', 'sem responsável')),
            el('td', { textContent: e.n_coreografias }),
            el('td', { textContent: e.n_grupos }),
            el('td', { textContent: e.n_jurados }),
            el('td', {}, el('div', { textContent: `${pct}%` }), el('div', { class: 'barra-progresso mini' }, el('span', { style: { width: `${pct}%` } }))),
            el('td', {}, el('div', { textContent: e.n_gravacoes }), el('div', { class: 'muted', textContent: fmtBytes(e.bytes_audios) })),
            el('td', { class: 'acoes' },
              el('a', { class: 'btn btn-hot', href: urlEvento(e.id) }, icone('open-in-app'), ' Abrir'),
              el('a', { class: 'btn btn-sec', href: `/admin/eventos/#evento-${e.id}` }, icone('account-tie'), ' Responsáveis'),
              botao('Link dos jurados', 'link-variant', async () => {
                const link = `${location.origin}/?evento=${e.id}`;
                aviso((await copiar(link)) ? `Link do app copiado: ${link}` : `Link do app: ${link}`);
              }),
            ),
          );
        })
      : [vazio(9, 'Nenhum evento ainda. Crie o primeiro em "Eventos e responsáveis".')]),
  );
}

/* ================================ ADMINISTRADORES ================================ */

async function carregarAdmins() {
  const admins = await api('GET', '/api/admin/admins');
  $('c-admins').textContent = admins.length;
  $('tb-admins').replaceChildren(
    ...admins.map((a) => {
      const souEu = a.id === estado.eu?.id;
      const geral = a.nivel === 'geral';
      return el('tr', {},
        el('td', {}, a.nome, souEu ? el('span', { class: 'muted', textContent: ' (você)' }) : null),
        el('td', { class: 'ident', textContent: a.email }),
        el('td', {},
          selo(geral ? 'aprovada' : 'provisoria', geral ? 'Geral' : 'Responsável de evento'),
          !geral ? el('div', { class: 'muted', textContent: a.eventos || 'Nenhum evento ligado' }) : null,
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
  const r = await api('POST', '/api/admin/admins', { json: { nome: f.get('nome'), email: f.get('email'), nivel: 'geral' } });
  e.target.reset();
  mostrarSenha(`Senha provisória de ${r.nome} (${r.email}) · acesso: ${location.origin}/admin-login/`, r.senha_provisoria);
  await carregarAdmins();
}

async function mudarNivel(a, nivel) {
  const texto = nivel === 'geral' ? 'passará a acessar o painel de controle e TODOS os eventos' : 'passará a acessar só os eventos ligados a ele';
  if (!confirm(`${a.nome} ${texto}. Confirmar?`)) return;
  await api('PATCH', `/api/admin/admins/${a.id}`, { json: { nivel } });
  aviso(`Nível de ${a.nome} alterado.`);
  await carregarAdmins();
}

async function ativarAdmin(a, ativo) {
  if (!ativo && !confirm(`Desativar ${a.nome}? O acesso é cortado na hora.`)) return;
  await api('PATCH', `/api/admin/admins/${a.id}`, { json: { ativo } });
  aviso(`${a.nome} ${ativo ? 'reativado' : 'desativado'}.`);
  await carregarAdmins();
}

async function redefinirSenha(tipo, conta) {
  if (!confirm(`Gerar nova senha provisória para ${conta.nome}? A senha atual deixa de valer e as sessões abertas são encerradas.`)) return;
  const r = await api('POST', `/api/admin/${tipo}/${conta.id}/redefinir-senha`);
  mostrarSenha(`Nova senha provisória de ${conta.nome} (${r.email})`, r.senha_provisoria);
  await (tipo === 'jurados' ? carregarJurados() : carregarAdmins());
}

/* ================================ JURADOS (controle das contas) ================================ */

async function carregarJurados() {
  estado.jurados = await api('GET', '/api/admin/jurados');
  $('c-jurados-total').textContent = estado.jurados.length;
  renderizarJurados();
}

function renderizarJurados() {
  const q = $('busca-jurados').value.trim().toLowerCase();
  const lista = estado.jurados.filter((j) => !q || `${j.nome} ${j.email}`.toLowerCase().includes(q));
  $('tb-jurados').replaceChildren(
    ...(lista.length
      ? lista.map((j) =>
          el('tr', {},
            el('td', { textContent: j.nome }),
            el('td', { class: 'ident', textContent: j.email }),
            el('td', { textContent: j.telefone || '—' }),
            el('td', { textContent: j.eventos }),
            el('td', {}, situacaoConta(j), el('div', { class: 'muted', textContent: j.ultimo_acesso ? `Último acesso: ${fmtHora(j.ultimo_acesso)}` : 'Nunca acessou' })),
            el('td', { class: 'acoes' },
              botao('Nova senha', 'lock-reset', () => redefinirSenha('jurados', j)),
              j.ativo
                ? botao('Desativar conta', 'account-off', () => ativarJurado(j, false), 'btn btn-sec btn-perigo')
                : botao('Reativar conta', 'account-check', () => ativarJurado(j, true)),
            ),
          ),
        )
      : [vazio(6, estado.jurados.length ? 'Nenhum jurado com essa busca.' : 'Nenhum jurado cadastrado ainda (o cadastro é feito na tela de cada evento).')]),
  );
}

async function ativarJurado(j, ativo) {
  if (!ativo && !confirm(`Desativar a conta de ${j.nome}? Ele perde o acesso a TODOS os eventos na hora.`)) return;
  await api('PATCH', `/api/admin/jurados/${j.id}`, { json: { ativo } });
  aviso(`Conta de ${j.nome} ${ativo ? 'reativada' : 'desativada'}.`);
  await carregarJurados();
}

/* ================================ GRUPOS (visão de todos os eventos) ================================ */

const nomesDe = (texto) => (texto ? texto.split('\n').filter(Boolean) : []);

function linhaEquipe(rotulo, texto) {
  const nomes = nomesDe(texto);
  return nomes.length ? el('div', {}, el('span', { class: 'rotulo-equipe', textContent: `${rotulo}: ` }), nomes.join(', ')) : null;
}


async function carregarGrupos() {
  estado.grupos = await api('GET', '/api/admin/grupos');
  $('c-grupos').textContent = estado.grupos.length;
  renderizarGrupos();
}

function renderizarGrupos() {
  const q = $('busca-grupos').value.trim().toLowerCase();
  const lista = estado.grupos.filter((g) => !q || `${g.nome} ${g.cidade || ''} ${g.evento || ''}`.toLowerCase().includes(q));
  $('tb-grupos').replaceChildren(
    ...(lista.length
      ? lista.map((g) =>
          el('tr', {},
            el('td', {}, el('strong', { textContent: g.nome }), el('div', { class: 'muted', textContent: [g.cidade, g.responsavel && `Resp.: ${g.responsavel}`].filter(Boolean).join(' · ') })),
            el('td', {}, g.evento_id ? el('a', { class: 'link-udx', href: urlEvento(g.evento_id), textContent: g.evento }) : selo('bloqueado', 'sem evento')),
            el('td', { class: 'equipe' },
              linhaEquipe('Direção', g.diretores), linhaEquipe('Coordenação', g.coordenadores),
              !g.diretores && !g.coordenadores ? el('span', { class: 'muted', textContent: '—' }) : null,
            ),
            el('td', { textContent: g.coreografias }),
            el('td', { class: 'acoes' },
              !g.evento_id && !g.coreografias ? botao('Excluir', 'delete-outline', () => excluirGrupo(g), 'btn btn-sec btn-perigo') : null,
              g.evento_id ? el('a', { class: 'btn btn-sec', href: `${urlEvento(g.evento_id)}#grupos` }, icone('open-in-app'), ' No evento') : null,
            ),
          ),
        )
      : [vazio(5, estado.grupos.length ? 'Nenhum grupo com essa busca.' : 'Nenhum grupo cadastrado ainda.')]),
  );
}

async function excluirGrupo(g) {
  if (!confirm(`Excluir o grupo "${g.nome}" (sem evento)?`)) return;
  await api('DELETE', `/api/admin/grupos/${g.id}`);
  aviso('Grupo excluído.');
  await carregarGrupos();
}

/* ================================ INÍCIO ================================ */

async function iniciar() {
  document.querySelectorAll('[data-secao]').forEach((b) => b.addEventListener('click', () => trocarSecao(b.dataset.secao)));
  $('btn-atualizar').addEventListener('click', () => trocarSecao(estado.secao));
  $('btn-atualizar-auditoria').addEventListener('click', () => tentar(() => auditoria.carregar()));
  $('btn-mais-auditoria').addEventListener('click', () => tentar(() => auditoria.carregar(false)));
  $('form-admin').addEventListener('submit', (e) => tentar(() => criarAdmin(e)));
  $('busca-jurados').addEventListener('input', renderizarJurados);
  $('busca-grupos').addEventListener('input', renderizarGrupos);
  $('form-conta-senha').addEventListener('submit', (e) => tentar(() => trocarMinhaSenha(e)));
  $('btnSair').addEventListener('click', () => tentar(sair));
  ligarCaixaSenha();

  await tentar(async () => {
    estado.eu = await api('GET', '/api/admin/me');
    if (estado.eu.nivel !== 'geral') {
      location.replace('/admin/eventos/'); // responsável de evento: os seus eventos
      return;
    }
    $('adminEmail').textContent = estado.eu.email;
    $('adminChip').hidden = false;
    $('conta-nome').textContent = estado.eu.nome;
    $('conta-email').textContent = estado.eu.email;
    $('conta-usuario').value = estado.eu.email;
    await trocarSecao(ler(CHAVE_SECAO) || 'geral');
  });
}

iniciar();
