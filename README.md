# UpDance Festival · Comentários dos jurados

Sistema para jurados de festivais gravarem comentários em áudio (gravar / pausar / encerrar), com envio automático, fila offline, área de admin e entrega aos participantes. Faz parte do ecossistema **Up Dance Xperience**: paleta, fontes, tema claro/escuro, ícones e layout responsivo são os mesmos dos demais apps.

Projeto único:
- **Vite** gera as páginas em `dist/`;
- **`wrangler.toml`** publica o Worker (`worker/index.js`) com esses arquivos;
- **`schema.sql`** tem o banco inteiro, em um arquivo só, sem migrações.

```
GitHub ──► Cloudflare (Workers Builds)
             build:  npm run build        → dist/
             deploy: npx wrangler deploy  → Worker "updance-festival"
                                              ├─ KV  (sessões m_session / a_session)
                                              ├─ D1  updance-festival_db  (schema.sql)
                                              └─ R2  updance-festival-audios (áudios, privado)
```

---

## Colocar no ar — passo a passo (sem scripts)

O `npx wrangler deploy` **só publica**: ele não cria o bucket R2, não cria tabelas e não cadastra segredos. Foi isso que gerou o erro `R2 bucket 'updance-festival-audios' not found [code: 10085]`. Os passos abaixo preparam tudo uma única vez, na ordem.

### Passo 1 — Atualizar o repositório no GitHub

1. Substitua o conteúdo do repositório pelo desta versão.
2. Apague do repositório as pastas que não existem mais: **`migrations/`**, **`scripts/`** e **`.github/`**. Sem a `.github/`, o GitHub Actions para de publicar em paralelo com a Cloudflare.
3. Confira se o repositório **não** tem `.dev.vars`, `node_modules/` nem `dist/`. O `.gitignore` já exclui esses três.

### Passo 2 — Ativar o R2 e criar o bucket (causa do erro)

1. No painel da Cloudflare, abra **R2 Object Storage**. Se for o primeiro uso, clique em **Purchase R2 / Enable R2** e escolha o plano gratuito. Ele pede cartão, mas não cobra dentro da cota: 10 GB, mais 1 milhão de escritas e 10 milhões de leituras por mês.
2. Clique em **Create bucket**:
   - **Name:** `updance-festival-audios`, exatamente assim;
   - **Location:** Automatic;
   - **Storage class:** Standard.
3. Não ative o **Public access / r2.dev**. Os áudios só saem pelo Worker, com login ou link de entrega.
4. **Opcional, recomendado:** no bucket, abra **Settings → Object lifecycle rules → Add rule**:
   - **Name:** `trechos-7-dias`;
   - **Prefix:** `trechos/`;
   - **Delete objects after:** 7 dias.

   Os trechos são só a cópia de segurança durante a gravação.

### Passo 3 — Conferir o KV (sessões)

1. Abra **Storage & Databases → Workers KV**. O namespace com o id `10d76ce53a5049fbab9cab01b68936e2` precisa estar na lista. É o id que apareceu no seu log e já está no `wrangler.toml`.
2. Se quiser usar outro namespace, crie-o (**Create namespace**, nome `updance-festival-sessoes`) e cole o **Namespace ID** em `wrangler.toml` → `[[kv_namespaces]] id`.

### Passo 4 — Criar as tabelas no D1

O banco `updance-festival_db` já existe (id `191b7031-…` no `wrangler.toml`). Falta criar as tabelas. Há duas formas de fazer isso.

**Forma A: pelo terminal, no seu computador, na pasta do projeto**

```
npm install
npx wrangler login
npx wrangler d1 execute updance-festival_db --remote --file=schema.sql
```

**Forma B: pelo painel**

1. Abra **Storage & Databases → D1 → updance-festival_db → Console**.
2. Cole todo o conteúdo de `schema.sql` e execute.
3. Se o console recusar os dois comandos `CREATE TRIGGER`, execute cada um sozinho. Eles estão no fim do arquivo.

