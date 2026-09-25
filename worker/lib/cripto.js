// Utilitários criptográficos (Web Crypto, nativo do Workers).

const enc = new TextEncoder();

export function b64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(dados) {
  const buf = typeof dados === 'string' ? enc.encode(dados) : dados;
  return hex(await crypto.subtle.digest('SHA-256', buf));
}

/** Bytes aleatórios em base64url (ids, tokens de entrega). */
export function aleatorio(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Token hexadecimal aleatório (mesmo formato do blog: sids de sessão, tokens de redefinição). */
export function randomToken(bytes = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Comparação em tempo constante de duas strings. */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let r = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}
