// Utilitários criptográficos (Web Crypto, nativo do Workers).

export function b64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(dados) {
  const buf = typeof dados === 'string' ? new TextEncoder().encode(dados) : dados;
  return hex(await crypto.subtle.digest('SHA-256', buf));
}

/** Bytes aleatórios em base64url (ids, tokens de entrega). */
export function aleatorio(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
