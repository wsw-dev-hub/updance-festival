-- updance-festival_db — banco próprio do festival (Cloudflare D1 / SQLite)
-- Autenticação e contas ficam no ecossistema UpDance (KV compartilhado).
-- Aqui só ficam os dados do festival. Pessoas são referenciadas pelo e-mail da conta UpDance.
-- Datas em milissegundos UTC (INTEGER), exceto eventos.data (AAAA-MM-DD).

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
  criado_por          TEXT NOT NULL,              -- e-mail do admin UpDance
  criado_em           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coreografias (
  id         TEXT PRIMARY KEY,
  evento_id  TEXT NOT NULL REFERENCES eventos(id),
  numero     INTEGER NOT NULL,
  nome       TEXT NOT NULL,
  grupo      TEXT,
  categoria  TEXT,
  UNIQUE (evento_id, numero)
);

-- Jurado = membro UpDance (e-mail da conta) vinculado a um evento pelo admin
CREATE TABLE IF NOT EXISTS jurados (
  id         TEXT PRIMARY KEY,
  evento_id  TEXT NOT NULL REFERENCES eventos(id),
  email      TEXT NOT NULL,                       -- minúsculas, igual ao da sessão msess:<sid>
  nome       TEXT NOT NULL,
  ordem      INTEGER NOT NULL,                    -- usado no nome anonimizado (jurado-1, jurado-2...)
  ativo      INTEGER NOT NULL DEFAULT 1,
  criado_em  INTEGER NOT NULL,
  UNIQUE (evento_id, email),
  UNIQUE (evento_id, ordem)
);
CREATE INDEX IF NOT EXISTS idx_jurados_email ON jurados(email);

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
  ator       TEXT NOT NULL,        -- "membro:<email>", "admin:<email>", "publico"
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
