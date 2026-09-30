-- ============================================================================
-- updance-festival_db — ATUALIZAÇÃO: integrantes e coreógrafo(a) passam do GRUPO para cada COREOGRAFIA
--
-- Só para o banco que JÁ existia antes desta versão. Banco novo: use apenas o schema.sql.
-- Ordem, se o banco é bem antigo (pule os que já executou):
--   1) atualizacao-notas-ranking.sql  2) atualizacao-grupos-equipe.sql  3) atualizacao-grupos-por-evento.sql
--   4) atualizacao-faixa-coreografias.sql  5) atualizacao-finalizacao.sql  6) atualizacao-remover-auditoria.sql
--   7) este arquivo
--
-- Onde executar: D1 → updance-festival_db → Console → cole o arquivo inteiro → Execute
--   ou: npx wrangler d1 execute updance-festival_db --remote --file=atualizacao-integrantes-coreografias.sql
--
-- Executar UMA vez. O que ele faz:
--   • cria as colunas integrantes e coreografo em coreografias;
--   • copia para cada coreografia os integrantes e o coreógrafo que estavam no cadastro do grupo dela
--     (confira depois na aba Coreografias e ajuste quem dança em cada uma);
--   • as colunas antigas do grupo ficam no banco, sem uso (nada é apagado).
-- ============================================================================

ALTER TABLE coreografias ADD COLUMN integrantes TEXT;
ALTER TABLE coreografias ADD COLUMN coreografo TEXT;

UPDATE coreografias
   SET integrantes = (SELECT g.integrantes FROM grupos g WHERE g.id = coreografias.grupo_id)
 WHERE integrantes IS NULL AND grupo_id IS NOT NULL;
UPDATE coreografias
   SET coreografo = (SELECT g.coreografo FROM grupos g WHERE g.id = coreografias.grupo_id)
 WHERE coreografo IS NULL AND grupo_id IS NOT NULL;

-- Conferência: coreografias com integrantes / coreógrafo preenchidos
SELECT COUNT(*) AS coreografias, COUNT(integrantes) AS com_integrantes, COUNT(coreografo) AS com_coreografo FROM coreografias;
