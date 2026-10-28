/**
 * NEW-144: every package the API loads at run time is a production dependency.
 *
 * Before: `axios` (required by src/services/apple-billing.service.js) was only in devDependencies, so the
 * production install (`npm install --omit=dev`) left it out and POST /billing/ios/sync answered 500
 * MODULE_NOT_FOUND "Cannot find module 'axios'".
 * After: this test reads every require() / import in src/, server.js and app.js and fails when a package is
 * not in `dependencies`, or when package-lock.json still marks it (or a package it needs) as dev or
 * devOptional, which is what `--omit=dev` can skip.
 */
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

// A vendored Socket.IO build (used only when the socket.io package is absent). Its requires of
// `bufferutil` / `utf-8-validate` are optional speed-ups inside try/catch, as in the `ws` package.
const VENDORED = new Set([path.join('src', 'socket', 'socket-bundle.js')]);

const sourceFiles = () => {
  const out = ['server.js', 'app.js'];
  const walk = (dir) => {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, name);
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(c|m)?js$/.test(name) && !VENDORED.has(rel)) out.push(rel);
    }
  };
  walk('src');
  return out;
};

/** Package names loaded by a file, ignoring comments, relative paths and Node built-ins. */
const packagesIn = (source) => {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const names = new Set();
  for (const m of code.matchAll(/(?:\brequire\(\s*|\bimport\(\s*|\bfrom\s+)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!builtinModules.includes(name)) names.add(name);
  }
  return names;
};

const runtime = new Map(); // package -> files that load it
for (const file of sourceFiles()) {
  for (const name of packagesIn(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
    if (!runtime.has(name)) runtime.set(name, []);
    runtime.get(name).push(file);
  }
}

/**
 * Lockfile entries the package installs with, and everything they need, resolved as Node does: a nested
 * node_modules folder first, then each parent folder up to the top.
 */
const resolveIn = (fromPath, name) => {
  let base = fromPath;
  for (;;) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!base) return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
};

const closure = (entryPath, seen = new Set()) => {
  if (!entryPath || seen.has(entryPath)) return seen;
  seen.add(entryPath);
  const entry = lock.packages[entryPath];
  for (const dep of Object.keys(entry.dependencies || {})) closure(resolveIn(entryPath, dep), seen);
  return seen;
};

describe('NEW-144: runtime packages survive npm install --omit=dev', () => {
  test('the scan finds the packages the API is known to load', () => {
    for (const name of ['express', 'sequelize', 'axios']) expect(runtime.has(name)).toBe(true);
  });

  test('every package required by src/, server.js or app.js is in dependencies', () => {
    const wrong = [...runtime.entries()]
      .filter(([name]) => !(pkg.dependencies || {})[name])
      .map(([name, files]) => `${name} (${(pkg.devDependencies || {})[name] ? 'devDependencies only' : 'not declared'}; ${files[0]})`);
    expect(wrong).toEqual([]);
  });

  test('package-lock.json installs each of them, and what they need, without --omit=dev skipping it', () => {
    const devOnly = [];
    for (const name of runtime.keys()) {
      for (const entryPath of closure(resolveIn('', name))) {
        const entry = lock.packages[entryPath];
        // devOptional: kept only as somebody's optional extra; a required package must not rely on it.
        if (entry.dev === true || entry.devOptional === true) devOnly.push(`${entryPath} (needed by ${name})`);
      }
    }
    expect([...new Set(devOnly)]).toEqual([]);
  });
});
