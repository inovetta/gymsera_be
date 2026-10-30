/**
 * Phase 7 P8, owner decision R-72 (D1, BUG-06): the product is "GymsEra", one spelling everywhere.
 *
 * Fails if a banned variant ("Gymsera", "Gyms Era", "GymConnect", "Gym Connect") appears in the
 * backend's source, e-mail templates or push copy. Identifiers and hosts are not copy: GymseraCard,
 * gymsera.com, gymsera_be, GYMSERA_ENV do not match.
 */
const fs = require('fs');
const path = require('path');

const BANNED = /\bGymsera\b|\bGyms Era\b|GymConnect|Gym Connect/;
const ROOTS = ['src', 'templates', 'views'].map((d) => path.join(__dirname, '../..', d)).filter((d) => fs.existsSync(d));

const files = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p);
    return /\.(js|html|hbs|ejs|json|txt)$/.test(e.name) ? [p] : [];
  });

describe('R-72: one product name, GymsEra', () => {
  test('no banned spelling in backend source, templates or copy', () => {
    const hits = [];
    for (const root of ROOTS) {
      for (const f of files(root)) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          if (BANNED.test(line)) hits.push(`${path.relative(path.join(__dirname, '../..'), f)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });

  test('the guard catches each banned spelling and lets identifiers through', () => {
    for (const s of ["'Gymsera Host'", 'Welcome to Gyms Era', 'GymConnect', 'Gym Connect']) expect(BANNED.test(s)).toBe(true);
    for (const s of ['GymsEra', 'GymseraCard', 'gymsera.com', 'GYMSERA_ENV', 'gymsera_be']) expect(BANNED.test(s)).toBe(false);
  });
});
