/**
 * NEW-204: CI runs ESLint on src/ before the tests, so an undefined name (NEW-200, NEW-212) or a
 * new lint error fails the build. tests/, scripts/ and the root one-off scripts are not linted yet
 * (post-launch item, spec §13 P10b).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

describe('NEW-204 lint in CI', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

  it('package.json has lint:src = eslint src', () => {
    expect(pkg.scripts['lint:src']).toBe('eslint src');
  });

  it('the CI workflow runs npm run lint:src before npm test', () => {
    const lintAt = ci.indexOf('run: npm run lint:src');
    const testAt = ci.indexOf('run: npm test');
    expect(lintAt).toBeGreaterThan(-1);
    expect(lintAt).toBeLessThan(testAt);
  });
});
