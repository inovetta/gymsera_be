/**
 * P9c (A): payment proofs and KYC documents live in storage/private on a server without R2
 * (R-27). Today every URL is rewritten to Node, so IIS serves nothing from disk; request filtering
 * hides the `storage` segment as well, so the files stay unreachable over HTTP even if a static
 * rewrite rule comes back (the way NEW-125's iisnode folder was exposed).
 */
const fs = require('fs');
const path = require('path');

const xml = () => fs.readFileSync(path.join(__dirname, '../../web.config'), 'utf8');

describe('P9c: the private store is never served by IIS', () => {
  test('request filtering hides the storage segment', () => {
    expect(xml()).toMatch(/<hiddenSegments>[\s\S]*<add segment="storage" \/>[\s\S]*<\/hiddenSegments>/);
  });

  test('every request goes to Node (no rule serves files from disk)', () => {
    expect(xml()).toMatch(/<rule name="Node.js application" stopProcessing="true">\s*<match url="\.\*" \/>/);
  });

  test('the private store directory is ignored by git', () => {
    expect(fs.readFileSync(path.join(__dirname, '../../.gitignore'), 'utf8')).toMatch(/^\/?storage\/$/m);
  });
});
