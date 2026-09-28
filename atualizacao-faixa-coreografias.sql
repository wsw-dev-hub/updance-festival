-- ============================================================================
-- updance-festival_db — ATUALIZAÇÃO: faixa da coreografia (baby, infantil, juvenil, adulto, profissional)
--
-- Só para o banco que JÁ existia antes desta versão. Banco novo: use apenas o schema.sql.
-- Ordem, se o banco é bem antigo (pule os que já executou):
--   1) atualizacao-notas-ranking.sql  2) atualizacao-grupos-equipe.sql
--   3) atualizacao-grupos-por-evento.sql  4) este arquivo
--
-- Onde executar: D1 → updance-festival_db → Console → cole o arquivo inteiro → Execute
--   ou: npx wrangler d1 execute updance-festival_db --remote --file=atualizacao-faixa-coreografias.sql
--
-- Executar UMA vez (se repetir, o ALTER TABLE só avisa "duplicate column name").
-- Nada é apagado: as coreografias existentes ficam "sem faixa" até alguém definir
-- (na aba Coreografias da tela do evento, ou reimportando o CSV com a coluna "faixa").
-- ============================================================================

ALTER TABLE coreografias ADD COLUMN faixa TEXT CHECK (faixa IN ('baby', 'infantil', 'juvenil', 'adulto', 'profissional'));

-- Conferência: a última linha deve ser "faixa"
SELECT name FROM pragma_table_info('coreografias');