**Conferência.** Execute esta consulta no Console:

```sql
SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;
```

O resultado deve ter **10 tabelas**: `admins, auditoria, coreografias, evento_jurados, eventos, gravacoes, grupos, jurados, links_entrega, trechos`.

> **Se o banco já tinha tabelas de uma versão anterior deste projeto,** confira com a consulta abaixo:
>
> ```sql
> SELECT name FROM pragma_table_info('jurados');
> ```
>
> A lista precisa incluir `telefone` e `reset_hash`. Se não incluir, e como ainda não há dados de festival nele, o caminho mais limpo é recriar o banco:
> 1. D1 → `updance-festival_db` → **Settings → Delete**.
> 2. **Create database** com o mesmo nome.
> 3. Copie o novo **Database ID** para `wrangler.toml` → `database_id` e faça commit.
> 4. Repita o passo 4.

### Passo 5 — Configurar o build na Cloudflare

Abra **Workers & Pages → updance-festival → Settings → Build** e confira:

| Campo | Valor |
|---|---|
| Git repository / Branch | o seu repositório / `main` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` (a raiz do repositório, onde está o `wrangler.toml`) |

O aviso `npm warn allow-scripts … esbuild / workerd` que aparece no log é só informativo. Ele não impede o build.

### Passo 6 — Publicar

Clique em **Deployments → Retry deployment** no build que falhou, ou faça um novo `git push` na `main`.

O log agora termina com `Deployed updance-festival` e o endereço `https://updance-festival.<sua-conta>.workers.dev`.

### Passo 7 — Segredos (depois do 1º deploy com sucesso)

Abra **Workers & Pages → updance-festival → Settings → Variables and Secrets → Add** e escolha o tipo **Secret**:

| Nome | Valor |
|---|---|
| `ADMIN_SETUP_KEY` | Uma chave longa e aleatória, com 24 caracteres ou mais. Guarde num lugar seguro: ela cria ou recupera administradores. |
| `GMAIL_APP_PASSWORD` | Opcional. É a senha de app do Gmail de `updancexperience@gmail.com` (Conta Google → Segurança → Senhas de app). Sem ela, o "Esqueci minha senha" não envia e-mail. |

Os segredos ficam guardados entre um deploy e outro.

Não cadastre variáveis de texto (**Text**) pelo painel. As variáveis do `[vars]` do `wrangler.toml` substituem as do painel a cada deploy.

### Passo 8 — Primeiro acesso

1. Abra `https://updance-festival.<sua-conta>.workers.dev/admin-login/` e clique em **Primeiro acesso (chave de setup)**.
2. Informe a `ADMIN_SETUP_KEY`, o seu nome, o seu e-mail e uma senha com pelo menos 10 caracteres, letras e números. Depois entre com esse e-mail e essa senha.
3. Na área de admin, faça nesta ordem:
   1. **Jurados:** cadastre cada um. Anote a senha provisória, que aparece uma única vez.
   2. **Grupos:** opcional; também são criados pelo CSV.
   3. **Eventos → Novo evento**, depois **Escala de jurados** e **Coreografias** (CSV `numero;nome;grupo;categoria`).
4. Envie a cada jurado o **link do app** e a senha provisória. No 1º acesso, ele cria a própria senha.

### Passo 9 — Verificação rápida

- [ ] `/` abre a tela de login do jurado com a marca UDX.
- [ ] `/admin/` sem login leva para `/admin-login/`.
- [ ] Depois do login, a área de admin lista Eventos, Jurados, Grupos, Administradores, Minha conta e Auditoria.
- [ ] Um jurado de teste entra, cria a senha, testa o microfone, grava e vê **✓ enviado**.
- [ ] Na aba **Gravações**, o admin ouve o áudio.
- [ ] Se algo falhar, veja **Workers & Pages → updance-festival → Logs** (observability está ligado).

---

## Rotas de acesso (padrão do `worker/index.js` do blog UpDance)

