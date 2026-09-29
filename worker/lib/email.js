// E-mail transacional pelo Gmail (SMTP), no mesmo padrão do worker do blog UpDance.
// Vars: GMAIL_USER. Secret: GMAIL_APP_PASSWORD (senha de app da conta Google).

import { WorkerMailer } from 'worker-mailer';

export async function enviarEmail(env, to, subject, html) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    // Sem credenciais: em desenvolvimento, o conteúdo vai para o log do wrangler dev
    if (env.AMBIENTE === 'dev') {
      const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
      console.log(`[e-mail simulado] para ${to} · ${subject}\n${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\nLinks: ${links.join(' ')}`);
      return { ok: true, simulado: true };
    }
    return { ok: false, error: 'GMAIL_APP_PASSWORD não configurado' };
  }
  try {
    const mailer = await WorkerMailer.connect({
      host: 'smtp.gmail.com', port: 587, startTls: true, authType: 'login',
      socketTimeoutMs: 15_000, responseTimeoutMs: 15_000,
      credentials: { username: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD },
    });
    await mailer.send({ from: { name: 'Up Dance Xperience', email: env.GMAIL_USER }, to, subject, html });
    if (typeof mailer.close === 'function') { try { await mailer.close(); } catch { /* ignora */ } }
    return { ok: true };
  } catch (err) {
    console.error('Gmail SMTP falhou:', err.message);
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function moldura(html) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;background:#020118;color:#DFE0F2;border-radius:14px;overflow:hidden"><div style="padding:28px 28px 8px">${html}</div></div>`;
}
function botao(href, t) {
  return `<a href="${esc(href)}" style="display:inline-block;background:#BF0449;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:9px;font-size:15px">${t}</a>`;
}

export function emailReset(link, nome) {
  return moldura(`<h2 style="margin:0 0 12px;font-size:18px;color:#fff">${nome ? `Olá, ${esc(nome)}!` : 'Redefinir sua senha'}</h2>
    <p style="color:#b9bad6;font-size:14px;line-height:1.6;margin:0 0 22px">Recebemos um pedido para redefinir sua senha de jurado no UpDance Festival. O link abaixo vale 30 minutos e é de uso único.</p>
    ${botao(link, 'Criar nova senha')}
    <p style="color:#6f6c94;font-size:12px;margin:24px 0 0">Se não foi você, ignore este e-mail — sua senha atual continua válida.</p>`);
}
