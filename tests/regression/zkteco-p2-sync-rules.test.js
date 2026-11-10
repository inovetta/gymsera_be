/**
 * ZKTeco Phase 2: the pure sync rules (spec ZKTECO_PUSH_DEVICE_SYNC.md §7.1 to §7.4, §8.1).
 * No database: event classes, return-code actions and backoff, the on-device validity window in
 * branch time, the desired record and its hash, version matching with the photo fallback, and the
 * command plan (add, update, remove). Golden command strings for the new builders.
 */
const rules = require('../../src/services/devices/sync-rules');
const protocol = require('../../src/services/devices/push-protocol');

const CAPS = {
  MultiBioDataSupport: '0:1:1:0:0:0:0:0:0:1:0',
  MultiBioPhotoSupport: '0:0:0:0:0:0:0:0:0:1:0',
  MultiBioVersion: '0:10.0:0:0:0:0:0:0:0:40.1:0',
  DateFmtFunOn: '1',
};

describe('event classes (§7.3)', () => {
  test.each([
    [0, 'granted'], [19, 'granted'], [200, 'granted'], [253, 'granted'],
    [20, 'denied'], [27, 'denied'], [99, 'denied'], [5000, 'denied'], [5999, 'denied'],
    [100, 'alarm'], [199, 'alarm'], [6000, 'alarm'], [6999, 'alarm'],
    [254, 'other'], [4000, 'other'], [7000, 'other'], [NaN, 'other'],
  ])('event %s → %s', (code, cls) => expect(rules.classifyEvent(code)).toBe(cls));

  test('denied reasons the live feed shows', () => {
    expect(rules.deniedReason(27)).toBe('not_registered');
    expect(rules.deniedReason(29)).toBe('expired');
    expect(rules.deniedReason(22)).toBe('wrong_time');
    expect(rules.deniedReason(23)).toBe('unauthorized');
    expect(rules.deniedReason(41)).toBe('denied');
  });
});

describe('return codes (§8.1 table)', () => {
  test.each([
    [0, 'ok'], [5, 'ok'], [-7, 'ok'],
    [-26, 'empty_template'], [-27, 'unknown_pin'], [-30, 'version_mismatch'],
    [-18, 'storage_full'], [-3, 'storage_full'], [-604, 'storage_full'],
    [-708, 'unsupported'],
    [-1, 'transient'], [-2, 'transient'], [-12, 'transient'], [-725, 'transient'], [-730, 'transient'],
    [-999, 'unknown'], [-4, 'unknown'],
  ])('Return=%s → %s', (code, action) => expect(rules.returnAction(code)).toBe(action));

  test('backoff 30 s, 2 min, 10 min, 1 h, then give up', () => {
    expect([1, 2, 3, 4].map(rules.backoffSeconds)).toEqual([30, 120, 600, 3600]);
    expect(rules.backoffSeconds(5)).toBeNull();
  });
});

describe('bio support and versions', () => {
  test('types and photo types from the device bits; major version per type', () => {
    const s = rules.bioSupport(CAPS);
    expect([...s.types].sort()).toEqual([1, 2, 9]);
    expect([...s.photoTypes]).toEqual([9]);
    expect(s.majorFor(9)).toBe('40');
    expect(s.majorFor(1)).toBe('10');
    expect(s.majorFor(10)).toBeNull();
  });
  test('a device that sent no capabilities supports nothing (never guess)', () => {
    const s = rules.bioSupport({});
    expect(s.types.size).toBe(0);
  });
});

describe('validity window in branch time (§7.1, §7.4)', () => {
  test('start 00:00:00, end 23:59:59 of the end date; OUT devices add the exit grace', () => {
    const w = rules.packageWindow({ startDate: '2025-11-01', endDate: '2025-11-30', timezone: 'Asia/Karachi', direction: 'in', exitGraceHours: 24 });
    expect(w).toEqual({
      start: { year: 2025, month: 11, day: 1, hour: 0, minute: 0, second: 0 },
      end: { year: 2025, month: 11, day: 30, hour: 23, minute: 59, second: 59 },
    });
    const out = rules.packageWindow({ startDate: '2025-11-01', endDate: '2025-11-30', timezone: 'Asia/Karachi', direction: 'out', exitGraceHours: 24 });
    expect(out.end).toEqual({ year: 2025, month: 12, day: 1, hour: 23, minute: 59, second: 59 });
  });
  test('the exit grace is real hours: across a DST change the local end moves by the clock change', () => {
    // Europe/London leaves summer time on 2025-10-26.
    const out = rules.packageWindow({ startDate: '2025-10-01', endDate: '2025-10-25', timezone: 'Europe/London', direction: 'out', exitGraceHours: 24 });
    expect(out.end).toMatchObject({ month: 10, day: 26, hour: 22, minute: 59, second: 59 });
  });
  test('the instant a package ends, in the branch zone', () => {
    expect(rules.packageEndsAt('2025-11-30', 'Asia/Karachi').toISOString()).toBe('2025-11-30T19:00:00.000Z');
  });
});

