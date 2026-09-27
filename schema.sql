-- updance-festival_db — esquema completo do UpDance Festival (arquivo único, sem migrações)
--
-- Aplicar UMA vez no banco da Cloudflare (painel D1 → Console, colando este arquivo, ou pelo terminal):
--   npx wrangler d1 execute updance-festival_db --remote --file=schema.sql
-- Pode ser executado de novo sem problema: tudo é "IF NOT EXISTS".
--
-- Cloudflare D1 / SQLite. Datas em milissegundos UTC (INTEGER), exceto eventos.data (AAAA-MM-DD).
-- Senhas: PBKDF2-SHA256 com sal individual (nunca em texto). sessao_versao invalida sessões abertas
-- quando a senha muda, é redefinida ou a conta é desativada.

/* ======================= CONTAS ======================= */

CREATE TABLE IF NOT EXISTS admins (
  id                 TEXT PRIMARY KEY,
  nome               TEXT NOT NULL,
  email              TEXT NOT NULL UNIQUE,     -- minúsculas
  senha_hash         TEXT NOT NULL,
  senha_sal          TEXT NOT NULL,
  senha_iter         INTEGER NOT NULL,
  trocar_senha       INTEGER NOT NULL DEFAULT 1, -- 1 = senha provisória: trocar no próximo acesso
  sessao_versao      INTEGER NOT NULL DEFAULT 1,
  ativo              INTEGER NOT NULL DEFAULT 1,
  tentativas_falhas  INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate      INTEGER NOT NULL DEFAULT 0,
  ultimo_acesso      INTEGER,
  criado_por         TEXT,
  criado_em          INTEGER NOT NULL
);

