/**
 * NEW-125 (P1, security): the API's log files must not be readable over HTTP.
 *
 * web.config had an "iisnode logs" rewrite rule (`^iisnode(?:/.*)?$`, action None), so IIS
 * served the iisnode log folder as static files: https://api.gymsera.com/iisnode/index.html
 * answered 200 and listed the API's live stdout and stderr files (checked 2026-10-30), which
 * hold stack traces and request logs. iisnode still writes the files on the server
 * (loggingEnabled stays on); they are read there, not over HTTP.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const xml = () => fs.readFileSync(path.join(__dirname, '../../web.config'), 'utf8');

describe('NEW-125: the iisnode log folder is not served', () => {
  test('no rewrite rule lets /iisnode through untouched', () => {
    expect(xml()).not.toMatch(/<match url="\^iisnode/);
  });

  test('request filtering hides the iisnode segment, even if such a rule comes back', () => {
    expect(xml()).toMatch(/<hiddenSegments>[\s\S]*<add segment="iisnode" \/>[\s\S]*<\/hiddenSegments>/);
  });

  test('the logs are still written on the server', () => {
    expect(xml()).toMatch(/<iisnode[^>]*loggingEnabled="true"/);
  });

  // P10 item 2: 23 production stdout / stderr files stayed tracked after iisnode/ was ignored,
  // so every clone and every server `git pull` carried them, and a server's new logs showed as
  // local changes that block the pull.
  test('no iisnode log file is tracked in git, and the folder is ignored', () => {
    const root = path.join(__dirname, '../..');
    const tracked = execFileSync('git', ['ls-files', '--', 'iisnode'], { cwd: root, encoding: 'utf8' }).trim();
    expect(tracked).toBe('');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toMatch(/^\/?iisnode\/$/m);
  });
});
