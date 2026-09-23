// Tema claro/escuro no padrão do ecossistema UpDance: atributo data-bs-theme no <html>.
// Carregado de forma síncrona no <head> (anti-FOUC). Escuro é o padrão.
(function () {
  var CHAVE = 'udx-theme';
  var raiz = document.documentElement;
  function ler() {
    try { var t = localStorage.getItem(CHAVE); return t === 'light' || t === 'dark' ? t : 'dark'; } catch (e) { return 'dark'; }
  }
  function aplicar(t) {
    raiz.setAttribute('data-bs-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#f6f3fa' : '#02021a');
  }
  aplicar(ler());
  window.udxSetTheme = function (t) {
    aplicar(t);
    try { localStorage.setItem(CHAVE, t); } catch (e) { /* sem armazenamento */ }
  };
  window.udxToggleTheme = function () {
    window.udxSetTheme(raiz.getAttribute('data-bs-theme') === 'light' ? 'dark' : 'light');
  };
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('btnTema');
    if (b) b.addEventListener('click', window.udxToggleTheme);
  });

  // Ícones MDI vêm de CDN. Se não carregarem (rede ruim no local do evento),
  // os botões só com ícone passam a mostrar um rótulo em texto (classe .sem-icones).
  window.addEventListener('load', function () {
    if (!document.fonts || !document.fonts.load) return;
    var limite = new Promise(function (r) { setTimeout(function () { r([]); }, 4000); });
    Promise.race([document.fonts.load('24px "Material Design Icons"'), limite])
      .then(function (faces) { if (!faces || !faces.length) raiz.classList.add('sem-icones'); })
      .catch(function () { raiz.classList.add('sem-icones'); });
  });
})();
