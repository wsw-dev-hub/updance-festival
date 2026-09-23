/* =====================================================================
   PATCH NO WORKER DO BLOG (blog.updance.workers.dev) — index.js
   Única alteração necessária fora do projeto do festival.

   O QUE MUDA
   A ponte /api/session/bridge (criada para o app.updance) passa a:
     1) aceitar também o festival como destino (lista de origens permitidas);
     2) encaminhar a sessão de ADMIN quando chamada com ?tipo=admin
        (a_session → asess:<sid>), além da de membro (m_session → msess:<sid>);
     3) gravar `tipo` no handoff, para o adopt do festival saber qual cookie emitir.

   COMPATIBILIDADE
   - O app.updance continua igual: chamada sem `tipo` = membro; o adopt dele ignora o campo novo.
   - Mesmos helpers já existentes no index.js do blog: readCookie, lerSessao, randomToken,
     HANDOFF_TTL e APPS_ORIGIN.

   COMO APLICAR
   A) No bloco de constantes (logo após `const APPS_ORIGIN = ...`), INSERIR:
   ===================================================================== */

const FESTIVAL_ORIGIN = 'https://festival.updance.workers.dev';
const PONTE_ORIGENS_PERMITIDAS = [APPS_ORIGIN, FESTIVAL_ORIGIN];

/* =====================================================================
   B) SUBSTITUIR a função `sessionBridge(request, url, env)` inteira por esta.
      (O registro da rota /api/session/bridge no roteador NÃO muda.)
   ===================================================================== */

async function sessionBridge(request, url, env) {
  const tipo = url.searchParams.get('tipo') === 'admin' ? 'admin' : 'membro';

  // `next` só é aceito se apontar para uma origem da lista (comparação de origem exata,
  // não de prefixo de texto) — mantém a proteção contra open-redirect.
  let destino = null;
  try {
    const u = new URL(url.searchParams.get('next') || '');
    if (PONTE_ORIGENS_PERMITIDAS.includes(u.origin)) destino = u;
  } catch (e) {
    destino = null;
  }
  const next = destino ? destino.toString() : (APPS_ORIGIN + '/apps/');
  const origemDestino = destino ? destino.origin : APPS_ORIGIN;

  const cookieNome = tipo === 'admin' ? 'a_session' : 'm_session';
  const prefixo = tipo === 'admin' ? 'asess' : 'msess';
  const paginaLogin = tipo === 'admin' ? '/admin-login/' : '/entrar/';

  const sid = readCookie(request, cookieNome);
  const sessao = sid ? await lerSessao(env, prefixo, sid) : null;

  if (!sessao) {
    // Sem sessão no blog → login. `next` segue junto para quando o login suportar retorno.
    return Response.redirect(url.origin + paginaLogin + '?next=' + encodeURIComponent(next), 302);
  }

  // Sessão válida → handoff de uso único no KV compartilhado.
  const tok = randomToken(32);
  await env.KV.put(
    'handoff:' + tok,
    JSON.stringify({ sid: sid, next: next, tipo: tipo }),
    { expirationTtl: HANDOFF_TTL },
  );

  return Response.redirect(origemDestino + '/api/session/adopt?t=' + encodeURIComponent(tok), 302);
}

/* =====================================================================
   OPCIONAL (recomendado): retorno automático após o login
   Hoje, depois de entrar em /entrar/, o usuário fica no blog e precisa abrir o link
   do festival de novo (a segunda tentativa já passa direto pela ponte).
   Se o login do blog passar a ler `?next=` e, após sucesso, redirecionar para
   `/api/session/bridge?next=<next>` (ou `&tipo=admin` no /admin-login/), o jurado
   volta sozinho ao festival. Validar `next` com a mesma lista PONTE_ORIGENS_PERMITIDAS.
   ===================================================================== */
