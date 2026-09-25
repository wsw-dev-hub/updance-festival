-- "Esqueci minha senha" dos jurados (mesmo fluxo do blog: /api/member/forgot → e-mail → /reset-senha/).
-- Guarda só o SHA-256 do token (o token em si só existe no link do e-mail).
ALTER TABLE jurados ADD COLUMN reset_hash TEXT;
ALTER TABLE jurados ADD COLUMN reset_expira INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jurados_reset ON jurados(reset_hash) WHERE reset_hash IS NOT NULL;
