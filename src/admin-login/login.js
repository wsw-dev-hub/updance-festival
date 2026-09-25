// Login da organização (administradores do festival).

const $ = (id) => document.getElementById(id);

async function api(metodo, caminho, json) {
  const resp = await fetch(caminho, {
    method: metodo,
    headers: { 'X-UDX-Festival': '1', ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const e = new Error(dados.erro || `Erro ${resp.status}`);
    e.status = resp.status;
    throw e;
  }
  return dados;
}

/** Só aceita voltar para dentro da área de admin. */
function destino() {
  const n = new URLSearchParams(location.search).get('next') || '';
  return /^\/admin(\/|$)/.test(n) && !n.includes('//') ? n : '/admin/';
}

const FOCO = { entrar: 'campo-email', senha: 'campo-nova', setup: 'setup-chave' };

function mostrar(tela) {
  for (const t of Object.keys(FOCO)) $(`tela-${t}`).hidden = t !== tela;
  $(FOCO[tela]).focus();
}

async function iniciar() {
  document.querySelectorAll('.olho').forEach((b) =>
    b.addEventListener('click', () => {
      const alvo = $(b.dataset.alvo);
      alvo.type = alvo.type === 'password' ? 'text' : 'password';
    }),
  );

  $('form-entrar').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('btn-entrar').disabled = true;
    $('msg-entrar').className = 'mensagem';
    $('msg-entrar').textContent = '';
    try {
      const r = await api('POST', '/api/admin/login', { email: $('campo-email').value.trim(), password: $('campo-senha').value });
      $('campo-senha').value = '';
      if (r.trocar_senha) {
        $('senha-usuario').value = r.email;
        mostrar('senha');
      } else location.href = destino();
    } catch (err) {
      $('msg-entrar').textContent = err.message;
    } finally {
      $('btn-entrar').disabled = false;
    }
  });

  $('form-senha').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('campo-nova').value !== $('campo-confirma').value) {
      $('msg-senha').textContent = 'As senhas não conferem.';
      return;
    }
    $('btn-salvar').disabled = true;
    try {
      await api('POST', '/api/admin/senha', { nova: $('campo-nova').value });
      location.href = destino();
    } catch (err) {
      if (err.status === 401) return mostrar('entrar');
      $('msg-senha').textContent = err.message;
    } finally {
      $('btn-salvar').disabled = false;
    }
  });

  // Primeiro acesso / recuperação: POST /api/admin/setup (mesmo padrão do blog)
  $('btn-ir-setup').addEventListener('click', () => mostrar('setup'));
  $('btn-voltar-login').addEventListener('click', () => mostrar('entrar'));
  $('form-setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('btn-setup').disabled = true;
    $('msg-setup').textContent = '';
    try {
      const email = $('setup-email').value.trim();
      const r = await api('POST', '/api/admin/setup', {
        setup_key: $('setup-chave').value,
        nome: $('setup-nome').value.trim(),
        email,
        password: $('setup-senha').value,
      });
      $('form-setup').reset();
      $('campo-email').value = email;
      mostrar('entrar');
      $('campo-senha').focus();
      $('msg-entrar').className = 'mensagem ok';
      $('msg-entrar').textContent = r.criado ? 'Administrador criado. Entre com a senha que você definiu.' : 'Senha redefinida. Entre com a nova senha.';
    } catch (err) {
      $('msg-setup').textContent = err.message;
    } finally {
      $('btn-setup').disabled = false;
    }
  });

  // Já está logado?
  try {
    const eu = await api('GET', '/api/admin/me');
    if (eu.trocar_senha) {
      $('senha-usuario').value = eu.email;
      mostrar('senha');
    } else location.href = destino();
  } catch {
    mostrar('entrar');
  }
}

iniciar();
