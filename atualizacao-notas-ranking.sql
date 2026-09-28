-- ============================================================================
-- updance-festival_db — ATUALIZAÇÃO: notas, ranking e responsáveis de evento
--
-- Só para o banco que JÁ recebeu a versão anterior do schema.sql (10 tabelas).
-- Banco novo/vazio: use apenas o schema.sql (ele já contém tudo isto).
--
-- Onde executar: D1 → updance-festival_db → Console → cole o arquivo inteiro → Execute
--   ou: npx wrangler d1 execute updance-festival_db --remote --file=atualizacao-notas-ranking.sql
--
-- Executar UMA vez. Se executar de novo, os ALTER TABLE acusam "duplicate column name":
-- é só um aviso de que a coluna já existe — nada é perdido.
-- ============================================================================

ALTER TABLE admins ADD COLUMN nivel TEXT NOT NULL DEFAULT 'geral' CHECK (nivel IN ('geral', 'responsavel'));

ALTER TABLE eventos ADD COLUMN nota_min REAL NOT NULL DEFAULT 0;
ALTER TABLE eventos ADD COLUMN nota_max REAL NOT NULL DEFAULT 10;
ALTER TABLE eventos ADD COLUMN nota_casas INTEGER NOT NULL DEFAULT 1;

ALTER TABLE coreografias ADD COLUMN formacao TEXT CHECK (formacao IN ('solo', 'duo', 'trio', 'grupo'));

CREATE TABLE IF NOT EXISTS evento_responsaveis (
  evento_id  TEXT NOT NULL REFERENCES eventos(id),
  admin_id   TEXT NOT NULL REFERENCES admins(id),
  criado_por TEXT,
  criado_em  INTEGER NOT NULL,
  PRIMARY KEY (evento_id, admin_id)
);
CREATE INDEX IF NOT EXISTS idx_evento_responsaveis_admin ON evento_responsaveis(admin_id);

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

SELECT name AS tabela FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;
