// Diagnóstico e orientação para liberar o microfone em cada plataforma.

/** Identifica sistema, navegador e navegadores internos de apps (Instagram, Facebook...). */
export function detectarPlataforma(ua = navigator.userAgent, toque = navigator.maxTouchPoints || 0) {
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && toque > 1); // iPad se identifica como Mac
  const android = /Android/i.test(ua);
  const so = ios ? 'ios' : android ? 'android' : /Mac OS X/i.test(ua) ? 'mac' : /Windows/i.test(ua) ? 'windows' : /Linux/i.test(ua) ? 'linux' : 'outro';

  let navegador = 'outro';
  if (/SamsungBrowser/i.test(ua)) navegador = 'samsung';
  else if (/Edg(e|A|iOS)?\//i.test(ua)) navegador = 'edge';
  else if (/Firefox|FxiOS/i.test(ua)) navegador = 'firefox';
  else if (/CriOS|Chrome\//i.test(ua)) navegador = 'chrome';
  else if (/Safari/i.test(ua)) navegador = 'safari';

  const internos = [
    [/Instagram/i, 'Instagram'],
    [/FBAN|FBAV|FB_IAB/i, 'Facebook'],
    [/Messenger|FBMS/i, 'Messenger'],
    [/Line\//i, 'Line'],
    [/MicroMessenger/i, 'WeChat'],
    [/TikTok|musical_ly|BytedanceWebview/i, 'TikTok'],
    [/Twitter/i, 'X/Twitter'],
    [/LinkedInApp/i, 'LinkedIn'],
    [/Telegram/i, 'Telegram'],
  ];
  const appInterno = internos.find(([re]) => re.test(ua))?.[1] || null;
  // WebView genérico do Android ("; wv)") também costuma bloquear o microfone
  const webview = android && /; wv\)/.test(ua);

  return { so, navegador, appInterno, webview, movel: ios || android };
}

/**
 * Problemas que impedem ou atrapalham o uso do microfone, antes mesmo de pedir permissão.
 * @returns {{fatal: boolean, titulo: string, passos: string[]}[]}
 */
export function verificarAmbiente(p = detectarPlataforma()) {
  const problemas = [];
  if (!window.isSecureContext) {
    problemas.push({
      fatal: true,
      titulo: 'Endereço sem HTTPS',
      passos: ['O navegador só libera o microfone em endereços https://. Abra o link oficial enviado pela organização.'],
    });
  }
  if (p.appInterno || p.webview) {
    problemas.push({
      fatal: false,
      titulo: `Você está no navegador interno ${p.appInterno ? `do ${p.appInterno}` : 'de um aplicativo'}`,
      passos: [
        p.so === 'ios'
          ? 'Toque em ··· (ou no ícone de compartilhar) e escolha "Abrir no Safari".'
          : 'Toque em ⋮ (canto superior) e escolha "Abrir no Chrome" ou "Abrir no navegador".',
        'Navegadores internos de aplicativos costumam bloquear o microfone.',
      ],
    });
  }
  if (window.isSecureContext && !(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)) {
    problemas.push({
      fatal: true,
      titulo: 'Este navegador não grava áudio',
      passos: [p.so === 'ios' ? 'Atualize o iPhone (iOS 14.5 ou mais recente) e use o Safari.' : 'Use o Chrome, Edge, Firefox ou Safari atualizados.'],
    });
  }
  return problemas;
}

/** Estado da permissão sem abrir o pedido: granted | denied | prompt | desconhecido. */
export async function estadoPermissao(aoMudar) {
  try {
    const st = await navigator.permissions.query({ name: 'microphone' });
    if (aoMudar) st.onchange = () => aoMudar(st.state);
    return st.state;
  } catch {
    return 'desconhecido'; // Safari antigo e alguns navegadores não informam
  }
}

/** Passos para liberar o microfone depois de negado, por plataforma. */
export function passosParaLiberar(p = detectarPlataforma()) {
  const recarregar = 'Depois, volte aqui e toque em "Tentar de novo" (ou recarregue a página).';
  if (p.so === 'ios') {
    if (p.navegador === 'safari') {
      return [
        'Toque em "aA" (ou no ícone à esquerda do endereço).',
        'Escolha "Ajustes do Site" → Microfone → "Permitir".',
        'Se não aparecer: Ajustes do iPhone → Apps → Safari → Microfone → "Permitir".',
        recarregar,
      ];
    }
    const app = { chrome: 'Chrome', firefox: 'Firefox', edge: 'Edge' }[p.navegador] || 'o navegador';
    return [`Abra os Ajustes do iPhone → Apps → ${app} → ative "Microfone".`, recarregar];
  }
  if (p.so === 'android') {
    const app = p.navegador === 'samsung' ? 'Samsung Internet' : p.navegador === 'firefox' ? 'Firefox' : p.navegador === 'edge' ? 'Edge' : 'Chrome';
    return [
      'Toque no ícone à esquerda do endereço (cadeado ou ajustes).',
      'Toque em "Permissões" → Microfone → "Permitir".',
      `Se continuar bloqueado: Configurações do Android → Apps → ${app} → Permissões → Microfone → "Permitir durante o uso do app".`,
      recarregar,
    ];
  }
  // Computadores
  const passos =
    p.navegador === 'firefox'
      ? ['Clique no ícone de microfone riscado na barra de endereço e remova o bloqueio.']
      : p.navegador === 'safari'
        ? ['Menu Safari → Ajustes → Sites → Microfone → escolha "Permitir" para este site.']
        : ['Clique no ícone à esquerda do endereço (cadeado ou ajustes) → Microfone → "Permitir".'];
  if (p.so === 'mac') passos.push('No Mac: Ajustes do Sistema → Privacidade e Segurança → Microfone → ative o navegador (pode pedir para reabrir).');
  if (p.so === 'windows') passos.push('No Windows: Configurações → Privacidade e segurança → Microfone → ative "Acesso ao microfone" e "Permitir que aplicativos da área de trabalho acessem".');
  passos.push(recarregar);
  return passos;
}

/** Transforma o erro do getUserMedia em explicação e passos em português. */
export function explicarErroMicrofone(erro, p = detectarPlataforma()) {
  const nome = erro?.name || '';
  switch (nome) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return { titulo: 'O microfone foi bloqueado', passos: passosParaLiberar(p) };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        titulo: 'Nenhum microfone encontrado',
        passos: ['Conecte um microfone ou fone com microfone.', 'Se for Bluetooth, confira se está pareado e ligado.', 'Depois toque em "Tentar de novo".'],
      };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        titulo: 'O microfone está ocupado',
        passos: [
          'Outro aplicativo está usando o microfone (ligação, WhatsApp, gravador, videochamada).',
          'Feche esse aplicativo ou encerre a chamada.',
          p.movel ? 'Se persistir, feche e reabra o navegador.' : 'Se persistir, feche outras abas que usam o microfone.',
          'Depois toque em "Tentar de novo".',
        ],
      };
    case 'SecurityError':
      return { titulo: 'Bloqueado por segurança', passos: ['Abra o endereço oficial (https://) enviado pela organização, no Chrome ou Safari.'] };
    default:
      return {
        titulo: 'Não foi possível usar o microfone',
        passos: [`Detalhe técnico: ${nome || 'erro'} ${erro?.message || ''}`.trim(), ...passosParaLiberar(p)],
      };
  }
}
