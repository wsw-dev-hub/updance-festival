-- ============================================================================
-- updance-festival_db — ATUALIZAÇÃO: botão "Finalizar" do jurado
--
-- Só para o banco que JÁ existia antes desta versão. Banco novo: use apenas o schema.sql.
-- Ordem, se o banco é bem antigo (pule os que já executou):
--   1) atualizacao-notas-ranking.sql  2) atualizacao-grupos-equipe.sql
--   3) atualizacao-grupos-por-evento.sql  4) atualizacao-faixa-coreografias.sql  5) este arquivo
--
-- Onde executar: D1 → updance-festival_db → Console → cole o arquivo inteiro → Execute
--   ou: npx wrangler d1 execute updance-festival_db --remote --file=atualizacao-finalizacao.sql
--
-- Pode ser executado mais de uma vez sem problema. Nada é apagado.
-- ============================================================================

CREATE TABLE IF NOT EXISTS finalizacoes (
  coreografia_id  TEXT NOT NULL REFERENCES coreografias(id),
  jurado_id       TEXT NOT NULL REFERENCES jurados(id),
  evento_id       TEXT NOT NULL REFERENCES eventos(id),
  finalizado_em   INTEGER NOT NULL,
  PRIMARY KEY (coreografia_id, jurado_id)
);
CREATE INDEX IF NOT EXISTS idx_finalizacoes_evento ON finalizacoes(evento_id);

-- Conferência: deve aparecer "finalizacoes"
SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'finalizacoes';
