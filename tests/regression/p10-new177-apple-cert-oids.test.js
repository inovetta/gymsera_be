/**
 * NEW-177 (P10 item 7, R-82): Apple signed-payload certificates carry Apple's own markers.
 *
 * Before: apple-billing.service.js `_verifyCertChain` checked each link's signature and dates
 * and that the chain ends at the pinned Apple Root CA - G3, but not what Apple's App Store
 * Server Library also requires: the leaf has the App Store receipt-signing extension
 * (OID 1.2.840.113635.100.6.11.1) and is not a CA; the intermediate has the Apple WWDR
 * intermediate extension (OID 1.2.840.113635.100.6.2.1) and is a CA. Without them, any
 * certificate Apple's root ever issued (directly or through a CA) would be accepted as an
 * App Store signer.
 *
 * Chains are made with openssl at run time (no private key is committed); the root is pinned
 * through the test-only option, the real code always pins Apple's root.
 * Revocation (OCSP) is not checked: it is a network call on every verification; recorded in §13.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _verifyCertChain, verifyAndDecode } = require('../../src/services/apple-billing.service');

const LEAF_OID = '1.2.840.113635.100.6.11.1';
const INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

describe('NEW-177: Apple certificate chain markers', () => {
  let dir;
  const file = (name) => path.join(dir, name);
  const ssl = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  const key = (name) => ssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`]);
  const ext = (name, lines) => fs.writeFileSync(file(`${name}.ext`), `[v3]\n${lines.join('\n')}\n`);
  const issue = (name, issuer, lines) => {
    key(name);
    fs.writeFileSync(file('req.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n');
    ssl(['req', '-new', '-key', `${name}.key`, '-subj', `/CN=${name}`, '-out', `${name}.csr`, '-config', 'req.cnf']);
    ext(name, lines);
    ssl(['x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-set_serial', String(Date.now()),
      '-days', '30', '-out', `${name}.pem`, '-extfile', `${name}.ext`, '-extensions', 'v3']);
  };
  const b64 = (name) => fs.readFileSync(file(`${name}.pem`), 'utf8').replace(/-----[^-]+-----|\s/g, '');
  const rootPem = () => fs.readFileSync(file('root.pem'), 'utf8');
  const verify = (names) => _verifyCertChain(names.map(b64), { rootPem: rootPem() });
  const rejects = (names, pattern) => {
    expect(() => verify(names)).toThrow(pattern);
    try {
      verify(names);
    } catch (err) {
      expect(err.statusCode).toBe(401);
    }
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new177-'));
    key('root');
    fs.writeFileSync(file('root.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\n[v3]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n');
    ssl(['req', '-x509', '-new', '-key', 'root.key', '-subj', '/CN=Test Root', '-days', '30', '-out', 'root.pem', '-config', 'root.cnf']);
    const ca = ['basicConstraints=critical,CA:true', 'keyUsage=critical,keyCertSign,cRLSign'];
    const endEntity = ['basicConstraints=critical,CA:false', 'keyUsage=critical,digitalSignature'];
    issue('wwdr', 'root', [...ca, `${INTERMEDIATE_OID}=ASN1:NULL`]);
    issue('wwdrNoOid', 'root', ca);
    issue('wwdrNotCa', 'root', [...endEntity, `${INTERMEDIATE_OID}=ASN1:NULL`]);
    issue('leaf', 'wwdr', [...endEntity, `${LEAF_OID}=ASN1:NULL`]);
    issue('leafNoOid', 'wwdr', endEntity);
    issue('leafIsCa', 'wwdr', [...ca, `${LEAF_OID}=ASN1:NULL`]);
    issue('leafOfNoOid', 'wwdrNoOid', [...endEntity, `${LEAF_OID}=ASN1:NULL`]);
    issue('leafOfNotCa', 'wwdrNotCa', [...endEntity, `${LEAF_OID}=ASN1:NULL`]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('an Apple-shaped chain (leaf, intermediate, root) verifies and returns the leaf', () => {
    const leaf = verify(['leaf', 'wwdr', 'root']);
    expect(leaf.subject).toMatch(/CN=leaf/);
  });

  test('a leaf without the App Store receipt-signing extension is refused', () => {
    rejects(['leafNoOid', 'wwdr', 'root'], /App Store signing certificate/);
  });

  test('a leaf that is itself a CA is refused', () => {
    rejects(['leafIsCa', 'wwdr', 'root'], /App Store signing certificate/);
  });

  test('an intermediate without the Apple WWDR extension is refused', () => {
    rejects(['leafOfNoOid', 'wwdrNoOid', 'root'], /intermediate/);
  });

  test('an intermediate that is not a CA is refused', () => {
    rejects(['leafOfNotCa', 'wwdrNotCa', 'root'], /intermediate/);
  });

  test('a chain of the wrong length is refused (Apple sends exactly leaf, intermediate, root)', () => {
    rejects(['leaf'], /certificate chain/);
    rejects(['leaf', 'wwdr'], /certificate chain/);
  });

  test('still refused as before: a chain that does not end at the pinned root', () => {
    expect(() => _verifyCertChain(['leaf', 'wwdr', 'root'].map(b64))).toThrow(/Apple|verify/);
  });

  test('verifyAndDecode always pins Apple\'s root: a test chain never decodes', () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ a: 1 }, fs.readFileSync(file('leaf.key')), {
      algorithm: 'ES256',
      header: { alg: 'ES256', x5c: ['leaf', 'wwdr', 'root'].map(b64) },
    });
    expect(() => verifyAndDecode(token)).toThrow();
  });
});
