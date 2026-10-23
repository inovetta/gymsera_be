/**
 * Dependabot (high): follow-redirects 1.16.0 leaks credential headers on cross-origin redirects
 * (GHSA-q3jh-wrc6-jgq8, GHSA-8r9p-f939-6h3c). It reaches the API through axios; 1.16.1 is the fixed version.
 * The lockfile and the installed copy must both be at or above it.
 *
 * Dependabot (high): braces (every version; stack exhaustion on deeply nested patterns) reached the repo only through
 * nodemon -> chokidar. There is no patched braces release, so nodemon is gone: `npm run dev` uses `node --watch`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const atLeast = (version, min) => {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

describe('Dependabot: follow-redirects', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

  test('every locked copy of follow-redirects is 1.16.1 or newer', () => {
    const copies = Object.entries(lock.packages).filter(([k]) => k.endsWith('node_modules/follow-redirects'));
    expect(copies.length).toBeGreaterThan(0);
    for (const [key, pkg] of copies) expect([key, atLeast(pkg.version, '1.16.1')]).toEqual([key, true]);
  });

  test('the installed copy is 1.16.1 or newer', () => {
    const { version } = require('follow-redirects/package.json');
    expect(atLeast(version, '1.16.1')).toBe(true);
  });

  test('nodemon is gone, so braces and chokidar are no longer in the tree; `npm run dev` uses node --watch', () => {
    const pkg = require('../../package.json');
    expect(pkg.dependencies.nodemon).toBeUndefined();
    expect(pkg.devDependencies.nodemon).toBeUndefined();
    expect(pkg.scripts.dev).toBe('node --watch server.js');
    const locked = Object.keys(lock.packages);
    expect(locked.filter((k) => /node_modules\/(nodemon|braces|chokidar)$/.test(k))).toEqual([]);
  });
});