describe('desired record and hash (§7.1)', () => {
  const base = {
    pin: 1001,
    name: '  A very long member name that is over twenty four  ',
    cardNo: '12345',
    window: rules.packageWindow({ startDate: '2025-11-01', endDate: '2025-11-30', timezone: 'Asia/Karachi', direction: 'in', exitGraceHours: 24 }),
    caps: CAPS,
    device: { timezone_id: 1, door_mask: 1 },
    settings: { endTimeFormat: 'auto', sendUserAuthorize: true, photoFallback: true, sendUserPic: false },
    biometrics: [
      { id: 'b-face', bio_type: 9, bio_no: 0, bio_index: 0, major_ver: '40', minor_ver: '1', format: 0, duress: 0, valid: 1, template_sha256: 'f'.repeat(64) },
      { id: 'b-fp', bio_type: 1, bio_no: 6, bio_index: 0, major_ver: '10', minor_ver: '0', format: 0, duress: 0, valid: 1, template_sha256: 'a'.repeat(64) },
      { id: 'b-palm', bio_type: 10, bio_no: 0, bio_index: 0, major_ver: '1', minor_ver: '0', format: 0, duress: 0, valid: 1, template_sha256: 'c'.repeat(64) },
    ],
    photos: [{ id: 'p-face', bio_type: 9, kind: 'biophoto', sha256: 'e'.repeat(64) }],
    incompatible: [],
  };

  test('name trimmed to 24, card, privilege 0 always, window, authorize, only supported matching templates', () => {
    const r = rules.desiredRecord(base);
    expect(r.name).toBe('A very long member name ');
    expect(r.name.length).toBeLessThanOrEqual(24);
    expect(r).toMatchObject({ pin: '1001', cardNo: '12345', dateFormat: 'seconds', auth: { timezoneId: 1, doorMask: 1 } });
    expect(r.bio.map((b) => b.type)).toEqual([1, 9]); // palm 10: the device does not support it
    expect(r.photos).toEqual([]); // the face template matches: no fallback
    expect(JSON.stringify(r)).not.toMatch(/Tmp|tmp=/);
    expect(rules.hashOf(r)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the hash is stable and changes with the window, the card or a template', () => {
    const h = rules.hashOf(rules.desiredRecord(base));
    expect(rules.hashOf(rules.desiredRecord({ ...base }))).toBe(h);
    expect(rules.hashOf(rules.desiredRecord({ ...base, cardNo: '999' }))).not.toBe(h);
    const later = rules.packageWindow({ startDate: '2025-11-01', endDate: '2025-12-31', timezone: 'Asia/Karachi', direction: 'in', exitGraceHours: 24 });
    expect(rules.hashOf(rules.desiredRecord({ ...base, window: later }))).not.toBe(h);
    const changed = base.biometrics.map((b) => (b.id === 'b-face' ? { ...b, template_sha256: 'd'.repeat(64) } : b));
    expect(rules.hashOf(rules.desiredRecord({ ...base, biometrics: changed }))).not.toBe(h);
  });

  test('version mismatch → the comparison photo instead of the face template', () => {
    const otherVersion = base.biometrics.map((b) => (b.id === 'b-face' ? { ...b, major_ver: '58' } : b));
    const r = rules.desiredRecord({ ...base, biometrics: otherVersion });
    expect(r.bio.map((b) => b.type)).toEqual([1]);
    expect(r.photos).toEqual([{ type: 9, id: 'p-face', sha: 'e'.repeat(64) }]);
  });

  test('a template the device refused with -30 is incompatible on that device → photo fallback', () => {
    const r = rules.desiredRecord({ ...base, incompatible: ['b-face'] });
    expect(r.bio.map((b) => b.type)).toEqual([1]);
    expect(r.photos.map((p) => p.type)).toEqual([9]);
  });

  test('no fallback when the device has no photo support for that type, or the setting is off', () => {
    const noPhoto = { ...CAPS, MultiBioPhotoSupport: '0:0:0:0:0:0:0:0:0:0:0' };
    expect(rules.desiredRecord({ ...base, caps: noPhoto, incompatible: ['b-face'] }).photos).toEqual([]);
    expect(rules.desiredRecord({ ...base, incompatible: ['b-face'], settings: { ...base.settings, photoFallback: false } }).photos).toEqual([]);
  });

  test('staff: no window (valid until the flag is removed); authorize off by setting', () => {
    const r = rules.desiredRecord({ ...base, window: null, settings: { ...base.settings, sendUserAuthorize: false } });
    expect(r.window).toBeNull();
    expect(r.auth).toBeNull();
  });
});

describe('command plan (§7.2)', () => {
  const rec = (over = {}) => ({
    pin: '1001', name: 'Member', cardNo: '', dateFormat: 'seconds',
    window: { start: { year: 2025, month: 11, day: 1 }, end: { year: 2025, month: 11, day: 30, hour: 23, minute: 59, second: 59 } },
    auth: { timezoneId: 1, doorMask: 1 },
    bio: [{ type: 9, items: [{ id: 'b-face', no: 0, index: 0, sha: 'f' }] }],
    photos: [],
    userpic: null,
    ...over,
  });

  test('add: user, authorize, one bio command per type, then photos', () => {
    const plan = rules.planCommands({ desired: rec({ bio: [{ type: 1, items: [{ id: 'f1' }] }, { type: 9, items: [{ id: 'b-face' }] }], photos: [{ type: 10, id: 'p', sha: 'x' }] }), applied: null });
    expect(plan.map((c) => c.kind)).toEqual(['user_upsert', 'user_authorize', 'bio_upsert', 'bio_upsert', 'bio_photo']);
    expect(plan[2].args).toEqual({ pin: '1001', type: 1, ids: ['f1'] });
  });

  test('renewal (only the window changed): user and authorize, no template traffic', () => {
    const before = rec();
    const after = rec({ window: { ...before.window, end: { year: 2025, month: 12, day: 31, hour: 23, minute: 59, second: 59 } } });
    expect(rules.planCommands({ desired: after, applied: before }).map((c) => c.kind)).toEqual(['user_upsert', 'user_authorize']);
  });

  test('a template type removed → bio_delete for that type; photo fallback dropped → biophoto delete', () => {
    const before = rec({ bio: [{ type: 1, items: [{ id: 'f1' }] }, { type: 9, items: [{ id: 'b-face' }] }], photos: [{ type: 9, id: 'p', sha: 'x' }] });
    const after = rec({ bio: [{ type: 9, items: [{ id: 'b-face' }] }], photos: [] });
    const plan = rules.planCommands({ desired: after, applied: before });
    // The user record did not change: no user or authorize traffic.
    expect(plan.map((c) => `${c.kind}:${c.args.type ?? ''}`)).toEqual(['bio_delete:1', 'photo_delete:']);
  });

  test('remove: templates of every supported type, photo (device with photo support), authorize, then the user', () => {
    const plan = rules.planCommands({ desired: null, applied: rec(), pin: '1001', supportedTypes: [1, 9], photoTypes: [9] });
    expect(plan.map((c) => `${c.kind}:${c.args.type ?? ''}`)).toEqual(['bio_delete:1', 'bio_delete:9', 'photo_delete:', 'auth_delete:', 'user_delete:']);
    expect(plan.every((c) => c.args.pin === '1001')).toBe(true);
    // A userpic we sent is deleted too; a device without photo support gets no photo delete.
    const withPic = rules.planCommands({ desired: null, applied: rec({ userpic: { id: 'u', sha: 'z' } }), pin: '1001', supportedTypes: [1], photoTypes: [] });
    // type 1 (supported) and type 9 (we sent it), then the userpic.
    expect(withPic.map((c) => `${c.kind}:${c.args.type ?? ''}`)).toEqual(['bio_delete:1', 'bio_delete:9', 'pic_delete:', 'auth_delete:', 'user_delete:']);
  });

  test('remove with nothing known about the device (drift, audit): still every supported type', () => {
    const plan = rules.planCommands({ desired: null, applied: null, pin: '1001', supportedTypes: [9], photoTypes: [] });
    expect(plan.map((c) => c.kind)).toEqual(['bio_delete', 'auth_delete', 'user_delete']);
  });

  test('same record → nothing', () => {
    expect(rules.planCommands({ desired: rec(), applied: rec() })).toEqual([]);
  });
});

describe('new command builders (golden strings)', () => {
  test('userpic upload and the ENROLL_BIO separators', () => {
    expect(protocol.cmd.userPic({ pin: 1001, content: 'QUJD' })).toBe('DATA UPDATE userpic pin=1001\tsize=4\tcontent=QUJD');
    expect(protocol.cmd.enrollBio({ pin: 1001, type: 9 })).toBe('ENROLL_BIO TYPE=9 NO=0 PIN=1001 RETRY=3 OVERWRITE=1 MODE=1');
  });
  test('user with a window in both formats', () => {
    const start = { year: 2025, month: 11, day: 1 };
    const end = { year: 2025, month: 11, day: 30, hour: 23, minute: 59, second: 59 };
    expect(protocol.cmd.userUpsert({ pin: 1001, name: 'Member', start, end, dateFormat: 'yyyymmdd' }))
      .toBe('DATA UPDATE user CardNo=\tPin=1001\tPassword=\tGroup=1\tStartTime=20251101\tEndTime=20251130\tName=Member\tPrivilege=0');
    expect(protocol.cmd.userUpsert({ pin: 1001, name: 'Member', start, end, dateFormat: 'seconds' }))
      .toBe(`DATA UPDATE user CardNo=\tPin=1001\tPassword=\tGroup=1\tStartTime=${protocol.encodeZkTime(2025, 11, 1)}\tEndTime=${protocol.encodeZkTime(2025, 11, 30, 23, 59, 59)}\tName=Member\tPrivilege=0`);
  });
});

describe('uploaded templates (§7.5) normalized from every format', () => {
  const f = require('../fixtures/zkteco/manual-samples');
  test('biodata (spaces), biodatapin= glued, templatev10, ENROLL_BIO result', () => {
    const a = rules.templatesFrom('biodata', f.biodataSpaces);
    expect(a).toEqual([{ pin: '9001', type: 9, no: 0, index: 0, valid: 1, duress: 0, majorVer: '40', minorVer: '1', format: 0, tmp: f.TEMPLATE }]);
    const b = rules.templatesFrom('biodata', f.biodataGlued);
    expect(b[0]).toMatchObject({ pin: '9001', type: 1, no: 6, majorVer: '10' });
    const c = rules.templatesFrom('templatev10', f.templatev10);
    expect(c[0]).toMatchObject({ pin: '9001', type: 1, no: 7, index: 0, majorVer: '10', tmp: f.TEMPLATE });
    const d = rules.templatesFrom('BioData', f.enrollResult);
    expect(d).toEqual([{ pin: '9001', type: 9, no: 0, index: 0, valid: 1, duress: 0, majorVer: '58', minorVer: '1', format: 0, tmp: f.TEMPLATE }]);
  });
  test('a line without valid base64 or type is dropped (never stored)', () => {
    expect(rules.templatesFrom('biodata', 'biodata pin=9001\ttype=9\tmajorver=40\ttmp=not base64!')).toEqual([]);
    expect(rules.templatesFrom('biodata', `biodata pin=9001\tmajorver=40\ttmp=${f.TEMPLATE}`)).toEqual([]);
    expect(rules.templatesFrom('biodata', `biodata pin=abc\ttype=9\tmajorver=40\ttmp=${f.TEMPLATE}`)).toEqual([]);
  });
  test('photos: biophoto (with type) and userpic', () => {
    expect(rules.photosFrom('biophoto', f.biophoto)).toEqual([{ pin: '9001', type: 9, kind: 'biophoto', content: f.PHOTO }]);
    expect(rules.photosFrom('userpic', f.userpic)).toEqual([{ pin: '9001', type: 0, kind: 'userpic', content: f.PHOTO }]);
  });
});
