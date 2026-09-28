# UpDance Festival · Comentários dos jurados

Sistema para jurados de festivais gravarem comentários em áudio (gravar / pausar / encerrar), com envio automático, fila offline, área de admin e entrega aos participantes. Faz parte do ecossistema **Up Dance Xperience**: paleta, fontes, tema claro/escuro, ícones e layout responsivo são os mesmos dos demais apps.

Projeto único:
- **Vite** gera as páginas em `dist/`;
- **`wrangler.toml`** publica o Worker (`worker/index.js`) com esses arquivos;
- **`schema.sql`** tem o banco inteiro, em um arquivo só, sem migrações. Para um banco que já existia, há os arquivos de atualização `atualizacao-notas-ranking.sql`, `atualizacao-grupos-equipe.sql` e `atualizacao-grupos-por-evento.sql` (veja o passo 4).

## Telas

| Tela | Quem usa | O que tem |
|---|---|---|
| `/` | jurados | Gravação do comentário em áudio **e nota da coreografia** (funciona sem internet: a nota fica guardada e é enviada quando a rede volta) |
| `/admin/` | organização (nível **geral**) | **Painel de controle** do sistema: números gerais (eventos, responsáveis, jurados, grupos, notas, áudios, armazenamento, logins falhos), alertas (evento sem responsável, contas bloqueadas, grupos sem evento), tabela de todos os eventos, administradores, contas de jurados (nova senha, desativar), grupos de todos os eventos (consulta), auditoria geral. **Não cadastra** eventos, grupos nem jurados. |
| `/admin/eventos/` | geral e **responsáveis** | **Eventos e responsáveis**: cria eventos (já com os responsáveis) e, em cada cartão, adiciona, remove e gera nova senha para os responsáveis. |
| `/admin/evento/?id=…` | geral e **responsáveis do evento** | Tela de cada evento: **Notas** (jurado × coreografia, status dos áudios, média automática), **Ranking** (pódio das 3 maiores médias + lista completa, por solos, duos, trios e grupos), Áudios, Coreografias, **Grupos** (cadastro com equipe), **Jurados** (cadastro e escala), Auditoria. |

**Níveis de administrador:**
- **Geral:** a organização do festival. Usa o painel de controle, vê todos os eventos e pode agir em qualquer um.
- **Responsável de evento:** ao entrar, cai em `/admin/eventos/`. Tem autonomia sobre os eventos em que é responsável:
  - cria novos eventos (e vira responsável deles automaticamente);
  - define quem mais administra cada evento: adiciona, remove, gera nova senha (o evento nunca fica sem responsável);
  - edita dados e escala de notas;
  - cadastra **grupos/escolas** e **jurados** na tela do evento, e edita nome/telefone e senha dos jurados;
  - cadastra coreografias, aprova áudios, gera links de entrega, acompanha notas e ranking.

  Ele não vê o painel de controle, outros eventos, nem contas de outras equipes. Uma conta (jurado ou responsável) que também atua em evento de **outra** equipe só pode ter senha ou nome alterados pela organização geral: assim ninguém ganha acesso a evento alheio redefinindo a senha de alguém.

**Grupos por evento:** cada grupo/escola pertence a um evento. O mesmo nome pode existir em eventos diferentes (com contatos e equipes próprios), e um responsável nunca vê os grupos de outro evento.

**Notas e médias:**
- A escala é definida por evento: mínima, máxima e casas decimais. O padrão é **0 a 10, uma casa**.
- O jurado pode alterar a nota enquanto o evento aceita envios, e cada alteração fica na auditoria com o valor anterior.
- A **média** é a média simples das notas dos jurados **ativos** na escala. Um jurado suspenso continua aparecendo no quadro, mas sai da média.
- No **ranking**, médias iguais dividem a posição. "Parcial" indica que ainda faltam notas.

**Grupos:** além de nome, cidade, responsável e contato, o cadastro guarda a equipe:
- **integrantes**;
- **coreógrafo(a)/professor(a)**;
- **diretores**;
- **coordenadores**.

