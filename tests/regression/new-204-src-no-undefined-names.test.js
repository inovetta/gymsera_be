/**
 * NEW-204: no source file under src/ may use a name that is not defined. Two such names were live
 * bugs: NEW-200 (`safeRedisSet` was imported but never exported; a different check covers imports)
 * and NEW-212 (`Payment` in markPrinted, every call 500). The tenant seeder paid each membership at
 * `branch.id`, a name not in scope, so seeding stopped at the first paid membership.
 *
 * Runs the ESLint CLI (the Node API cannot load inside Jest's VM) with the repo's own config
 * (Node globals included) and only `no-undef` switched on.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');

describe('NEW-204 src/ has no undefined names', () => {
  it('ESLint no-undef finds nothing in src/', () => {
    const bin = path.join(ROOT, 'node_modules/eslint/bin/eslint.js');
    const run = spawnSync(
      process.execPath,
      [bin, 'src', '-f', 'json', '--rule', '{"quotes":"off","semi":"off","no-empty":"off","no-unused-vars":"off"}'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    const results = JSON.parse(run.stdout);
    const undefinedNames = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === 'no-undef')
        .map((m) => `${path.relative(ROOT, r.filePath)}:${m.line} ${m.message}`)
    );
    expect(undefinedNames).toEqual([]);
  }, 120000);

  it('the tenant seeder records each payment at the branch of its membership', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/seeders/seed-tenant.js'), 'utf8');
    const payment = /M\.Payment\.create\(\{([\s\S]*?)\}\);/.exec(src)[1];
    expect(payment).toMatch(/branchId:\s+primaryBranch\.id,/);
  });
});
