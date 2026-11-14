/**
 * Checklist (i), real device 2026-11-14 (SpeedFace-V5L, ZAM180-NF50VA-Ver3.4.9, Push 2.0.33S, T&A PUSH):
 *   DATA UPDATE user …            Return=-1004     DATA UPDATE USERINFO …    Return=0 (user count 344 → 345)
 *   DATA DELETE user Pin=…        Return=-1004     DATA DELETE USERINFO PIN=… Return=0 (345 → 344)
 * So a T&A PUSH (att) device is sent the USERINFO form unless its own row (or DEVICE_ATT_USER_FORM) says `user`.
 * The strings are the ones the device accepted (#4066 / #4069): no TZ, Verify or ViceCard field.
 */
const rules = require('../../src/services/devices/sync-rules');
const protocol = require('../../src/services/devices/push-protocol');
const { getDeviceConfig } = require('../../src/config/devices.config');

const withEnv = (vars, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

describe('T&A PUSH user command form (checklist (i))', () => {
  test('default for an att device is userinfo', () => withEnv({ DEVICE_ATT_USER_FORM: undefined }, () => {
    expect(getDeviceConfig().attUserForm).toBe('userinfo');
    expect(rules.deviceOptions({ device_type: 'att' }, getDeviceConfig()).userForm).toBe('userinfo');
    // A config object without the setting falls back to userinfo too.
    expect(rules.deviceOptions({ device_type: 'att' }, {}).userForm).toBe('userinfo');
  }));

  test('user stays selectable: per device, and by the setting', () => {
    withEnv({ DEVICE_ATT_USER_FORM: undefined }, () => {
      expect(rules.deviceOptions({ device_type: 'att', user_command_form: 'user' }, getDeviceConfig()).userForm).toBe('user');
    });
    withEnv({ DEVICE_ATT_USER_FORM: 'user' }, () => {
      expect(rules.deviceOptions({ device_type: 'att' }, getDeviceConfig()).userForm).toBe('user');
      expect(rules.deviceOptions({ device_type: 'att', user_command_form: 'userinfo' }, getDeviceConfig()).userForm).toBe('userinfo');
    });
  });

  test('an acc device is unchanged (user form)', () => withEnv({ DEVICE_ATT_USER_FORM: undefined }, () => {
    expect(rules.deviceOptions({ device_type: 'acc' }, getDeviceConfig()).userForm).toBe('user');
    expect(rules.deviceOptions({}, getDeviceConfig()).userForm).toBe('user');
  }));

  test('the record of a default att device carries the userinfo form', () => withEnv({ DEVICE_ATT_USER_FORM: undefined }, () => {
    const o = rules.deviceOptions({ device_type: 'att' }, getDeviceConfig());
    const record = rules.desiredRecord({ pin: 9001, name: 'ZK Test', cardNo: '', window: null, settings: { att: true, ...o } });
    expect(record.form).toBe('userinfo');
    expect(record.validity).toBe('none');
  }));

  test('the strings are the ones the device accepted (#4066, #4069)', () => {
    // validity none: the window is cleared (device-sync#renderOne passes clearWindow).
    expect(protocol.cmd.userInfoUpsert({ pin: 9001, name: 'ZK Test', cardNo: '', clearWindow: true }))
      .toBe('DATA UPDATE USERINFO PIN=9001\tName=ZK Test\tPri=0\tPasswd=\tCard=\tGrp=1\tStartDatetime=0\tEndDatetime=0');
    expect(protocol.cmd.userInfoUpsert({ pin: 9001, name: 'ZK Test', clearWindow: true })).not.toMatch(/TZ=|Verify=|ViceCard=/);
    expect(protocol.cmd.userInfoDelete(9001)).toBe('DATA DELETE USERINFO PIN=9001');
  });
});
