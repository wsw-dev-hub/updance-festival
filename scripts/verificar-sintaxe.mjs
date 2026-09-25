#!/usr/bin/env node
// Confere a sintaxe de todos os módulos JS (funciona em Windows, macOS e Linux).
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const PASTAS = ['worker', 'src', 'public', 'scripts'];
const arquivos = ['vite.config.js'];
const varrer = (dir) => {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) varrer(p);
    else if (/\.(m?js)$/.test(n)) arquivos.push(p);
  }
};
PASTAS.forEach(varrer);

let falhas = 0;
for (const f of arquivos) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    falhas++;
    console.error(r.stderr);
  }
}
console.log(`${arquivos.length - falhas}/${arquivos.length} arquivos com sintaxe válida.`);
process.exit(falhas ? 1 : 0);