| Rota | Quem | O que faz |
|---|---|---|
| `POST /api/member/login` `{email, password}` | jurado | Cria a sessão (cookie `m_session`, 7 dias) |
| `POST /api/member/logout` | jurado | Encerra a sessão |
| `POST /api/member/forgot` `{email}` | jurado | Envia o link `/reset-senha/?token=…` (30 min, uso único) |
| `POST /api/member/reset` `{token, password}` | jurado | Grava a nova senha e derruba as sessões abertas |
| `POST /api/member/senha` `{atual, nova}` | jurado | Troca a própria senha (obrigatória no 1º acesso) |
| `GET /api/me` | jurado | Jurado logado, ou 401 |
| `POST /api/admin/setup` `{setup_key, email, password, nome}` | organização | Cria ou redefine um admin com a `ADMIN_SETUP_KEY` |
| `POST /api/admin/login` `{email, password}` | admin | Cria a sessão (cookie `a_session`, 12 h) |
| `POST /api/admin/logout` · `POST /api/admin/senha` · `GET /api/admin/me` | admin | Sair, trocar a senha, identificar |

**Segurança:**
- **Senhas:** PBKDF2-SHA256 com 100.000 iterações, como no blog. As contas são bloqueadas por 15 min após 5 erros; o setup também bloqueia o IP após 5 chaves erradas.
- **Sessões:** ficam no KV com o prefixo `fest:`, então não se misturam com as do blog. Trocar ou redefinir a senha e desativar a conta derrubam as sessões na hora.
- **Cookies:** HttpOnly, Secure e SameSite=Lax.
- **Escritas:** exigem mesma origem mais o cabeçalho `X-UDX-Festival` (proteção CSRF).
- **Auditoria:** somente inserção.

## Identidade visual e responsividade

- **Tokens:** `src/css/udx-tokens.css`.
  - **Paleta:** `#02021a`, `#110273`, `#BF0449`, `#FA33A1`, `#5708A6`, `#F27405`, `#DFE0F2`.
  - **Fontes:** Poppins, Bebas Neue, DM Mono e Playfair itálico.
- **Tema:** claro/escuro com `data-bs-theme`, preferência na chave `udx-theme` (`public/js/tema.js`).
- **Ícones:** Material Design Icons 6.9.96, com rótulos em texto se o CDN falhar. Ícones da marca em `public/images/icons/`.
  - ⚠ Os arquivos atuais são provisórios. Troque-os pelos oficiais com os mesmos nomes e aumente `VERSAO` em `public/sw.js`.
- **Responsivo:** conferido de 360 px a 1280 px, nos dois temas.
  - As abas viram uma linha com rolagem lateral no celular.
  - As tabelas rolam dentro do próprio card, e a página nunca rola na horizontal.

## Desenvolvimento local

```
npm install
cp .dev.vars.example .dev.vars   # (Windows: copy .dev.vars.example .dev.vars)
npm run db:local                 # cria as tabelas no D1 local a partir do schema.sql
npm run dev:worker               # terminal 1: build + API em http://localhost:8787
npm run dev                      # terminal 2: Vite com HTTPS em https://localhost:3000
```

- **Celular na mesma rede:** `EXPOSE_HOST=1 npm run dev`. O HTTPS do mkcert libera o microfone.
- **Sem mkcert:** `SEM_HTTPS=1 npm run dev`.
- **E-mail em dev:** sem `GMAIL_APP_PASSWORD`, o e-mail de "esqueci minha senha" aparece no terminal do `wrangler dev`, com o link.

## Estrutura

```
index.html · admin/ · admin-login/ · reset-senha/ · 404.html   páginas (entradas do Vite)
src/            JS/CSS do front (empacotados pelo Vite)
public/         copiado como está: sw.js, manifest, _headers, js/tema.js, images/icons/
worker/         index.js (rotas de acesso + roteamento) · lib/ · rotas/
schema.sql      banco completo (arquivo único)
vite.config.js · wrangler.toml · package.json
```