-- Conta do jurado (uma por pessoa, reaproveitada em vários eventos)
CREATE TABLE IF NOT EXISTS jurados (
  id                 TEXT PRIMARY KEY,
  nome               TEXT NOT NULL,
  email              TEXT NOT NULL UNIQUE,     -- minúsculas
  telefone           TEXT,
  senha_hash         TEXT NOT NULL,
  senha_sal          TEXT NOT NULL,
  senha_iter         INTEGER NOT NULL,
  trocar_senha       INTEGER NOT NULL DEFAULT 1,
  sessao_versao      INTEGER NOT NULL DEFAULT 1,
  ativo              INTEGER NOT NULL DEFAULT 1,
  tentativas_falhas  INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate      INTEGER NOT NULL DEFAULT 0,
  ultimo_acesso      INTEGER,
  criado_por         TEXT,
  criado_em          INTEGER NOT NULL,
  -- "Esqueci minha senha" (/api/member/forgot → e-mail → /reset-senha/): só o SHA-256 do token
  reset_hash         TEXT,
  reset_expira       INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jurados_reset ON jurados(reset_hash) WHERE reset_hash IS NOT NULL;

/* ======================= FESTIVAL ======================= */

-- Grupos, escolas e companhias participantes
CREATE TABLE IF NOT EXISTS grupos (
  id           TEXT PRIMARY KEY,
  nome         TEXT NOT NULL,
  nome_chave   TEXT NOT NULL UNIQUE,           -- nome normalizado (evita duplicatas por acento/caixa)
  cidade       TEXT,
  responsavel  TEXT,
  email        TEXT,
  telefone     TEXT,
  criado_em    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eventos (
  id                  TEXT PRIMARY KEY,
  nome                TEXT NOT NULL,
  data                TEXT NOT NULL,
  local               TEXT,
  fuso                TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  abre_em             INTEGER NOT NULL,           -- a partir de quando os jurados podem gravar
  fecha_em            INTEGER NOT NULL,           -- depois disso, só reenvio de pendências (tolerância)
  anonimizar_jurados  INTEGER NOT NULL DEFAULT 0, -- 1 = participantes veem "jurado-1" em vez do nome
  duracao_max_s       INTEGER NOT NULL DEFAULT 480,
  criado_por          TEXT NOT NULL,
  criado_em           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coreografias (
  id         TEXT PRIMARY KEY,
  evento_id  TEXT NOT NULL REFERENCES eventos(id),
  numero     INTEGER NOT NULL,
  nome       TEXT NOT NULL,
  grupo_id   TEXT REFERENCES grupos(id),
  categoria  TEXT,
  UNIQUE (evento_id, numero)
);
CREATE INDEX IF NOT EXISTS idx_coreografias_grupo ON coreografias(grupo_id);

-- Jurados escalados em cada evento
CREATE TABLE IF NOT EXISTS evento_jurados (
  evento_id  TEXT NOT NULL REFERENCES eventos(id),
  jurado_id  TEXT NOT NULL REFERENCES jurados(id),
  ordem      INTEGER NOT NULL,                  -- usado no nome anonimizado (jurado-1, jurado-2...)
  ativo      INTEGER NOT NULL DEFAULT 1,
  criado_em  INTEGER NOT NULL,
  PRIMARY KEY (evento_id, jurado_id),
  UNIQUE (evento_id, ordem)
);
CREATE INDEX IF NOT EXISTS idx_evento_jurados_jurado ON evento_jurados(jurado_id);

CREATE TABLE IF NOT EXISTS gravacoes (
  id                    TEXT PRIMARY KEY,         -- UUID gerado no aparelho (permite gravar offline)
  evento_id             TEXT NOT NULL REFERENCES eventos(id),
  coreografia_id        TEXT NOT NULL REFERENCES coreografias(id),
  jurado_id             TEXT NOT NULL REFERENCES jurados(id),
  versao                INTEGER NOT NULL,
  identificador         TEXT NOT NULL,            -- nome completo (uso interno)
  identificador_publico TEXT NOT NULL,            -- nome entregue ao participante (pode ser anonimizado)
  mime                  TEXT NOT NULL,
  extensao              TEXT NOT NULL,
  iniciado_em           INTEGER NOT NULL,         -- início segundo o aparelho, corrigido pelo relógio do servidor
  criado_em             INTEGER NOT NULL,
  finalizado_em         INTEGER,
  duracao_ms            INTEGER,
  tamanho               INTEGER,
  sha256                TEXT,
  r2_chave              TEXT,
  status                TEXT NOT NULL DEFAULT 'gravando',  -- gravando | completo
  aprovada              INTEGER NOT NULL DEFAULT 0,
  aprovada_por          TEXT,
  aprovada_em           INTEGER,
  UNIQUE (jurado_id, coreografia_id, versao)
);
CREATE INDEX IF NOT EXISTS idx_gravacoes_evento ON gravacoes(evento_id, status);
CREATE INDEX IF NOT EXISTS idx_gravacoes_coreografia ON gravacoes(coreografia_id);

-- Trechos de ~10 s enviados durante a gravação (cópia de segurança)
CREATE TABLE IF NOT EXISTS trechos (
  gravacao_id  TEXT NOT NULL REFERENCES gravacoes(id),
  seq          INTEGER NOT NULL,
  tamanho      INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  recebido_em  INTEGER NOT NULL,
  PRIMARY KEY (gravacao_id, seq)
);

-- Links de entrega aos participantes (um por coreografia). Só o hash do token é guardado.
CREATE TABLE IF NOT EXISTS links_entrega (
  token_hash      TEXT PRIMARY KEY,
  coreografia_id  TEXT NOT NULL REFERENCES coreografias(id),
  evento_id       TEXT NOT NULL REFERENCES eventos(id),
  criado_por      TEXT NOT NULL,
  criado_em       INTEGER NOT NULL,
  expira_em       INTEGER NOT NULL,
  revogado        INTEGER NOT NULL DEFAULT 0
);

-- Registro de auditoria: somente inserções
CREATE TABLE IF NOT EXISTS auditoria (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id  TEXT,
  ator       TEXT NOT NULL,        -- "admin:<email>", "jurado:<email>", "publico", "sistema"
  acao       TEXT NOT NULL,
  alvo       TEXT,
  detalhes   TEXT,                 -- JSON
  ip         TEXT,
  criado_em  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auditoria_evento ON auditoria(evento_id, criado_em);

CREATE TRIGGER IF NOT EXISTS auditoria_sem_update BEFORE UPDATE ON auditoria
BEGIN SELECT RAISE(ABORT, 'auditoria e somente-insercao'); END;
CREATE TRIGGER IF NOT EXISTS auditoria_sem_delete BEFORE DELETE ON auditoria
BEGIN SELECT RAISE(ABORT, 'auditoria e somente-insercao'); END;

/* ======================= CONFERÊNCIA =======================
   Depois de executar, a consulta abaixo deve listar 10 tabelas:
   admins, auditoria, coreografias, evento_jurados, eventos, grupos, gravacoes, jurados, links_entrega, trechos
   SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;
*/