Em cada campo vai um nome por linha. Também dá para separar os nomes com `;` ou `,`, e os repetidos são removidos. A lista de grupos mostra a equipe, e os integrantes aparecem num resumo que abre ao clicar.

**Áudios dos jurados** (aba **Áudios** da tela do evento):
- **Ouvir / Pausar** em cada linha, com um player que fica fixo no topo da aba enquanto a lista rola. A barra de avanço funciona, e os áudios ainda chegando tocam o que já foi recebido.
- **Baixar** cada arquivo, com o nome completo do identificador. Os parciais saem como "Baixar parcial".
- **Baixar ZIP** junta os áudios completos da lista filtrada, em pastas por coreografia.
  - Filtros: jurado, situação e busca.
  - O ZIP é montado no navegador, sem compressão, porque áudio já vem comprimido. Assim o Worker não estoura o limite de CPU do plano gratuito.
  - Até 400 MB por ZIP; acima disso, filtre e baixe em partes.
- **Formato:** o arquivo vem no formato gravado pelo aparelho, WebM (Android/Chrome) ou MP4 (iPhone). Se algum navegador não tocar um formato, o **Baixar** funciona sempre, e o arquivo abre no VLC ou em qualquer player atual.

**Formação da coreografia** (segmenta o ranking):
- `solo`, `duo`, `trio` ou `grupo`, informada no cadastro ou no CSV (coluna `formacao`).
- Aceita sinônimos: "Solo feminino", "dupla", "conjunto"…
- Em vez da formação, o CSV pode trazer a coluna `integrantes` com o número de bailarinos: 1 = solo, 2 = duo, 3 = trio, 4 ou mais = grupo.

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

O resultado deve ter **12 tabelas**: `admins, auditoria, coreografias, evento_jurados, evento_responsaveis, eventos, gravacoes, grupos, jurados, links_entrega, notas, trechos`.

> **Já executou o `schema.sql` da versão anterior (10 tabelas)?** Execute **uma vez** o `atualizacao-notas-ranking.sql`, no Console ou pelo terminal:
>
> ```
> npx wrangler d1 execute updance-festival_db --remote --file=atualizacao-notas-ranking.sql
> ```
>
> Ele acrescenta:
> - as colunas de nível do admin, de escala de notas do evento e de formação da coreografia;
> - as tabelas `notas` e `evento_responsaveis`.
>
> Nada é apagado. Se for executado de novo, os `ALTER TABLE` apenas avisam "duplicate column name".
>
> **Depois**, execute também, uma vez cada, na ordem:
> 1. **`atualizacao-grupos-equipe.sql`**: acrescenta ao `grupos` as colunas `integrantes`, `coreografo`, `diretores` e `coordenadores`.
> 2. **`atualizacao-grupos-por-evento.sql`**: liga cada grupo ao seu evento (coluna `evento_id`). Grupo usado em mais de um evento ganha uma cópia por evento, com a mesma equipe; grupo sem coreografia fica "sem evento" (aparece no painel de controle para excluir). Nenhuma coreografia, nota ou áudio é apagado. A consulta do fim mostra quantos grupos ficaram em cada evento.
>
> Resumo da ordem para um banco antigo: `atualizacao-notas-ranking.sql` → `atualizacao-grupos-equipe.sql` → `atualizacao-grupos-por-evento.sql`. Pule os que já executou. Banco criado com o `schema.sql` desta versão já tem tudo e não precisa de nenhum arquivo de atualização.

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
3. Você cai no **Painel de controle**. Clique em **Eventos e responsáveis** (ou **Novo evento**).
4. Em **Novo evento**, informe nome, data, horários, escala de notas e, no bloco **Responsáveis do evento**, o nome e o e-mail de quem vai administrar (pode ser mais de um; também dá para deixar em branco e adicionar depois no cartão do evento). Clique em **Criar evento**.
   - As contas novas aparecem num quadro com o endereço `/admin-login/` e a senha provisória de cada uma (**Copiar tudo**). Elas aparecem uma única vez.
