/**
 * NEW-303 M3 (audit F2, same defect as BUG-09): a lookup of "the first" business, branch or gym with no ORDER BY
 * answers whichever row MySQL returns, which changes once an organization has two businesses. Every
 * `GymListing / Gym / Branch / MembershipPlan .findOne` that is not keyed by its own id or a business id must order.
 */
const fs = require('fs');
const path = require('path');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
});

test('no unordered first-row lookup of a business, gym, branch or plan in src', () => {
  const offenders = [];
  for (const file of walk(path.join(__dirname, '../../src'))) {
    if (file.includes(`${path.sep}scripts${path.sep}`)) continue; // one-off repair scripts name their own rows
    const text = fs.readFileSync(file, 'utf8');
    const re = /\b(?:GymListing|Gym|Branch|MembershipPlan)\.findOne\(/g;
    let m;
    while ((m = re.exec(text))) {
      const rest = text.slice(m.index);
      const call = rest.slice(0, rest.indexOf(');') > -1 ? rest.indexOf(');') : 400);
      if (/order\s*:/.test(call)) continue;
      // keyed by its own id (or by a business / branch id, and a plan name for one branch): a single-row lookup
      if (/where:\s*\{\s*(?:id|\[Op\.or\])/.test(call) || /where:\s*\{\s*id\s*:/.test(call)) continue;
      if (/where:\s*\{\s*(?:id|businessId|branchId)\b/.test(call) && !/organizationId\s*[,}]/.test(call.replace(/organizationId:\s*\w+/g, ''))) {
        if (/where:\s*\{\s*(?:id|businessId|branchId)\b/.test(call)) continue;
      }
      offenders.push(`${path.relative(path.join(__dirname, '../..'), file)}: ${call.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
  expect(offenders).toEqual([]);
});
