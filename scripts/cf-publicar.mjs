#!/usr/bin/env node
// Publica o worker "festival" do ecossistema UpDance. Idempotente: pode rodar quantas vezes quiser.
//
//   1. Banco D1 "updance-festival_db"        → cria se não existir (banco PRÓPRIO do festival)
//   2. Bucket R2 "updance-festival-audios"   → cria se não existir + regras de retenção
//   3. KV compartilhado do ecossistema       → confere que existe nesta conta (UPDANCE_KV_ID)
//   4. Migrações do banco (migrations/*.sql) → aplica as pendentes
//   5. Publica o Worker
//
// Não há segredos próprios: login e sessões vêm do ecossistema (KV compartilhado).
//
// Variáveis de ambiente:
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   credenciais (no GitHub: Secrets)
//   UPDANCE_KV_ID                                 id do KV usado pelos workers blog e app (obrigatório)
//   UPDANCE_BLOG_ORIGIN                           opcional (padrão: https://blog.updance.workers.dev)
//   RETENCAO_AUDIOS_DIAS                          opcional: apaga áudios após N dias (padrão: nunca)

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_ORIGEM = path.join(RAIZ, 'wrangler.jsonc');
const CONFIG_GERADA = path.join(RAIZ, 'wrangler.publicar.jsonc'); // ignorado pelo Git
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
  const valor = (chave) => texto.match(new RegExp(`"${chave}"\\s*:\\s*"([^"]*)"`))?.[1];
  return { texto, nomeWorker: valor('name'), nomeBanco: valor('database_name'), nomeBucket: valor('bucket_name'), idBanco: valor('database_id') };
}

/* ------------------------------ etapas ------------------------------ */

function garantirBanco(nome, idConfigurado) {
  titulo(`Banco D1 "${nome}"`);
  const lista = extrairJson(wrangler(['d1', 'list', '--json'], { capturar: true }).stdout) || [];
  let banco = lista.find((b) => b.name === nome);
  if (banco) {
    console.log(`Já existe (${banco.uuid}).`);
  } else if (idConfigurado && !/^0{8}-/.test(idConfigurado)) {
    falhar(`wrangler.jsonc aponta para o banco ${idConfigurado}, mas ele não foi encontrado nesta conta.`);
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

function conferirKv(idKv) {
  titulo('KV compartilhado do ecossistema');
  const lista = extrairJson(wrangler(['kv', 'namespace', 'list'], { capturar: true }).stdout) || [];
  const kv = lista.find((k) => k.id === idKv);
  if (!kv) {
    falhar(`O KV ${idKv} não existe nesta conta. O festival precisa ser publicado na MESMA conta Cloudflare dos workers blog e app, com o id do KV que eles usam (variável UPDANCE_KV_ID).`);
  }
  console.log(`Encontrado: "${kv.title}" (${kv.id}).`);
  fimTitulo();
}

function gerarConfig(base, idBanco) {
  let t = base.texto
    .replace(/("database_id"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(idBanco)}`)
    .replace(/("kv_namespaces"[\s\S]*?"id"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(e.UPDANCE_KV_ID)}`);
  if (e.UPDANCE_BLOG_ORIGIN) t = t.replace(/("BLOG_ORIGIN"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(e.UPDANCE_BLOG_ORIGIN.replace(/\/+$/, ''))}`);
  writeFileSync(CONFIG_GERADA, t);
}

function aplicarMigracoes(nomeBanco) {
  titulo('Migrações do banco');
  wrangler(['d1', 'migrations', 'apply', nomeBanco, '--remote', '--config', CONFIG_GERADA]);
  fimTitulo();
}

function publicar() {
  titulo('Publicação do Worker');
  const args = ['deploy', '--config', CONFIG_GERADA];
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
  if (!/^[0-9a-f]{32}$/i.test(e.UPDANCE_KV_ID || '')) {
    falhar('Defina UPDANCE_KV_ID (no GitHub: Settings → Secrets and variables → Actions → Variables) com o id do KV usado pelos workers blog e app (32 caracteres hexadecimais).');
  }
  if (e.UPDANCE_BLOG_ORIGIN && !/^https:\/\/[^/]+$/.test(e.UPDANCE_BLOG_ORIGIN.replace(/\/+$/, ''))) falhar('UPDANCE_BLOG_ORIGIN deve ser só a origem, ex.: https://blog.updance.workers.dev');

  const base = lerConfigBase();
  try {
    conferirKv(e.UPDANCE_KV_ID); // antes de criar qualquer coisa: garante que é a conta do ecossistema
    const idBanco = garantirBanco(base.nomeBanco, base.idBanco);
    garantirBucket(base.nomeBucket);
    gerarConfig(base, idBanco);
    aplicarMigracoes(base.nomeBanco);
    const url = publicar();

    const resumo = url
      ? `## Publicado ✅\n\n- **App dos jurados:** ${url}/\n- **Painel do festival (admin UpDance):** ${url}/admin/\n`
      : '## Publicado ✅\n\nEndereço não identificado na saída do wrangler. Veja em Workers & Pages no painel da Cloudflare.\n';
    console.log(`\n${resumo.replace(/[#*]/g, '').trim()}\n`);
    if (e.GITHUB_STEP_SUMMARY) appendFileSync(e.GITHUB_STEP_SUMMARY, resumo);
    if (e.GITHUB_OUTPUT && url) appendFileSync(e.GITHUB_OUTPUT, `url=${url}/\n`);
  } finally {
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
