# UpDance Festival · Comentários dos jurados

Sistema para jurados de festivais gravarem comentários em áudio (gravar / pausar / encerrar), com envio automático, fila offline, área de admin e entrega aos participantes. Tem a identidade visual da **Up Dance Xperience**.

Segue o mesmo formato do projeto UpDance:
- **`vite.config.js`** gera as páginas em `dist/`;
- **`wrangler.toml`** publica o Worker com esses assets;
- **`worker/index.js`** concentra as rotas de acesso: `/api/member/*` e `/api/admin/*`, com sessões no KV e cookies `m_session` / `a_session`.

```
vite build ──► dist/  (index.html, admin/, admin-login/, reset-senha/, 404.html, assets/*-hash.js)
                 │
wrangler.toml ───┼─► worker/index.js  (run_worker_first: /api/*, /admin/*, /ouvir/*)
                 │     ├─ KV   sessões m_session / a_session
                 │     ├─ D1   updance-festival_db
                 │     └─ R2   updance-festival-audios (privado)
                 └─► demais caminhos: arquivos estáticos direto do dist/
```

## Rotas de acesso (padrão do `worker/index.js` do blog)

| Rota | Quem | O que faz |
|---|---|---|
| `POST /api/member/login` `{email, password}` | jurado | Cria a sessão (cookie `m_session`, 7 dias) |
| `POST /api/member/logout` | jurado | Encerra a sessão (apaga no KV) |
| `POST /api/member/forgot` `{email}` | jurado | Envia o link `/reset-senha/?token=…` (30 min, uso único). A resposta é sempre genérica |
| `POST /api/member/reset` `{token, password}` | jurado | Grava a nova senha e derruba as sessões abertas |
| `POST /api/member/senha` `{atual, nova}` | jurado | Troca a própria senha (obrigatória no 1º acesso) |
| `GET /api/me` | jurado | Jurado logado, ou 401 |
| `POST /api/admin/setup` `{setup_key, email, password, nome}` | organização | Cria ou redefine um admin com a `ADMIN_SETUP_KEY` |
| `POST /api/admin/login` `{email, password}` | admin | Cria a sessão (cookie `a_session`, 12 h) |
| `POST /api/admin/logout` · `POST /api/admin/senha` · `GET /api/admin/me` | admin | Sair, trocar a senha, identificar |

Páginas: `/` (app do jurado, com login próprio), `/admin-login/` (login e **Primeiro acesso** com a chave de setup), `/admin/` (protegida pelo Worker) e `/reset-senha/`.

**Como no blog:**
- PBKDF2-SHA256 com 100.000 iterações;
- sid aleatório de 32 bytes no KV;
- cookies HttpOnly + Secure + SameSite=Lax;
- mensagem genérica "E-mail ou senha incorretos.";
- cooldown de 60 s no "esqueci minha senha";
- e-mail pelo Gmail (worker-mailer).

**A mais, no festival:**
- As chaves do KV usam o prefixo `fest:`. Se o KV for o mesmo do blog, uma sessão de um sistema não vale no outro.
- A cada requisição a conta é conferida no D1. Trocar ou redefinir a senha e desativar a conta derrubam as sessões na hora.
- Bloqueio de 15 min após 5 senhas erradas. O setup também bloqueia o IP após 5 chaves erradas.
- Senha provisória para contas criadas pela organização.
- O token de redefinição fica guardado só como hash.
- Escritas exigem mesma origem mais o cabeçalho `X-UDX-Festival` (CSRF).
- Tudo fica registrado na auditoria, que é somente inserção.

## Banco `updance-festival_db`

- **Contas:** `admins` · `jurados` · `grupos`.
- **Eventos:** `eventos` · `evento_jurados` (escala) · `coreografias`.
- **Áudios:** `gravacoes` · `trechos` · `links_entrega` · `auditoria`.

A migração `0002` acrescenta ao `jurados` as colunas do "esqueci minha senha".

> O `wrangler.toml` usa o banco que você criou (`database_id = 191b7031-…`). Se ele recebeu o esquema de uma versão anterior deste projeto (a do ecossistema, com `jurados` por evento), apague e recrie o banco antes do deploy. Depois atualize o `database_id`, ou deixe o script criar o banco e copie o novo id.

## Desenvolvimento local

```bash
npm install
cp .dev.vars.example .dev.vars          # ADMIN_SETUP_KEY local
npm run db:local                        # migrações no D1 local
npm run dev:worker                      # terminal 1: vite build + wrangler dev (API em :8787)
npm run dev                             # terminal 2: Vite com HTTPS (mkcert) em https://localhost:3000
```

