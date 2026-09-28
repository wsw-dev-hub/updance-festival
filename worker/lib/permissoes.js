// Níveis de acesso da área de admin:
//   geral        → organização: vê e altera tudo (dashboard completo)
//   responsavel  → responsável de evento: só os eventos ligados a ele em evento_responsaveis
//                  (tela exclusiva do evento: dados, escala, coreografias, notas, ranking, áudios)

import { ErroHttp } from './http.js';
import { exigirAdmin } from './sessao.js';

export async function exigirGeral(request, env) {
  const a = await exigirAdmin(request, env);
  if (a.nivel !== 'geral') throw new ErroHttp(403, 'Somente a organização geral pode fazer isto', 'somente_geral');
  return a;
}

export async function podeVerEvento(env, a, eventoId) {
  if (a.nivel === 'geral') return true;
  const r = await env.DB.prepare('SELECT 1 FROM evento_responsaveis WHERE evento_id = ?1 AND admin_id = ?2').bind(eventoId, a.id).first();
  return !!r;
}

/** Admin com acesso ao evento. 404 para quem não tem (não revela que o evento existe). */
export async function exigirEvento(request, env, eventoId) {
  const a = await exigirAdmin(request, env);
  if (!(await podeVerEvento(env, a, eventoId))) throw new ErroHttp(404, 'Evento não encontrado', 'nao_encontrado');
  return a;
}

/** Busca um registro que tem evento_id (gravação, coreografia…) e confere o acesso ao evento dele. */
export async function exigirRegistroDoEvento(request, env, sql, id, rotulo) {
  const a = await exigirAdmin(request, env);
  const linha = await env.DB.prepare(sql).bind(id).first();
  if (!linha || !(await podeVerEvento(env, a, linha.evento_id))) throw new ErroHttp(404, `${rotulo} não encontrado(a)`, 'nao_encontrado');
  return { a, linha };
}
