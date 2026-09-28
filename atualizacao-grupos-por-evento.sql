-- ============================================================================
-- updance-festival_db — ATUALIZAÇÃO: grupos/escolas passam a pertencer a cada evento
--
-- Por quê: cada responsável cadastra e edita os grupos do SEU evento, sem ver nem alterar
-- os grupos (contatos, integrantes, equipe) de outros eventos.
--
-- Só para o banco que JÁ existia antes desta versão. Banco novo: use apenas o schema.sql.
-- Ordem, se o banco é bem antigo:
--   1) atualizacao-notas-ranking.sql  2) atualizacao-grupos-equipe.sql  3) este arquivo
--
-- Onde executar: D1 → updance-festival_db → Console → cole o arquivo inteiro → Execute
--   ou: npx wrangler d1 execute updance-festival_db --remote --file=atualizacao-grupos-por-evento.sql
--
-- Executar UMA vez. O que ele faz com os grupos que já existem:
--   • cada grupo passa a pertencer ao evento em que tem coreografias;
--   • grupo usado em MAIS de um evento ganha uma cópia (com a mesma equipe) para cada
--     evento extra, e as coreografias desse evento passam a apontar para a cópia;
--   • grupo sem nenhuma coreografia fica "sem evento" (aparece no dashboard para excluir).
-- Nenhuma coreografia, nota ou áudio é apagado.
-- ============================================================================

ALTER TABLE grupos ADD COLUMN evento_id TEXT REFERENCES eventos(id);
CREATE INDEX IF NOT EXISTS idx_grupos_evento ON grupos(evento_id);

-- 1) Cada grupo vai para o evento da sua primeira coreografia
UPDATE grupos
   SET evento_id = (SELECT c.evento_id FROM coreografias c WHERE c.grupo_id = grupos.id ORDER BY c.evento_id LIMIT 1)
 WHERE evento_id IS NULL;

-- 2) Grupo usado em outros eventos: uma cópia por evento extra
INSERT INTO grupos (id, nome, nome_chave, cidade, responsavel, email, telefone, criado_em,
                    integrantes, coreografo, diretores, coordenadores, evento_id)
SELECT DISTINCT g.id || '-' || substr(c.evento_id, 1, 10), g.nome, c.evento_id || '|' || g.nome_chave,
       g.cidade, g.responsavel, g.email, g.telefone, g.criado_em,
       g.integrantes, g.coreografo, g.diretores, g.coordenadores, c.evento_id
  FROM grupos g JOIN coreografias c ON c.grupo_id = g.id
 WHERE c.evento_id <> g.evento_id;

UPDATE coreografias
   SET grupo_id = grupo_id || '-' || substr(evento_id, 1, 10)
 WHERE grupo_id IS NOT NULL
   AND evento_id <> (SELECT g.evento_id FROM grupos g WHERE g.id = coreografias.grupo_id);

-- 3) Nome único por evento (a chave passa a ser "evento|nome")
UPDATE grupos
   SET nome_chave = COALESCE(evento_id, 'sem-evento') || '|' || nome_chave
 WHERE instr(nome_chave, '|') = 0;

-- Conferência: grupos por evento (evento vazio = "sem evento")
SELECT COALESCE(e.nome, '(sem evento)') AS evento, COUNT(*) AS grupos
  FROM grupos g LEFT JOIN eventos e ON e.id = g.evento_id
 GROUP BY g.evento_id ORDER BY evento;
