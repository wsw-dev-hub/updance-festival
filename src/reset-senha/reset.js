// Nova senha a partir do link do e-mail (POST /api/member/reset, padrão do blog UpDance).
const $ = (id) => document.getElementById(id);

// Tira o token da barra de endereço (não fica no histórico nem em capturas de tela)
const token = new URLSearchParams(location.search).get('token') || '';
history.replaceState(null, '', location.pathname);

if (!/^[0-9a-f]{64}$/.test(token)) {
  $('form-reset').hidden = true;
  $('reset-texto').textContent = 'Link inválido. Peça um novo em "Esqueci minha senha", na tela de login do app.';
  $('link-app').hidden = false;
}

$('form-reset').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('msg-reset');
  msg.className = 'mensagem';
  if ($('campo-nova').value !== $('campo-confirma').value) {
    msg.textContent = 'As senhas não conferem.';
    return;
  }
  $('btn-salvar').disabled = true;
  try {
    const resp = await fetch('/api/member/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-UDX-Festival': '1' },
      body: JSON.stringify({ token, password: $('campo-nova').value }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const d = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(d.erro || `Erro ${resp.status}`);
    $('form-reset').hidden = true;
    $('reset-texto').textContent = 'Senha alterada. Entre no app com a nova senha.';
    $('link-app').hidden = false;
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    $('btn-salvar').disabled = false;
  }
});
