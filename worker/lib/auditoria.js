// Auditoria ENXUTA — mesmo princípio do painel do blog (updance_db): registrar só o que a organização
// precisa rastrear, sem pesar no plano gratuito do D1.
//   • Registra ações da organização (eventos, responsáveis, jurados, grupos, coreografias, links, contas)
//     e a finalização de avaliação pelo jurado. NÃO registra logins, notas, gravações, trechos nem acessos
//     aos links — são o grosso do tráfego e já ficam nas próprias tabelas.
//   • Uma linha por ação (importar 200 coreografias = 1 linha), sem IP e sem JSON.
//   • Escrita em segundo plano (ctx.waitUntil): nunca atrasa nem derruba a requisição.
//   • Leitura só quando a aba Auditoria é aberta, em páginas de 50 (índice evento_id + id).
//   • Retenção: linhas com mais de RETENCAO_DIAS são apagadas no máximo 1 vez por dia (controle no KV).

export const RETENCAO_DIAS = 90;
export const POR_PAGINA = 50;

/** Registra uma ação. `alvo` é um texto curto e legível (ex.: "001 · Bolero", "maria@exemplo.com"). */
export function auditar(env, ctx, { eventoId = null, ator, acao, alvo = null }) {
  const p = env.DB.prepare('INSERT INTO auditoria (evento_id, criado_em, ator, acao, alvo) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(eventoId, Date.now(), String(ator || '').slice(0, 120), acao, alvo == null ? null : String(alvo).slice(0, 200))
    .run()
    .catch((e) => console.error('auditoria não gravada:', acao, e.message)); // ex.: tabela ainda não criada
  if (ctx?.waitUntil) ctx.waitUntil(p);
  else return p;
}

/** Apaga registros antigos, no máximo uma vez por dia. */
export async function limparAntigos(env, ctx) {
  const chave = 'fest:aud:limpeza';
  if (await env.KV.get(chave)) return;
  await env.KV.put(chave, '1', { expirationTtl: 86400 });
  const corte = Date.now() - RETENCAO_DIAS * 86400_000;
  const p = env.DB.prepare('DELETE FROM auditoria WHERE criado_em < ?1').bind(corte).run().catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(p);
  else await p;
}

/** Página de registros (mais novos primeiro). eventoId null = contas e acessos (sem evento). */
export async function listar(env, eventoId, antes) {
  const cursor = Number.isFinite(antes) && antes > 0 ? antes : Number.MAX_SAFE_INTEGER;
  const sql = eventoId
    ? 'SELECT id, criado_em, ator, acao, alvo FROM auditoria WHERE evento_id = ?1 AND id < ?2 ORDER BY id DESC LIMIT ?3'
    : 'SELECT id, criado_em, ator, acao, alvo FROM auditoria WHERE evento_id IS NULL AND id < ?2 ORDER BY id DESC LIMIT ?3';
  const { results } = await env.DB.prepare(sql).bind(eventoId, cursor, POR_PAGINA + 1).all();
  return { itens: results.slice(0, POR_PAGINA), mais: results.length > POR_PAGINA, retencao_dias: RETENCAO_DIAS };
}
