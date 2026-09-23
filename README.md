# UpDance Festival · Comentários dos jurados

Worker do **ecossistema UpDance** para jurados de festivais gravarem comentários em áudio
(gravar / pausar / encerrar), com envio automático, fila offline e entrega aos participantes.

```
blog.updance.workers.dev      login, /entrar/, /admin-login/, ponte de sessão   ─┐
app.updance.workers.dev       apps                                               ├─ KV compartilhado (sessões)
festival.updance.workers.dev  ESTE PROJETO                                      ─┘
                              └─ D1 próprio: updance-festival_db · R2 próprio: updance-festival-audios
```

## Autenticação e acesso (padrão do ecossistema)

| Quem | Sessão | Como entra no festival |
|---|---|---|
| **Jurado** | membro UpDance: cookie `m_session` → `msess:<sid>` no KV | Conta UpDance normal. O admin cadastra o **e-mail da conta** como jurado do evento. |
| **Organização** | admin UpDance: cookie `a_session` → `asess:<sid>` | Mesmo login do `/admin-login/` do blog. `/admin/*` tem gate no servidor. |
| **Participante** | nenhuma | Link com token (256 bits, expira, revogável) só com áudios aprovados. |

Como `*.workers.dev` não compartilha cookies entre subdomínios, o festival recebe a sessão pela **mesma ponte do app.updance**:
`festival → blog /api/session/bridge → handoff:<tok> (60 s, uso único) → festival /api/session/adopt`.

- Sem sessão, o app vai para a ponte automaticamente, com a sentinela anti-loop de 10 s do ecossistema.
- **Sair** apaga a sessão no KV, ou seja, sai do ecossistema inteiro (como no blog).
- **Desativar um jurado** corta o acesso ao festival na hora; a conta UpDance continua normal.

## Banco próprio `updance-festival_db`

`eventos` · `coreografias` · `jurados` (por e-mail UpDance) · `gravacoes` · `trechos` · `links_entrega` · `auditoria` (somente inserção).
Nenhum dado de conta ou senha fica aqui: pessoas são referenciadas pelo e-mail da sessão.

## Identidade visual

`public/css/udx-tokens.css` espelha os tokens `--udx-*` do `blog.css`:

- **Paleta:** `#02021a`, `#110273`, `#BF0449`, `#FA33A1`, `#5708A6`, `#F27405`, `#DFE0F2`, com os gradientes hot e trilhas.
- **Fontes:** Poppins, Bebas Neue, DM Mono e Playfair itálico.
- **Ícones:** MDI 6.9.96.
- **Tema:** claro/escuro via `data-bs-theme` no `<html>`.
- **Topbar do jurado:** padrão da área de membros (`#typeBadge`, `#userChip`).
- **Painel:** abas `data-tab` e aliases `--grad-hot`, `--card`, `--line`.

Se `blog.css` mudar, sincronize os valores.

---

## Colocar no ar

### 1. Patch no worker do blog (uma vez)

Aplique `integracao-blog/sessionBridge.js` no `index.js` do blog. As instruções estão no próprio arquivo:

- uma constante nova;
- a substituição da função `sessionBridge`.

Com isso, a ponte passa a aceitar o festival e a sessão de admin. O app.updance continua igual. Publique o blog.

### 2. Repositório GitHub

Crie o repositório, envie este projeto e cadastre em **Settings → Secrets and variables → Actions**:

| Tipo | Nome | Valor |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Token com o modelo **Edit Cloudflare Workers** + **Account → D1 → Edit** |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Conta onde estão blog e app (**a mesma**) |
| Variable | `UPDANCE_KV_ID` | ID do KV usado por blog e app (Workers & Pages → blog → Settings → Bindings → KV) |
| Variable (opcional) | `RETENCAO_AUDIOS_DIAS` | Apaga áudios após N dias |

### 3. Publicar

**Actions → Verificar e publicar → Run workflow**, ou faça um `git push` na `main`.

O script `scripts/cf-publicar.mjs` faz tudo:

1. Confere que o KV do ecossistema existe na conta.
2. Cria `updance-festival_db` e o bucket, se não existirem.
3. Aplica as migrações pendentes.
4. Publica em **https://festival.updance.workers.dev**.

Não há segredos próprios: a autenticação vem do KV compartilhado.

## Uso

1. Admin UpDance abre `festival…/admin/` → **Novo evento** → importa o CSV (`numero;nome;grupo;categoria`).
2. Aba **Jurados**: nome + e-mail da conta UpDance de cada jurado → copie o **link do app** e envie.
3. O jurado abre o link no Chrome/Safari, entra com a conta UpDance, testa o microfone e grava.
4. **Gravações**: ouvir, aprovar → **Coreografias**: gerar o link de entrega para cada participante.

## Pontos a confirmar no blog

- **Formato das sessões:** o festival lê `email` e `types` (ou `type`) de `msess:*`, e `role` de `asess:*`, aceitando `exp` opcional. Confira se o `index.js` do blog grava assim.
- **Retorno após o login:** o `/entrar/` do blog ainda não volta sozinho ao `next`. Depois do login, o jurado reabre o link do festival (a segunda tentativa passa direto). Há uma sugestão no fim do patch.
- **Chave do tema:** a preferência de tema usa a chave `udx-theme`. Se o blog usar outra, ajuste `public/js/tema.js`.

## Desenvolvimento local

```bash
npm install && cp .dev.vars.example .dev.vars && npm run db:local && npm run dev
```

As sessões de teste são criadas no KV local; os comandos estão em `.dev.vars.example`.

## Estrutura

```
src/index.js                 roteamento + gate /admin/* + proteção CSRF
src/lib/sessao.js            sessões do ecossistema (m_session/a_session, KV, ponte)
src/rotas/                   sessao (adopt/logout) · jurado · admin · entrega
migrations/                  esquema do updance-festival_db
public/                      app do jurado (PWA offline) · admin/ · css/udx-tokens.css
integracao-blog/             patch da ponte de sessão no worker do blog
scripts/cf-publicar.mjs      publicação idempotente
.github/workflows/           verificação + publicação
```
