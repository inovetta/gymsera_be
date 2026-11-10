/**
 * BIOMETRIC_DATA_KEY rotation (src/scripts/rotate-biometric-key.js, runbook secrets-rotation.md 3c).
 * Dry run changes nothing and counts what is on an old key; --apply re-encrypts templates and
 * photos under the first (new) key, each value checked before it is written; a re-run has nothing
 * left; a value no configured key can read stops the run for that tenant, nothing written.
 */
const crypto = require('crypto');
const { createWorld } = require('../harness/zkteco-world');
const bioCrypto = require('../../src/utils/biometric-crypto');
const biometrics = require('../../src/services/devices/biometric.service');
const { rotateTenant } = require('../../src/scripts/rotate-biometric-key');
const fx = require('../fixtures/zkteco/manual-samples');

let w;
let saved;
const K1 = crypto.randomBytes(32).toString('hex');
const K2 = crypto.randomBytes(32).toString('hex');
beforeAll(async () => { saved = process.env.BIOMETRIC_DATA_KEY; w = await createWorld(); });
afterAll(async () => { process.env.BIOMETRIC_DATA_KEY = saved; await w.settled(); await require('../harness').teardownTestDatabases(); });

test('dry run, apply, re-run; old values readable only through the new key afterwards', async () => {
  process.env.BIOMETRIC_DATA_KEY = `1:${K1}`;
  const u = await w.member('Rotating Member');
  await biometrics.recordConsent(w.db1, { memberId: u.id, method: 'in_person' });
  await biometrics.storeTemplates(w.db1, { memberId: u.id, deviceId: null, templates: [{ pin: '1', type: 9, no: 0, index: 0, valid: 1, duress: 0, majorVer: '40', minorVer: '1', format: 0, tmp: fx.TEMPLATE }] });
  await biometrics.storePhoto(w.db1, { tenantId: w.ctx.tenant1.id, memberId: u.id, deviceId: null, photo: { pin: '1', type: 9, kind: 'biophoto', content: fx.PHOTO } });

  process.env.BIOMETRIC_DATA_KEY = `2:${K2},1:${K1}`;
  const dry = await rotateTenant(w.db1, { apply: false });
  expect(dry).toMatchObject({ templates: 1, photos: 1, rotated: 0, unreadable: 0 });
  expect((await w.q(w.db1, 'SELECT key_version FROM member_biometrics WHERE member_id = ?', [u.id]))[0].key_version).toBe(1);

  const done = await rotateTenant(w.db1, { apply: true });
  expect(done).toMatchObject({ templates: 1, photos: 1, rotated: 2, unreadable: 0 });
  const [row] = await w.q(w.db1, 'SELECT key_version, template_enc FROM member_biometrics WHERE member_id = ?', [u.id]);
  expect(row.key_version).toBe(2);
  expect(bioCrypto.versionOf(row.template_enc)).toBe(2);

  process.env.BIOMETRIC_DATA_KEY = `2:${K2}`; // the old key removed
  const [t] = await biometrics.templatesForDelivery(w.db1, [(await w.q(w.db1, 'SELECT id FROM member_biometrics WHERE member_id = ?', [u.id]))[0].id]);
  expect(t.tmp).toBe(fx.TEMPLATE);
  const [p] = await w.q(w.db1, 'SELECT id, key_version FROM member_biometric_photos WHERE member_id = ?', [u.id]);
  expect(p.key_version).toBe(2);
  expect(await biometrics.photoForDelivery(w.db1, p.id)).toBe(fx.PHOTO);
  expect(await rotateTenant(w.db1, { apply: true })).toMatchObject({ templates: 0, photos: 0, rotated: 0 });
});

test('a value no configured key can read: reported, nothing written', async () => {
  process.env.BIOMETRIC_DATA_KEY = `7:${crypto.randomBytes(32).toString('hex')}`;
  const u = await w.member('Lost Key Member');
  await biometrics.recordConsent(w.db1, { memberId: u.id, method: 'in_person' });
  await biometrics.storeTemplates(w.db1, { memberId: u.id, deviceId: null, templates: [{ pin: '1', type: 1, no: 0, index: 0, valid: 1, duress: 0, majorVer: '10', minorVer: '0', format: 0, tmp: fx.TEMPLATE }] });
  process.env.BIOMETRIC_DATA_KEY = `8:${crypto.randomBytes(32).toString('hex')}`;
  const r = await rotateTenant(w.db1, { apply: true });
  expect(r.unreadable).toBeGreaterThanOrEqual(1);
  expect(r.rotated).toBe(0);
  expect((await w.q(w.db1, 'SELECT key_version FROM member_biometrics WHERE member_id = ?', [u.id]))[0].key_version).toBe(7);
});
