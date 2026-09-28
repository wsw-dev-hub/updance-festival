-- ============================================================================
-- updance-festival_db — ATUALIZAÇÃO: remove a auditoria (economia do banco D1)
--
-- A partir desta versão o sistema NÃO grava mais registros de auditoria (cada login, nota,
-- gravação etc. gerava uma linha a mais). Este arquivo apaga a tabela antiga e libera o espaço.
--
-- Só para o banco que JÁ existia antes desta versão. Banco novo: use apenas o schema.sql.
-- Ordem, se o banco é bem antigo (pule os que já executou):
--   1) atualizacao-notas-ranking.sql  2) atualizacao-grupos-equipe.sql  3) atualizacao-grupos-por-evento.sql
--   4) atualizacao-faixa-coreografias.sql  5) atualizacao-finalizacao.sql  6) este arquivo
--
-- Onde executar: D1 → updance-festival_db → Console → cole o arquivo inteiro → Execute
--   ou: npx wrangler d1 execute updance-festival_db --remote --file=atualizacao-remover-auditoria.sql
--
-- ATENÇÃO: o histórico de auditoria é apagado (não há como recuperar). Se quiser guardar uma cópia
-- antes, exporte a tabela em D1 → updance-festival_db → Console:  SELECT * FROM auditoria;
-- Pode ser executado mais de uma vez sem erro. Nenhum outro dado é tocado.
-- ============================================================================

DROP TRIGGER IF EXISTS auditoria_sem_update;
DROP TRIGGER IF EXISTS auditoria_sem_delete;
DROP INDEX IF EXISTS idx_auditoria_evento;
DROP TABLE IF EXISTS auditoria;

-- Conferência: devem aparecer 12 tabelas (sem "auditoria")
SELECT name AS tabela FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;
