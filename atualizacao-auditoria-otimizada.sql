-- ============================================================================
-- updance-festival_db — ATUALIZAÇÃO: auditoria reestruturada (enxuta, para o plano gratuito do D1)
--
-- Só para o banco que JÁ existia antes desta versão. Banco novo: use apenas o schema.sql.
-- Vale para os dois casos: quem ainda tem a tabela antiga e quem executou o atualizacao-remover-auditoria.sql.
--
-- Onde executar: D1 → updance-festival_db → Console → cole o arquivo inteiro → Execute
--   ou: npx wrangler d1 execute updance-festival_db --remote --file=atualizacao-auditoria-otimizada.sql
--
-- O que muda em relação à auditoria antiga:
--   • só ações da organização e finalizações de jurado (sem logins, notas, gravações, trechos, acessos a links);
--   • uma linha por ação (importar 200 coreografias = 1 linha), sem IP e sem JSON de detalhes;
--   • a tela lê 50 linhas por vez, só quando a aba Auditoria é aberta;
--   • guarda 90 dias (limpeza automática no máximo 1x por dia).
--
-- ATENÇÃO: se a tabela antiga ainda existir, o histórico antigo é descartado (formato incompatível).
-- Para guardar uma cópia antes: SELECT * FROM auditoria;  (exporte o resultado no Console)
-- Execute UMA vez (se executar de novo, o histórico já gravado na nova tabela também é apagado).
-- ============================================================================

-- Remove a versão antiga (triggers, índice e tabela), se existir
DROP TRIGGER IF EXISTS auditoria_sem_update;
DROP TRIGGER IF EXISTS auditoria_sem_delete;
DROP INDEX IF EXISTS idx_auditoria_evento;
DROP TABLE IF EXISTS auditoria;

CREATE TABLE IF NOT EXISTS auditoria (
  id         INTEGER PRIMARY KEY,
  evento_id  TEXT,
  criado_em  INTEGER NOT NULL,
  ator       TEXT NOT NULL,
  acao       TEXT NOT NULL,
  alvo       TEXT
);
CREATE INDEX IF NOT EXISTS idx_auditoria_evento ON auditoria(evento_id, id);

-- Conferência: deve aparecer "auditoria"
SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auditoria';