5. Envie a cada responsável esse endereço, o e-mail e a senha provisória. No 1º acesso, ele cria a própria senha e cai na tela **Eventos e responsáveis**, só com os eventos dele.
6. O responsável (ou você) clica em **Abrir tela do evento** e faz, nesta ordem:
   1. **Grupos:** cadastra cada grupo/escola com cidade, contato, integrantes, coreógrafo(a)/professor(a), diretores e coordenadores. (Grupos que faltarem também são criados pelo CSV do passo seguinte.)
   2. **Coreografias:** importa o CSV `numero;nome;grupo;categoria;formacao` ou cadastra uma a uma.
   3. **Jurados:** informa nome, e-mail e telefone de cada um. Quem não tem conta recebe uma senha provisória, que aparece uma única vez.
7. Envie a cada jurado o **link do app** (botão **Link dos jurados**) e a senha provisória. No 1º acesso, ele cria a própria senha.
8. Durante o evento, a aba **Notas** atualiza sozinha a cada 15 s. O **Ranking** mostra o pódio de cada formação e exporta CSV.

### Passo 9 — Verificação rápida

- [ ] `/` abre a tela de login do jurado com a marca UDX.
- [ ] `/admin/` sem login leva para `/admin-login/`.
- [ ] Depois do login, o **Painel de controle** mostra os números gerais e as abas Administradores, Jurados, Grupos, Auditoria e Minha conta.
- [ ] Um responsável de teste entra e cai em `/admin/eventos/`; abrir `/admin/` o leva de volta para lá.
- [ ] Um jurado de teste entra, cria a senha, testa o microfone, grava e vê **✓ enviado**.
- [ ] Na aba **Áudios** da tela do evento, o admin ouve o áudio.
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
| `PUT /api/notas/:coreografia` `{nota}` | jurado | Lança ou altera a nota (`null` apaga) |
| `GET /api/me` | jurado | Jurado logado, ou 401 |
| `POST /api/admin/setup` `{setup_key, email, password, nome}` | organização | Cria ou redefine um admin com a `ADMIN_SETUP_KEY` |
| `POST /api/admin/login` `{email, password}` | admin | Cria a sessão (cookie `a_session`, 12 h) |
| `POST /api/admin/logout` · `POST /api/admin/senha` · `GET /api/admin/me` | admin | Sair, trocar a senha, identificar (`nivel`: geral/responsavel) |
| `GET /api/admin/eventos/:id/notas` | geral ou responsável | Quadro de notas: jurado × coreografia, status dos áudios, média e contagem |
| `GET /api/admin/resumo` | geral | Números e alertas do painel de controle |
| `POST /api/admin/eventos` `{…, responsaveis:[{nome,email}]}` | geral ou responsável | Cria o evento já com os responsáveis (quem cria, se responsável, entra automaticamente) |
| `POST` / `DELETE /api/admin/eventos/:id/responsaveis` · `POST …/responsaveis/:admin/redefinir-senha` | geral ou responsável do evento | Liga, desliga ou gera nova senha para responsáveis (o último não sai) |
| `GET` / `POST /api/admin/eventos/:id/grupos` | geral ou responsável do evento | Grupos/escolas do evento |
| `POST /api/admin/eventos/:id/jurados` `{nome,email,telefone}` | geral ou responsável do evento | Cadastra (se preciso) e escala o jurado |

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
index.html · admin/ · admin/eventos/ · admin/evento/ · admin-login/ · reset-senha/ · 404.html   páginas (entradas do Vite)
src/            JS/CSS do front (empacotados pelo Vite)
public/         copiado como está: sw.js, manifest, _headers, js/tema.js, images/icons/
worker/         index.js (rotas de acesso + roteamento) · lib/ · rotas/
schema.sql      banco completo (arquivo único)
atualizacao-notas-ranking.sql   bancos criados antes das notas/ranking (executar 1º)
atualizacao-grupos-equipe.sql   bancos criados antes da equipe dos grupos (executar 2º)
atualizacao-grupos-por-evento.sql   bancos criados antes dos grupos por evento (executar 3º)
vite.config.js · wrangler.toml · package.json
```
