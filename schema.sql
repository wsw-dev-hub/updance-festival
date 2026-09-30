-- ============================================================================
-- updance-festival_db — esquema completo do UpDance Festival (Cloudflare D1)
--
-- Onde executar (escolha um):
--   • Painel: Storage & Databases → D1 → updance-festival_db → Console
--             → cole o arquivo inteiro → Execute
--   • Terminal: npx wrangler d1 execute updance-festival_db --remote --file=schema.sql
--
-- Pode ser executado mais de uma vez (tudo usa IF NOT EXISTS; nada é apagado).
-- A última consulta lista as tabelas criadas: devem aparecer 12.
--
-- Banco criado com a versão ANTERIOR deste arquivo? Execute atualizacao-notas-ranking.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS admins (
  id                 TEXT PRIMARY KEY,
  nome               TEXT NOT NULL,
  email              TEXT NOT NULL UNIQUE,
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
  nivel              TEXT NOT NULL DEFAULT 'geral' CHECK (nivel IN ('geral', 'responsavel'))
);

CREATE TABLE IF NOT EXISTS jurados (
  id                 TEXT PRIMARY KEY,
  nome               TEXT NOT NULL,
  email              TEXT NOT NULL UNIQUE,
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
  reset_hash         TEXT,
  reset_expira       INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jurados_reset ON jurados(reset_hash) WHERE reset_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS eventos (
  id                  TEXT PRIMARY KEY,
  nome                TEXT NOT NULL,
  data                TEXT NOT NULL,
  local               TEXT,
  fuso                TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  abre_em             INTEGER NOT NULL,
  fecha_em            INTEGER NOT NULL,
  anonimizar_jurados  INTEGER NOT NULL DEFAULT 0,
  duracao_max_s       INTEGER NOT NULL DEFAULT 480,
  criado_por          TEXT NOT NULL,
  criado_em           INTEGER NOT NULL,
  nota_min            REAL NOT NULL DEFAULT 0,
  nota_max            REAL NOT NULL DEFAULT 10,
  nota_casas          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS grupos (
  id           TEXT PRIMARY KEY,
  nome         TEXT NOT NULL,
  nome_chave   TEXT NOT NULL UNIQUE,
  cidade       TEXT,
  responsavel  TEXT,
  email        TEXT,
  telefone     TEXT,
  criado_em    INTEGER NOT NULL,
  diretores      TEXT,
  coordenadores  TEXT,
  evento_id      TEXT REFERENCES eventos(id)
);
CREATE INDEX IF NOT EXISTS idx_grupos_evento ON grupos(evento_id);

CREATE TABLE IF NOT EXISTS evento_responsaveis (
  evento_id  TEXT NOT NULL REFERENCES eventos(id),
  admin_id   TEXT NOT NULL REFERENCES admins(id),
  criado_por TEXT,
  criado_em  INTEGER NOT NULL,
  PRIMARY KEY (evento_id, admin_id)
);
CREATE INDEX IF NOT EXISTS idx_evento_responsaveis_admin ON evento_responsaveis(admin_id);

CREATE TABLE IF NOT EXISTS coreografias (
  id         TEXT PRIMARY KEY,
  evento_id  TEXT NOT NULL REFERENCES eventos(id),
  numero     INTEGER NOT NULL,
  nome       TEXT NOT NULL,
  grupo_id   TEXT REFERENCES grupos(id),
  categoria  TEXT,
  formacao   TEXT CHECK (formacao IN ('solo', 'duo', 'trio', 'grupo')),
  faixa      TEXT CHECK (faixa IN ('baby', 'infantil', 'juvenil', 'adulto', 'profissional')),
  integrantes TEXT,  -- bailarinos da coreografia, um por linha
  coreografo  TEXT,  -- coreógrafo(a)/professor(a), um por linha
  UNIQUE (evento_id, numero)
);
CREATE INDEX IF NOT EXISTS idx_coreografias_grupo ON coreografias(grupo_id);

CREATE TABLE IF NOT EXISTS evento_jurados (
  evento_id  TEXT NOT NULL REFERENCES eventos(id),
  jurado_id  TEXT NOT NULL REFERENCES jurados(id),
  ordem      INTEGER NOT NULL,
  ativo      INTEGER NOT NULL DEFAULT 1,
  criado_em  INTEGER NOT NULL,
  PRIMARY KEY (evento_id, jurado_id),
  UNIQUE (evento_id, ordem)
);
CREATE INDEX IF NOT EXISTS idx_evento_jurados_jurado ON evento_jurados(jurado_id);

CREATE TABLE IF NOT EXISTS gravacoes (
  id                    TEXT PRIMARY KEY,
  evento_id             TEXT NOT NULL REFERENCES eventos(id),
  coreografia_id        TEXT NOT NULL REFERENCES coreografias(id),
  jurado_id             TEXT NOT NULL REFERENCES jurados(id),
  versao                INTEGER NOT NULL,
  identificador         TEXT NOT NULL,
  identificador_publico TEXT NOT NULL,
  mime                  TEXT NOT NULL,
  extensao              TEXT NOT NULL,
  iniciado_em           INTEGER NOT NULL,
  criado_em             INTEGER NOT NULL,
  finalizado_em         INTEGER,
  duracao_ms            INTEGER,
  tamanho               INTEGER,
  sha256                TEXT,
  r2_chave              TEXT,
  status                TEXT NOT NULL DEFAULT 'gravando',
  aprovada              INTEGER NOT NULL DEFAULT 0,
  aprovada_por          TEXT,
  aprovada_em           INTEGER,
  UNIQUE (jurado_id, coreografia_id, versao)
);
CREATE INDEX IF NOT EXISTS idx_gravacoes_evento ON gravacoes(evento_id, status);
CREATE INDEX IF NOT EXISTS idx_gravacoes_coreografia ON gravacoes(coreografia_id);

CREATE TABLE IF NOT EXISTS notas (
  coreografia_id  TEXT NOT NULL REFERENCES coreografias(id),
  jurado_id       TEXT NOT NULL REFERENCES jurados(id),
  evento_id       TEXT NOT NULL REFERENCES eventos(id),
  nota            REAL NOT NULL,
  criado_em       INTEGER NOT NULL,
  atualizado_em   INTEGER NOT NULL,
  PRIMARY KEY (coreografia_id, jurado_id)
);
CREATE INDEX IF NOT EXISTS idx_notas_evento ON notas(evento_id);

-- Avaliação finalizada pelo jurado: depois disso ele não altera a nota nem grava de novo nessa coreografia
CREATE TABLE IF NOT EXISTS finalizacoes (
  coreografia_id  TEXT NOT NULL REFERENCES coreografias(id),
  jurado_id       TEXT NOT NULL REFERENCES jurados(id),
  evento_id       TEXT NOT NULL REFERENCES eventos(id),
  finalizado_em   INTEGER NOT NULL,
  PRIMARY KEY (coreografia_id, jurado_id)
);
CREATE INDEX IF NOT EXISTS idx_finalizacoes_evento ON finalizacoes(evento_id);

CREATE TABLE IF NOT EXISTS trechos (
  gravacao_id  TEXT NOT NULL REFERENCES gravacoes(id),
  seq          INTEGER NOT NULL,
  tamanho      INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  recebido_em  INTEGER NOT NULL,
  PRIMARY KEY (gravacao_id, seq)
);

CREATE TABLE IF NOT EXISTS links_entrega (
  token_hash      TEXT PRIMARY KEY,
  coreografia_id  TEXT NOT NULL REFERENCES coreografias(id),
  evento_id       TEXT NOT NULL REFERENCES eventos(id),
  criado_por      TEXT NOT NULL,
  criado_em       INTEGER NOT NULL,
  expira_em       INTEGER NOT NULL,
  revogado        INTEGER NOT NULL DEFAULT 0
);

SELECT name AS tabela FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;
