#!/usr/bin/env node
// Publica o UpDance Festival. Idempotente: pode rodar quantas vezes quiser.
// Pré-requisito: `vite build` já gerou dist/ (o `npm run cf:publicar` faz isso antes).
//
//   1. KV "updance-festival-sessoes"        → cria se não existir (sessões m_session / a_session)
//   2. Banco D1 "updance-festival_db"        → usa o database_id do wrangler.toml, ou cria se não existir
//   3. Bucket R2 "updance-festival-audios"   → cria se não existir + regras de retenção
//   4. Migrações do banco (migrations/*.sql) → aplica as pendentes
//   5. Segredos                              → ADMIN_SETUP_KEY e GMAIL_APP_PASSWORD, se informados
//   6. Publica o Worker + assets (dist/)
//
// Variáveis de ambiente:
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   credenciais (no GitHub: Secrets)
//   ADMIN_SETUP_KEY                               chave de /api/admin/setup (criar/recuperar administrador)
//   GMAIL_APP_PASSWORD                            opcional: senha de app do Gmail ("esqueci minha senha")
//   RETENCAO_AUDIOS_DIAS                          opcional: apaga áudios após N dias (padrão: nunca)

import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_ORIGEM = path.join(RAIZ, 'wrangler.toml');
const CONFIG_GERADA = path.join(RAIZ, 'wrangler.publicar.toml'); // ignorado pelo Git
const TITULO_KV = 'updance-festival-sessoes';
const NO_CI = process.env.GITHUB_ACTIONS === 'true';
const WINDOWS = process.platform === 'win32';
const e = process.env;

/* ------------------------------ utilidades ------------------------------ */

const titulo = (t) => console.log(NO_CI ? `::group::${t}` : `\n▶ ${t}`);
const fimTitulo = () => NO_CI && console.log('::endgroup::');
const aviso = (t) => console.log(NO_CI ? `::warning::${t}` : `⚠ ${t}`);

class ErroPublicacao extends Error {}
function falhar(msg) {
  throw new ErroPublicacao(msg);
}

/** Executa o wrangler. `capturar` devolve a saída; senão ela aparece no terminal. */
function wrangler(args, { capturar = false, permitirFalha = false, entrada } = {}) {
  const [cmd, ...base] = e.WRANGLER_BIN ? [e.WRANGLER_BIN] : ['npx', '--no-install', 'wrangler'];
  const r = spawnSync(cmd, [...base, ...args], {
    cwd: RAIZ,
    encoding: 'utf8',
    input: entrada,
    shell: WINDOWS,
    stdio: capturar ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: e.CI || (NO_CI ? 'true' : '') },
    maxBuffer: 20 * 1024 * 1024,
  });
  const saida = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && !permitirFalha) {
    if (capturar) console.error(saida);
    falhar(explicarErro(saida, args));
  }
  return { ok: r.status === 0, saida, stdout: r.stdout || '' };
}

function explicarErro(saida, args) {
  const s = saida.toLowerCase();
  if (s.includes('workers.dev subdomain')) {
    return 'Sua conta ainda não tem um subdomínio workers.dev. No painel da Cloudflare, abra "Workers & Pages" uma vez e escolha o subdomínio. Depois rode de novo.';
  }
  if (s.includes('enable r2') || s.includes('10042') || s.includes('purchase r2')) {
    return 'O R2 ainda não está ativado na conta. No painel da Cloudflare: R2 Object Storage → ativar o plano gratuito (pede cartão, mas não cobra dentro da cota). Depois rode de novo.';
  }
  if (s.includes('authentication error') || s.includes('10000') || s.includes('not authorized') || s.includes('9109')) {
    return 'Token da Cloudflare sem permissão. Use o modelo "Edit Cloudflare Workers" e ADICIONE "Account → D1 → Edit" (o modelo já inclui KV e R2). Veja o README.';
  }
  if (s.includes('not logged in') || s.includes('wrangler login')) {
    return 'Sem credenciais da Cloudflare. No computador: `npx wrangler login`. No GitHub: cadastre CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID nos Secrets.';
  }
  return `Falha em "wrangler ${args.join(' ')}". Veja a mensagem acima.`;
}

