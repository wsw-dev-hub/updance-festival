-- ============================================================================
-- updance-festival_db — ATUALIZAÇÃO: equipe dos grupos
-- (integrantes, coreógrafo/professor, diretores e coordenadores)
--
-- Só para o banco que JÁ existia antes desta versão. Banco novo: use apenas o schema.sql.
-- Ordem, se o banco é bem antigo: 1) atualizacao-notas-ranking.sql  2) este arquivo.
--
-- Onde executar: D1 → updance-festival_db → Console → cole o arquivo inteiro → Execute
--   ou: npx wrangler d1 execute updance-festival_db --remote --file=atualizacao-grupos-equipe.sql
--
-- Executar UMA vez. Repetir só gera o aviso "duplicate column name" (nada é perdido).
-- Cada campo guarda um nome por linha.
-- ============================================================================

ALTER TABLE grupos ADD COLUMN integrantes TEXT;
ALTER TABLE grupos ADD COLUMN coreografo TEXT;
ALTER TABLE grupos ADD COLUMN diretores TEXT;
ALTER TABLE grupos ADD COLUMN coordenadores TEXT;

SELECT name AS coluna FROM pragma_table_info('grupos') ORDER BY cid;