- **Proxy do Vite:** `/api` e `/ouvir` vão para o Worker. O Origin é reescrito, então a proteção CSRF funciona igual à produção.
- **Área de admin no dev:** `/admin/` passa pelo mesmo gate do Worker, com o middleware `udx-admin-gate-dev`.
- **Primeiro admin:** `https://localhost:3000/admin-login/` → **Primeiro acesso (chave de setup)**.
- **Celular na mesma rede:** `EXPOSE_HOST=1 npm run dev`. O HTTPS do mkcert libera o microfone pelo IP da rede.
- **Sem acesso ao GitHub para baixar o mkcert:** `SEM_HTTPS=1 npm run dev`. Em `http://localhost` o microfone continua funcionando.
- **E-mail em dev:** sem `GMAIL_APP_PASSWORD`, o e-mail de redefinição aparece no terminal do `wrangler dev`, com o link.
- **Versão de produção local:** `npm run preview` (build + wrangler dev em http://localhost:8787).
- **`vite.config.js`:** carrega o `vite-plugin-mkcert` por import dinâmico, só no dev. Assim o build, o CI e o wrangler leem o arquivo sem depender dos plugins de desenvolvimento.

## Colocar no ar

### 1. Secrets do GitHub

Cadastre em **Settings → Secrets and variables → Actions**:

| Tipo | Nome | Valor |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Modelo **Edit Cloudflare Workers** (já inclui KV e R2) + **Account → D1 → Edit** |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Conta onde está o `updance-festival_db` |
| Secret | `ADMIN_SETUP_KEY` | Chave longa e aleatória, com pelo menos 24 caracteres (a mesma ideia do `ADMIN_SETUP_KEY` do blog) |
| Secret (opcional) | `GMAIL_APP_PASSWORD` | Senha de app do Gmail de `GMAIL_USER`, para o "esqueci minha senha" |
| Variable (opcional) | `RETENCAO_AUDIOS_DIAS` | Apaga áudios após N dias |

### 2. Publicar

Faça um `git push` na `main`, ou use **Actions → Verificar e publicar**. O `npm run cf:publicar` roda o `vite build` e depois o `scripts/cf-publicar.mjs`, que:

1. cria o KV **updance-festival-sessoes**, se não existir, e preenche o id no config gerado;
2. confere o D1 do `wrangler.toml`, ou cria o banco;
3. cria o bucket R2 com a regra de retenção dos trechos;
4. aplica as migrações pendentes;
5. envia os secrets;
6. publica o Worker com o `dist/`.

### 3. Primeiro acesso

1. Em `…/admin-login/` → **Primeiro acesso (chave de setup)**, informe a `ADMIN_SETUP_KEY`, o seu e-mail e a sua senha.
2. Entre. Cadastre os **jurados**, que recebem uma senha provisória, e os **grupos**. Depois crie o **evento**, escale os jurados e importe o CSV de coreografias.
3. Envie a cada jurado o link do app e a senha provisória. No 1º acesso, ele cria a própria senha. Se esquecer, usa **Esqueci minha senha**.

## Ajustes em relação ao `wrangler.toml` enviado

- **`name = "updance-festival"`:** o arquivo enviado usava `"updance"`. Mudei para não sobrescrever outro Worker com esse nome. Se `updance` for mesmo o nome desejado, basta trocar.
- **KV:** `binding = "KV"`, com o id preenchido pelo script de publicação.
- **Demais itens:**
  - `[[r2_buckets]]` para os áudios e `migrations_dir`;
  - `run_worker_first` com `/admin`, para o Worker proteger a área de admin;
  - a var `PBKDF2_ITERACOES`.

Os demais itens foram mantidos: `compatibility_date`, `html_handling`, `not_found_handling`, `MAIL_FROM` e `GMAIL_USER`.

## Estrutura

```
index.html · admin/ · admin-login/ · reset-senha/ · 404.html   páginas (entradas do Vite)
src/                          JS/CSS do front (empacotados pelo Vite)
public/                       copiado como está: sw.js, manifest, _headers, js/tema.js, images/icons/
worker/index.js               rotas de acesso + roteamento + gate /admin/* + CSRF
worker/lib/                   sessao (KV), senha (PBKDF2), email (Gmail), http, cripto, auditoria…
worker/rotas/                 sessao (auth) · jurado · admin · entrega
migrations/                   esquema do updance-festival_db
scripts/                      cf-publicar.mjs (deploy idempotente) · verificar-sintaxe.mjs
vite.config.js · wrangler.toml
```

**Ícones UDX:** os arquivos de `public/images/icons/` ainda são provisórios. Troque-os pelos oficiais com os mesmos nomes e aumente `VERSAO` em `public/sw.js`.
