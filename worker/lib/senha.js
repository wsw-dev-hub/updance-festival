// Senhas: PBKDF2-SHA256 (Web Crypto nativo do Workers) com sal individual de 16 bytes.
// O número de iterações fica gravado junto do hash, para poder ser aumentado no futuro
// sem invalidar senhas antigas.

import { b64url, b64urlDecode } from './cripto.js';
import { ErroHttp } from './http.js';

export const SENHA_MIN = 8;
export const SENHA_MAX = 128;
const enc = new TextEncoder();

/** Iterações (configurável por PBKDF2_ITERACOES; o Workers aceita no máximo 100.000). */
export function iteracoes(env) {
  const n = Number.parseInt(env?.PBKDF2_ITERACOES || '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 10_000), 100_000) : 100_000;
}

async function derivar(senha, salBytes, iter) {
  const chave = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salBytes, iterations: iter }, chave, 256);
  return new Uint8Array(bits);
}

export function validarSenhaNova(senha) {
  if (typeof senha !== 'string' || senha.length < SENHA_MIN) {
    throw new ErroHttp(422, `A senha precisa ter pelo menos ${SENHA_MIN} caracteres`, 'senha_curta');
  }
  if (senha.length > SENHA_MAX) throw new ErroHttp(422, 'Senha longa demais', 'senha_longa');
  if (!/[A-Za-z]/.test(senha) || !/\d/.test(senha)) {
    throw new ErroHttp(422, 'Use letras e números na senha', 'senha_fraca');
  }
}

export async function gerarHash(senha, env) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const iter = iteracoes(env);
  const hash = await derivar(senha, sal, iter);
  return { senha_hash: b64url(hash), senha_sal: b64url(sal), senha_iter: iter };
}

/** Compara em tempo constante. */
export async function conferir(senha, conta) {
  if (typeof senha !== 'string' || senha.length > SENHA_MAX) return false;
  const calculado = await derivar(senha, b64urlDecode(conta.senha_sal), conta.senha_iter);
  const esperado = b64urlDecode(conta.senha_hash);
  if (calculado.length !== esperado.length) return false;
  let diff = 0;
  for (let i = 0; i < calculado.length; i++) diff |= calculado[i] ^ esperado[i];
  return diff === 0;
}

/** Custo equivalente a uma conferência real (e-mail inexistente não responde mais rápido). */
export async function conferirFicticio(env) {
  await derivar('senha-ficticia', new Uint8Array(16), iteracoes(env));
  return false;
}

/** Senha provisória legível (sem 0/O, 1/l/I): 3 blocos de 4, ex.: "k7mq-9txe-r4bw". */
export function gerarSenhaProvisoria() {
  const alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (let i = 0; i < 12; i++) {
    s += alfabeto[bytes[i] % alfabeto.length];
    if (i === 3 || i === 7) s += '-';
  }
  // garante letra e número
  return /\d/.test(s) && /[a-z]/.test(s) ? s : gerarSenhaProvisoria();
}
