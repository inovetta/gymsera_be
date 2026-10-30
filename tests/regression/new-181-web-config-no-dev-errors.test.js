/**
 * NEW-181 (P2): production must never show a stack trace.
 *
 * web.config set `devErrorsEnabled="true"` on the iisnode element, so when the API process
 * crashed or failed to start, iisnode answered the request with the stack trace and
 * environment details. Every *.config template in the repo is checked, not only web.config.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const configFiles = () =>
  fs
    .readdirSync(ROOT)
    .filter((f) => /\.config(\..+)?$/i.test(f) || /^web\.config/i.test(f))
    .map((f) => path.join(ROOT, f));

describe('NEW-181: iisnode never shows a stack trace', () => {
  test('web.config exists and is the only IIS config template', () => {
    expect(configFiles().map((f) => path.basename(f))).toContain('web.config');
  });

  test.each(['web.config'])('%s: iisnode dev errors are off', (name) => {
    const xml = fs.readFileSync(path.join(ROOT, name), 'utf8');
    expect(xml).toMatch(/<iisnode[^>]*devErrorsEnabled="false"/);
    expect(xml).not.toMatch(/devErrorsEnabled="true"/i);
  });

  test('no config template turns dev errors on', () => {
    for (const f of configFiles()) {
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/devErrorsEnabled="true"/i);
    }
  });
});
