/**
 * NEW-244: the plan status rule itself (utils/membership-status.utils.js), at the day boundaries
 * the app uses (members_list_screen.dart: expired when the end day is before today, expiring when
 * it is 0 to 3 days away).
 */
const {
  membershipDisplayStatus,
  isBetterMembership,
  EXPIRING_SOON_DAYS,
} = require('../../src/utils/membership-status.utils');
const { daysFromToday } = require('../harness/dates');

const today = '2026-11-13';

describe('NEW-244: membershipDisplayStatus', () => {
  test.each([
    ['ACTIVE', '2026-11-12', 'EXPIRED'],
    ['ACTIVE', '2026-10-13', 'EXPIRED'],
    ['ACTIVE', '2026-11-13', 'EXPIRING'],
    ['ACTIVE', '2026-11-16', 'EXPIRING'],
    ['ACTIVE', '2026-11-17', 'ACTIVE'],
    ['ACTIVE', null, 'ACTIVE'],
    ['FROZEN', '2026-10-01', 'FROZEN'],
    ['PENDING', '2026-12-13', 'PENDING'],
    ['EXPIRED', '2026-12-13', 'EXPIRED'],
    ['CANCELLED', '2026-12-13', 'EXPIRED'],
  ])('%s ending %s reads %s', (status, endDate, expected) => {
    expect(membershipDisplayStatus({ status, endDate }, today)).toBe(expected);
  });

  test('a Date end date is read as its calendar day', () => {
    expect(membershipDisplayStatus({ status: 'ACTIVE', endDate: new Date('2026-11-12T00:00:00Z') }, today)).toBe('EXPIRED');
  });

  test('the window is the expiry-warning job window', () => {
    expect(EXPIRING_SOON_DAYS).toBe(3);
  });

  test('a current subscription beats an expired one, then the later end date wins', () => {
    const active = { displayStatus: 'ACTIVE', endDate: daysFromToday(18) };
    const expired = { displayStatus: 'EXPIRED', endDate: daysFromToday(49) };
    expect(isBetterMembership(active, expired)).toBe(true);
    expect(isBetterMembership(expired, active)).toBe(false);
    expect(isBetterMembership({ displayStatus: 'EXPIRED', endDate: '2026-11-01' }, { displayStatus: 'EXPIRED', endDate: '2026-10-01' })).toBe(true);
  });
});
