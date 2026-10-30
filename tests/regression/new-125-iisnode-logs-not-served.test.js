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
});
