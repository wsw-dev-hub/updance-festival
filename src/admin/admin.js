// Área de admin do UpDance Festival (sistema independente).
// Sessão de administrador: cookie HttpOnly a_session (KV), validado no servidor.

const $ = (id) => document.getElementById(id);
const num = (n) => String(n).padStart(3, '0');
const CHAVE_EVENTO = 'udx-festival.admin.evento';
const CHAVE_SECAO = 'udx-festival.admin.secao';
const FUSO_MS = 3 * 3600_000; // America/Sao_Paulo (UTC-3, sem horário de verão)

const estado = {
  eu: null,
  eventos: [],
  eventoId: null,
  evento: null,
  escalados: [],
  jurados: [],
  grupos: [],
  secao: 'eventos',
  aba: 'gravacoes',
  timer: null,
  editandoEvento: false,
};

/* ------------------------------ utilidades ------------------------------ */

async function api(metodo, caminho, { json, texto } = {}) {
  const headers = { 'X-UDX-Festival': '1' };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (texto !== undefined) {
    headers['Content-Type'] = 'text/csv; charset=utf-8';
    body = texto;
  }
  const resp = await fetch(caminho, { method: metodo, headers, body, credentials: 'same-origin', cache: 'no-store' });
  const dados = await resp.json().catch(() => ({}));
  if (resp.status === 401 || (resp.status === 403 && dados.codigo === 'trocar_senha')) {
    location.href = `/admin-login/?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('Sessão encerrada. Redirecionando para o login…');
  }
  if (!resp.ok) throw new Error(dados.erro || `Erro ${resp.status}`);
  return dados;
}

function aviso(texto, erro = false) {
  $('mensagem').textContent = texto;
  $('mensagem').className = `mensagem${erro ? ' erro' : ''}`;
}

async function tentar(fn) {
  try {
    await fn();
  } catch (e) {
    aviso(e.message, true);
  }
}

function el(tag, props = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e[k] = v;
  }
  e.append(...filhos.filter((f) => f != null && f !== false));
  return e;
}

const icone = (nome) => el('i', { class: `mdi mdi-${nome}` });
const botao = (rotulo, nomeIcone, onclick, classe = 'btn btn-sec') =>
  el('button', { class: classe, type: 'button', onclick: () => tentar(onclick) }, icone(nomeIcone), ` ${rotulo}`);
const selo = (classe, texto) => el('span', { class: `st ${classe}`, textContent: texto });
const vazio = (colunas, texto) => el('tr', {}, el('td', { colSpan: colunas, class: 'muted', textContent: texto }));
const fmtDuracao = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtHora = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—');
const fmtData = (d) => d.split('-').reverse().join('/');
/** ms → valor de <input type="datetime-local"> no horário de Brasília */
const paraCampo = (ms) => (ms ? new Date(ms - FUSO_MS).toISOString().slice(0, 16) : '');
const comFuso = (v) => (v ? `${v}:00-03:00` : undefined);

function situacaoConta(c) {
  if (!c.ativo) return selo('inativo', 'Desativada');
  if (c.bloqueado_ate && c.bloqueado_ate > Date.now()) return selo('bloqueado', 'Bloqueada (tentativas)');
  if (c.trocar_senha) return selo('provisoria', 'Senha provisória');
  return selo('completo', 'Ativa');
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    return false;
  }
}

function mostrarSenha(titulo, senha) {
  $('caixa-senha-titulo').textContent = titulo;
  $('caixa-senha-valor').textContent = senha;
  $('caixa-senha').hidden = false;
  $('caixa-senha').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function guardar(chave, valor) {
  try { localStorage.setItem(chave, valor); } catch { /* armazenamento indisponível */ }
}
function ler(chave) {
  try { return localStorage.getItem(chave); } catch { return null; }
}

/* ------------------------------ navegação ------------------------------ */

const CARREGAR_SECAO = {
  eventos: () => (estado.eventoId ? abrirEvento(estado.eventoId) : carregarEventos()),
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
  if (nome !== 'eventos') clearInterval(estado.timer);
  return tentar(CARREGAR_SECAO[nome]);
}

function trocarAba(nome) {
  estado.aba = nome;
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('is-active', b.dataset.tab === nome);
  for (const p of document.querySelectorAll('#conteudo-evento .panel')) p.hidden = p.id !== `panel-${nome}`;
  if (nome === 'auditoria-evento' && estado.eventoId) tentar(carregarAuditoriaEvento);
}

/* ================================ EVENTOS ================================ */

async function carregarEventos(selecionar) {
  estado.eventos = await api('GET', '/api/admin/eventos');
  $('sel-evento').replaceChildren(
    el('option', { value: '', textContent: estado.eventos.length ? 'Escolha um evento…' : 'Nenhum evento criado' }),
    ...estado.eventos.map((e) => el('option', { value: e.id, textContent: `${fmtData(e.data)} · ${e.nome}` })),
  );
  let alvo = selecionar || estado.eventoId || ler(CHAVE_EVENTO);
  if (!estado.eventos.some((e) => e.id === alvo)) alvo = estado.eventos[0]?.id; // mais recente
  if (alvo) {
    $('sel-evento').value = alvo;
    await abrirEvento(alvo);
  } else {
    await abrirEvento(null);
  }
}

function modoFormEvento(editar) {
  estado.editandoEvento = editar && !!estado.evento;
  const f = $('form-evento');
  if (estado.editandoEvento) {
    const ev = estado.evento;
    f.nome.value = ev.nome;
    f.data.value = ev.data;
    f.local.value = ev.local || '';
    f.abre_em.value = paraCampo(ev.abre_em);
    f.fecha_em.value = paraCampo(ev.fecha_em);
    f.duracao_max_min.value = Math.round((ev.duracao_max_s || 480) / 60);
    f.anonimizar_jurados.checked = !!ev.anonimizar_jurados;
    $('det-evento-titulo').textContent = `Editar: ${ev.nome}`;
    $('btn-salvar-evento').textContent = 'Salvar alterações';
    $('det-evento').open = true;
  } else {
    f.reset();
    $('det-evento-titulo').textContent = 'Novo evento';
    $('btn-salvar-evento').textContent = 'Criar evento';
  }
  $('btn-editar-evento').hidden = !estado.evento || estado.editandoEvento;
  $('btn-cancelar-evento').hidden = !estado.editandoEvento;
}

async function salvarEvento(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const dados = {
    nome: f.get('nome'),
    data: f.get('data'),
    local: f.get('local'),
    abre_em: comFuso(f.get('abre_em')),
    fecha_em: comFuso(f.get('fecha_em')),
    duracao_max_s: Number(f.get('duracao_max_min') || 8) * 60,
    anonimizar_jurados: f.get('anonimizar_jurados') === 'on',
  };
  if (estado.editandoEvento) {
    const r = await api('PATCH', `/api/admin/eventos/${estado.eventoId}`, { json: dados });
    aviso(`Evento "${r.nome}" atualizado.`);
    $('det-evento').open = false;
    await carregarEventos(estado.eventoId);
  } else {
    const r = await api('POST', '/api/admin/eventos', { json: dados });
    aviso(`Evento "${r.nome}" criado. Agora escale os jurados e cadastre as coreografias.`);
    $('det-evento').open = false;
    await carregarEventos(r.id);
  }
  modoFormEvento(false);
}

async function abrirEvento(id) {
  if (estado.editandoEvento) {
    estado.editandoEvento = false;
    $('det-evento').open = false;
  }
  estado.eventoId = id || null;
  guardar(CHAVE_EVENTO, estado.eventoId || '');
  clearInterval(estado.timer);
  $('conteudo-evento').hidden = !estado.eventoId;
  $('link-jurados').hidden = !estado.eventoId;
  if (!estado.eventoId) {
    estado.evento = null;
    modoFormEvento(false);
    return;
  }
  await Promise.all([carregarDetalhes(), carregarGravacoes(), carregarJurados({ silencioso: true }), carregarGrupos({ silencioso: true })]);
  preencherSelects();
  modoFormEvento(false);
  if (estado.aba === 'auditoria-evento') await carregarAuditoriaEvento();
  estado.timer = setInterval(() => {
    if (estado.secao === 'eventos' && !document.hidden) carregarGravacoes().catch(() => {});
  }, 10_000);
}

async function carregarDetalhes() {
  const { evento, coreografias, jurados, link_jurados } = await api('GET', `/api/admin/eventos/${estado.eventoId}`);
  estado.evento = evento;
  estado.escalados = jurados;
  $('link-jurados-url').textContent = link_jurados;
  $('c-escala').textContent = jurados.filter((j) => j.ativo).length;
  $('c-coreografias').textContent = coreografias.length;

  // Escala
  $('tb-escala').replaceChildren(
    ...(jurados.length
      ? jurados.map((j) =>
          el('tr', {},
            el('td', {}, el('span', { class: 'num', textContent: j.ordem })),
            el('td', { textContent: j.nome }),
            el('td', { class: 'ident', textContent: j.email }),
            el('td', {},
              j.ativo ? selo('completo', 'Escalado') : selo('inativo', 'Suspenso'),
              !j.conta_ativa ? el('div', {}, selo('inativo', 'Conta desativada')) : null,
            ),
            el('td', { class: 'acoes' },
              j.ativo
                ? botao('Suspender', 'account-off', () => alterarEscala(j, false), 'btn btn-sec btn-perigo')
                : botao('Reativar', 'account-check', () => alterarEscala(j, true)),
            ),
          ),
        )
      : [vazio(5, 'Nenhum jurado escalado ainda.')]),
  );

  // Coreografias
  $('tb-coreografias').replaceChildren(
    ...(coreografias.length
      ? coreografias.map((c) =>
          el('tr', {},
            el('td', {}, el('span', { class: 'num', textContent: num(c.numero) })),
            el('td', { textContent: c.nome }),
            el('td', { textContent: c.grupo || '—' }),
            el('td', { textContent: c.categoria || '' }),
            el('td', { class: 'acoes' },
              botao('Gerar link', 'link-plus', () => gerarLink(c)),
              botao('Revogar', 'link-off', () => revogarLinks(c), 'btn btn-sec btn-perigo'),
            ),
          ),
        )
      : [vazio(5, 'Nenhuma coreografia cadastrada.')]),
  );
}

function preencherSelects() {
  const escalados = new Set(estado.escalados.map((j) => j.id));
  const livres = estado.jurados.filter((j) => j.ativo && !escalados.has(j.id));
  $('sel-jurado-escala').replaceChildren(
    el('option', { value: '', textContent: livres.length ? 'Escolha um jurado…' : estado.jurados.length ? 'Todos os jurados ativos já estão escalados' : 'Cadastre jurados na seção Jurados' }),
    ...livres.map((j) => el('option', { value: j.id, textContent: `${j.nome} · ${j.email}` })),
  );
  $('sel-grupo-coreografia').replaceChildren(
    el('option', { value: '', textContent: 'Sem grupo' }),
    ...estado.grupos.map((g) => el('option', { value: g.id, textContent: g.cidade ? `${g.nome} (${g.cidade})` : g.nome })),
  );
}

async function escalar(e) {
  e.preventDefault();
  const juradoId = $('sel-jurado-escala').value;
  if (!juradoId) return aviso('Escolha um jurado.', true);
  const r = await api('POST', `/api/admin/eventos/${estado.eventoId}/jurados`, { json: { jurado_id: juradoId } });
  const j = estado.jurados.find((x) => x.id === juradoId);
  aviso(`${j?.nome || 'Jurado'} escalado como Jurado ${r.ordem}. Envie o link do app: ele entra com o e-mail e a senha dele.`);
  await carregarDetalhes();
  preencherSelects();
}

async function alterarEscala(j, ativo) {
  if (!ativo && !confirm(`Suspender ${j.nome} neste evento? O acesso ao evento é cortado na hora (as gravações já feitas continuam).`)) return;
  await api('PATCH', `/api/admin/eventos/${estado.eventoId}/jurados/${j.id}`, { json: { ativo } });
  aviso(`${j.nome} ${ativo ? 'reativado' : 'suspenso'} neste evento.`);
  await carregarDetalhes();
}

/* ------------------------------ coreografias ------------------------------ */

async function salvarCoreografia(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  await api('POST', `/api/admin/eventos/${estado.eventoId}/coreografias`, {
    json: { numero: f.get('numero'), nome: f.get('nome'), grupo_id: f.get('grupo_id') || null, categoria: f.get('categoria') },
  });
  aviso(`Coreografia ${num(f.get('numero'))} salva.`);
  e.target.reset();
  await carregarDetalhes();
}

async function importarCsv() {
  let texto = $('csv').value.trim();
  const arquivo = $('arquivo-csv').files[0];
  if (arquivo) texto = await arquivo.text();
  if (!texto) return aviso('Cole o CSV ou escolha um arquivo.', true);
  const r = await api('POST', `/api/admin/eventos/${estado.eventoId}/coreografias`, { texto });
  aviso(`${r.importadas} coreografia(s) importada(s) · ${r.grupos} grupo(s) vinculados.`);
  $('csv').value = '';
  $('arquivo-csv').value = '';
  await Promise.all([carregarDetalhes(), carregarGrupos({ silencioso: true })]);
  preencherSelects();
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

/* ------------------------------ gravações ------------------------------ */

async function carregarGravacoes() {
  const lista = await api('GET', `/api/admin/eventos/${estado.eventoId}/gravacoes`);
  const completas = lista.filter((g) => g.status === 'completo').length;
  const aprovadas = lista.filter((g) => g.aprovada).length;
  $('c-gravacoes').textContent = lista.length;
  $('resumo-gravacoes').textContent = `${lista.length} gravações · ${completas} completas · ${aprovadas} aprovadas`;

  $('tb-gravacoes').replaceChildren(
    ...(lista.length
      ? lista.map((g) => {
          const status = g.status === 'completo'
            ? selo(g.aprovada ? 'aprovada' : 'completo', g.aprovada ? 'Aprovada' : 'Completa')
            : selo('gravando', `Em andamento · ${g.trechos} trechos`);
          const urlAudio = `/api/admin/gravacoes/${g.id}/audio`;
          return el('tr', {},
            el('td', {}, el('span', { class: 'num', textContent: num(g.numero) })),
            el('td', {},
              el('div', { textContent: `${g.coreografia}${g.versao > 1 ? ` (v${g.versao})` : ''}` }),
              g.grupo ? el('div', { class: 'muted', textContent: g.grupo }) : null,
              el('div', { class: 'ident', textContent: g.identificador }),
            ),
            el('td', { textContent: g.jurado }),
            el('td', {}, status),
            el('td', { textContent: g.duracao_ms ? fmtDuracao(g.duracao_ms) : '—' }),
            el('td', { class: 'acoes' },
              botao('Ouvir', 'play-circle-outline', () => ouvir(g, urlAudio)),
              el('a', { class: 'btn btn-sec', href: `${urlAudio}?download=1`, download: '' }, icone('download'), ' Baixar'),
              g.status === 'completo'
                ? botao(g.aprovada ? 'Retirar aprovação' : 'Aprovar', g.aprovada ? 'close-circle-outline' : 'check-decagram', () => aprovar(g, !g.aprovada), g.aprovada ? 'btn btn-sec' : 'btn btn-hot')
                : null,
            ),
          );
        })
      : [vazio(6, 'Nenhuma gravação ainda.')]),
  );
}

function ouvir(g, url) {
  const player = $('player');
  player.src = url; // cookie de admin segue junto (mesma origem); Range suportado
  player.hidden = false;
  player.play().catch(() => {});
  aviso(`Tocando: ${g.identificador}${g.status !== 'completo' ? ' (parcial, montado com os trechos recebidos)' : ''}`);
}

async function aprovar(g, aprovada) {
  await api('POST', `/api/admin/gravacoes/${g.id}/aprovar`, { json: { aprovada } });
  await carregarGravacoes();
}

/* ------------------------------ auditoria ------------------------------ */

function linhasAuditoria(linhas, ultimaColuna) {
  return linhas.length
    ? linhas.map((l) =>
        el('tr', {},
          el('td', { textContent: fmtHora(l.criado_em) }),
          el('td', { class: 'ident', textContent: l.ator }),
          el('td', { textContent: l.acao }),
          el('td', { class: 'ident', textContent: l.alvo || '' }),
          el('td', { class: 'ident', textContent: l[ultimaColuna] || '' }),
        ),
      )
    : [vazio(5, 'Nenhum registro.')];
}

async function carregarAuditoriaEvento() {
  const linhas = await api('GET', `/api/admin/auditoria?evento=${encodeURIComponent(estado.eventoId)}`);
  $('tb-auditoria-evento').replaceChildren(...linhasAuditoria(linhas, 'detalhes'));
}

async function carregarAuditoriaGeral() {
  const linhas = await api('GET', '/api/admin/auditoria');
  $('tb-auditoria').replaceChildren(...linhasAuditoria(linhas, 'ip'));
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
  aviso(`${r.nome} cadastrado. Escale-o em um evento na seção Eventos.`);
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
            el('td', { textContent: g.nome }),
            el('td', { textContent: g.cidade || '—' }),
            el('td', { textContent: g.responsavel || '—' }),
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

function editarGrupo(g) {
  const f = $('form-grupo');
  for (const k of ['id', 'nome', 'cidade', 'responsavel', 'email', 'telefone']) f[k].value = g[k] || '';
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
  const dados = Object.fromEntries(['nome', 'cidade', 'responsavel', 'email', 'telefone'].map((k) => [k, f.get(k)]));
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
      return el('tr', {},
        el('td', {}, a.nome, souEu ? el('span', { class: 'muted', textContent: ' (você)' }) : null),
        el('td', { class: 'ident', textContent: a.email }),
        el('td', { textContent: fmtHora(a.ultimo_acesso) }),
        el('td', {}, situacaoConta(a)),
        el('td', { class: 'acoes' },
          ...(souEu
            ? [botao('Minha conta', 'account-cog', () => trocarSecao('conta'))]
            : [
                botao('Nova senha', 'lock-reset', () => redefinirSenha('admins', a)),
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
  const r = await api('POST', '/api/admin/admins', { json: { nome: f.get('nome'), email: f.get('email') } });
  e.target.reset();
  mostrarSenha(`Senha provisória do administrador ${r.nome} (${r.email}) · acesso: ${location.origin}/admin-login/`, r.senha_provisoria);
  await carregarAdmins();
}

async function ativarAdmin(a, ativo) {
  if (!ativo && !confirm(`Desativar o administrador ${a.nome}? O acesso é cortado na hora.`)) return;
  await api('PATCH', `/api/admin/admins/${a.id}`, { json: { ativo } });
  aviso(`Administrador ${a.nome} ${ativo ? 'reativado' : 'desativado'}.`);
  await carregarAdmins();
}

/* ================================ CONTA ================================ */

async function trocarMinhaSenha(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get('nova') !== f.get('confirma')) return aviso('As senhas novas não conferem.', true);
  await api('POST', '/api/admin/senha', { json: { atual: f.get('atual'), nova: f.get('nova') } });
  e.target.reset();
  aviso('Senha alterada. Suas sessões em outros aparelhos foram encerradas.');
}

async function sair() {
  if (!confirm('Sair da área de admin?')) return;
  try { await api('POST', '/api/admin/logout'); } catch { /* segue para o login mesmo assim */ }
  location.href = '/admin-login/';
}

/* ================================ INÍCIO ================================ */

async function iniciar() {
  document.querySelectorAll('[data-secao]').forEach((b) => b.addEventListener('click', () => trocarSecao(b.dataset.secao)));
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.tab)));

  $('form-evento').addEventListener('submit', (e) => tentar(() => salvarEvento(e)));
  $('btn-editar-evento').addEventListener('click', () => {
    modoFormEvento(true);
    $('form-evento').nome.focus();
  });
  $('btn-cancelar-evento').addEventListener('click', () => {
    modoFormEvento(false);
    $('det-evento').open = false;
  });
  $('det-evento').addEventListener('toggle', () => { if (!$('det-evento').open && estado.editandoEvento) modoFormEvento(false); });
  $('sel-evento').addEventListener('change', (e) => tentar(() => abrirEvento(e.target.value)));
  $('btn-atualizar').addEventListener('click', () => tentar(() => carregarEventos(estado.eventoId)));
  $('btn-copiar-link').addEventListener('click', async () => aviso((await copiar($('link-jurados-url').textContent)) ? 'Link copiado.' : 'Copie o link manualmente.'));
  $('form-escala').addEventListener('submit', (e) => tentar(() => escalar(e)));
  $('form-coreografia').addEventListener('submit', (e) => tentar(() => salvarCoreografia(e)));
  $('btn-importar').addEventListener('click', () => tentar(importarCsv));

  $('form-jurado').addEventListener('submit', (e) => tentar(() => criarJurado(e)));
  $('form-grupo').addEventListener('submit', (e) => tentar(() => salvarGrupo(e)));
  $('btn-cancelar-grupo').addEventListener('click', cancelarGrupo);
  $('form-admin').addEventListener('submit', (e) => tentar(() => criarAdmin(e)));
  $('form-conta-senha').addEventListener('submit', (e) => tentar(() => trocarMinhaSenha(e)));

  $('btn-copiar-senha').addEventListener('click', async () =>
    aviso((await copiar($('caixa-senha-valor').textContent)) ? 'Senha copiada.' : 'Copie a senha manualmente.'));
  $('btn-fechar-senha').addEventListener('click', () => {
    $('caixa-senha').hidden = true;
    $('caixa-senha-valor').textContent = '';
  });
  $('btnSair').addEventListener('click', () => tentar(sair));

  await tentar(async () => {
    estado.eu = await api('GET', '/api/admin/me');
    $('adminEmail').textContent = estado.eu.email;
    $('adminChip').hidden = false;
    $('conta-nome').textContent = estado.eu.nome;
    $('conta-email').textContent = estado.eu.email;
    $('conta-usuario').value = estado.eu.email;
    // contadores das abas
    await Promise.all([carregarJurados({ silencioso: true }), carregarGrupos({ silencioso: true })]);
    await carregarEventos();
    const secao = ler(CHAVE_SECAO);
    if (secao && secao !== 'eventos') await trocarSecao(secao);
  });
}

iniciar();
