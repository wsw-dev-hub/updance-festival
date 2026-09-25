import { ipDe } from './http.js';

/** Registra uma ação no log de auditoria (somente inserção). */
export function auditar(env, request, { eventoId = null, ator, acao, alvo = null, detalhes = null }) {
  return env.DB.prepare(
    'INSERT INTO auditoria (evento_id, ator, acao, alvo, detalhes, ip, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  )
    .bind(eventoId, ator, acao, alvo, detalhes ? JSON.stringify(detalhes) : null, request ? ipDe(request) : null, Date.now())
    .run();
}