function extrairJson(texto) {
  const inicio = texto.search(/[[{]/);
  if (inicio < 0) return null;
  try {
    return JSON.parse(texto.slice(inicio));
  } catch {
    return null;
  }
}

function lerConfigBase() {
  const texto = readFileSync(CONFIG_ORIGEM, 'utf8');
  const valor = (chave) => texto.match(new RegExp(`^\\s*${chave}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
  const idKv = texto.match(/\[\[kv_namespaces\]\][^[]*?\bid\s*=\s*"([^"]*)"/)?.[1];
  return { texto, nomeWorker: valor('name'), nomeBanco: valor('database_name'), nomeBucket: valor('bucket_name'), idBanco: valor('database_id'), idKv };
}

/* ------------------------------ etapas ------------------------------ */

function garantirBanco(nome, idConfigurado) {
  titulo(`Banco D1 "${nome}"`);
  const lista = extrairJson(wrangler(['d1', 'list', '--json'], { capturar: true }).stdout) || [];
  let banco = lista.find((b) => b.name === nome);
  if (banco) {
    console.log(`Já existe (${banco.uuid}).`);
  } else if (idConfigurado && !/^0{8}-/.test(idConfigurado)) {
    falhar(`wrangler.toml aponta para o banco ${idConfigurado}, mas ele não foi encontrado nesta conta.`);
  } else {
    console.log('Não existe: criando…');
    wrangler(['d1', 'create', nome], { capturar: true });
    banco = (extrairJson(wrangler(['d1', 'list', '--json'], { capturar: true }).stdout) || []).find((b) => b.name === nome);
    if (!banco) falhar('O banco foi criado, mas não apareceu na listagem. Rode de novo em alguns segundos.');
    console.log(`Criado (${banco.uuid}).`);
  }
  fimTitulo();
  return banco.uuid;
}

function garantirBucket(nome) {
  titulo(`Armazenamento R2 "${nome}"`);
  const { saida } = wrangler(['r2', 'bucket', 'list'], { capturar: true });
  const existentes = [...saida.matchAll(/name:\s+(\S+)/g)].map((m) => m[1]);
  if (existentes.includes(nome)) {
    console.log('Já existe.');
  } else {
    console.log('Não existe: criando…');
    const r = wrangler(['r2', 'bucket', 'create', nome], { capturar: true, permitirFalha: true });
    if (!r.ok && !/already exists|10004/i.test(r.saida)) {
      console.error(r.saida);
      falhar(explicarErro(r.saida, ['r2', 'bucket', 'create', nome]));
    }
    console.log('Criado.');
  }

  // Retenção: trechos de backup somem em 7 dias; áudios só se RETENCAO_AUDIOS_DIAS for definido.
  const regras = [
    {
      id: 'trechos-7-dias',
      enabled: true,
      conditions: { prefix: 'trechos/' },
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: 7 * 86400 } },
    },
  ];
  const dias = Number.parseInt(e.RETENCAO_AUDIOS_DIAS || '', 10);
  if (Number.isFinite(dias) && dias > 0) {
    regras.push({
      id: `audios-${dias}-dias`,
      enabled: true,
      conditions: { prefix: 'audios/' },
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: dias * 86400 } },
    });
  }
  const pasta = mkdtempSync(path.join(os.tmpdir(), 'udx-festival-'));
  const arquivo = path.join(pasta, 'retencao.json');
  try {
    writeFileSync(arquivo, JSON.stringify({ rules: regras }));
    const r = wrangler(['r2', 'bucket', 'lifecycle', 'set', nome, '--file', arquivo, '--force'], { capturar: true, permitirFalha: true });
    if (r.ok) console.log(`Retenção: trechos 7 dias${regras.length > 1 ? `, áudios ${dias} dias` : ', áudios sem expiração'}.`);
    else aviso('Não foi possível configurar a retenção do R2 (a publicação continua). Configure no painel: R2 → bucket → Settings → Object lifecycle rules.');
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
  fimTitulo();
}

function garantirKv(idConfigurado) {
  titulo(`KV "${TITULO_KV}" (sessões)`);
  const listar = () => extrairJson(wrangler(['kv', 'namespace', 'list'], { capturar: true }).stdout) || [];
  let lista = listar();
  const configurado = idConfigurado && !/^0+$/.test(idConfigurado) ? lista.find((k) => k.id === idConfigurado) : null;
  if (idConfigurado && !/^0+$/.test(idConfigurado) && !configurado) {
    falhar(`wrangler.toml aponta para o KV ${idConfigurado}, mas ele não foi encontrado nesta conta.`);
  }
  let kv = configurado || lista.find((k) => k.title === TITULO_KV);
  if (kv) {
    console.log(`Já existe: "${kv.title}" (${kv.id}).`);
  } else {
    console.log('Não existe: criando…');
    wrangler(['kv', 'namespace', 'create', TITULO_KV], { capturar: true });
    lista = listar();
    kv = lista.find((k) => k.title === TITULO_KV || k.title.endsWith(`-${TITULO_KV}`));
    if (!kv) falhar('O KV foi criado, mas não apareceu na listagem. Rode de novo em alguns segundos.');
    console.log(`Criado (${kv.id}).`);
  }
  fimTitulo();
  return kv.id;
}

function gerarConfig(base, idBanco, idKv) {
  const t = base.texto
    .replace(/^(\s*database_id\s*=\s*)"[^"]*"/m, `$1${JSON.stringify(idBanco)}`)
    .replace(/(\[\[kv_namespaces\]\][^[]*?\bid\s*=\s*)"[^"]*"/, `$1${JSON.stringify(idKv)}`);
  writeFileSync(CONFIG_GERADA, t);
}

function aplicarMigracoes(nomeBanco) {
  titulo('Migrações do banco');
  wrangler(['d1', 'migrations', 'apply', nomeBanco, '--remote', '--config', CONFIG_GERADA]);
  fimTitulo();
}

/** Decide quais segredos enviar junto com o deploy. Nunca imprime valores. */
function prepararSegredos() {
  titulo('Segredos');
  const r = wrangler(['secret', 'list', '--config', CONFIG_GERADA, '--format', 'json'], { capturar: true, permitirFalha: true });
  // Falha aqui = Worker ainda não existe (primeiro deploy): nenhum segredo cadastrado
  const existentes = new Set(r.ok ? (extrairJson(r.stdout) || []).map((s) => s.name) : []);
  const enviar = {};

  if (e.ADMIN_SETUP_KEY) {
    enviar.ADMIN_SETUP_KEY = e.ADMIN_SETUP_KEY;
    console.log('ADMIN_SETUP_KEY: enviada.');
  } else if (existentes.has('ADMIN_SETUP_KEY')) {
    console.log('ADMIN_SETUP_KEY: já cadastrada.');
  } else {
    aviso('ADMIN_SETUP_KEY não informada: sem ela não dá para criar o primeiro administrador em /admin-login/ → "Primeiro acesso". Cadastre-a nos Secrets e rode de novo.');
  }

  if (e.GMAIL_APP_PASSWORD) {
    enviar.GMAIL_APP_PASSWORD = e.GMAIL_APP_PASSWORD;
    console.log('GMAIL_APP_PASSWORD: enviada.');
  } else if (existentes.has('GMAIL_APP_PASSWORD')) {
    console.log('GMAIL_APP_PASSWORD: já cadastrada.');
  } else {
    aviso('GMAIL_APP_PASSWORD não informada: o "Esqueci minha senha" dos jurados não enviará e-mails (a organização ainda pode gerar senha provisória).');
  }
  fimTitulo();

  if (!Object.keys(enviar).length) return null;
  const pasta = mkdtempSync(path.join(os.tmpdir(), 'udx-festival-seg-'));
  const arquivo = path.join(pasta, 'segredos.json');
  writeFileSync(arquivo, JSON.stringify(enviar), { mode: 0o600 });
  chmodSync(arquivo, 0o600);
  return { arquivo, limpar: () => rmSync(pasta, { recursive: true, force: true }) };
}

function publicar(segredos) {
  titulo('Publicação do Worker');
  const args = ['deploy', '--config', CONFIG_GERADA];
  if (segredos) args.push('--secrets-file', segredos.arquivo);
  if (e.GITHUB_SHA) args.push('--message', `GitHub ${e.GITHUB_REPOSITORY || ''}@${e.GITHUB_SHA.slice(0, 7)}`);
  const r = wrangler(args, { capturar: true });
  console.log(r.saida);
  fimTitulo();
  return r.saida.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] || null;
}

/* ------------------------------ principal ------------------------------ */

async function main() {
  if (NO_CI && !e.CLOUDFLARE_API_TOKEN) {
    aviso('Publicação ignorada: cadastre os Secrets CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID no repositório (veja o README).');
    return;
  }
  if (NO_CI && !e.CLOUDFLARE_ACCOUNT_ID) falhar('Falta o Secret CLOUDFLARE_ACCOUNT_ID no repositório.');
  // Valida tudo antes de mexer na conta
  if (e.ADMIN_SETUP_KEY && e.ADMIN_SETUP_KEY.length < 24) falhar('ADMIN_SETUP_KEY precisa ter pelo menos 24 caracteres (use um valor aleatório).');
  if (!existsSync(path.join(RAIZ, 'dist', 'index.html'))) falhar('dist/ não encontrado: rode `npm run build` antes (ou use `npm run cf:publicar`).');

  const base = lerConfigBase();
  let segredos = null;
  try {
    const idKv = garantirKv(base.idKv);
    const idBanco = garantirBanco(base.nomeBanco, base.idBanco);
    garantirBucket(base.nomeBucket);
    gerarConfig(base, idBanco, idKv);
    aplicarMigracoes(base.nomeBanco);
    segredos = prepararSegredos();
    const url = publicar(segredos);

    const resumo = url
      ? `## Publicado ✅\n\n- **App dos jurados:** ${url}/\n- **Área de admin:** ${url}/admin/ (login em ${url}/admin-login/ · primeiro acesso: \"Primeiro acesso (chave de setup)\")\n`
      : '## Publicado ✅\n\nEndereço não identificado na saída do wrangler. Veja em Workers & Pages no painel da Cloudflare.\n';
    console.log(`\n${resumo.replace(/[#*]/g, '').trim()}\n`);
    if (e.GITHUB_STEP_SUMMARY) appendFileSync(e.GITHUB_STEP_SUMMARY, resumo);
    if (e.GITHUB_OUTPUT && url) appendFileSync(e.GITHUB_OUTPUT, `url=${url}/\n`);
  } finally {
    segredos?.limpar();
    rmSync(CONFIG_GERADA, { force: true });
  }
}

main().catch((err) => {
  if (err instanceof ErroPublicacao) {
    console.error(NO_CI ? `::error::${err.message}` : `\n✖ ${err.message}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
