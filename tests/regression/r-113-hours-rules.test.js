/**
 * R-113 (owner 2026-11-18, build 27): opening hours as a weekly schedule. The rules, no database.
 * Contract: spec §13 "R-113 API contract, revision 1", H2 shape, H3 rules, H5 old clients, H6 reads.
 *
 * Before: a branch had one opening_time / closing_time pair, the same every day, checked for shape
 * only ("25:99" passed, gyms.validator.js:115-123).
 */
const hours = require('../../src/services/branch-hours.service');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const slot = (open, close, forWho = 'all') => ({ open, close, for: forWho });
const week = (perDay) => ({
  v: 1,
  days: Object.fromEntries(DAYS.map((d) => {
    const slots = perDay[d] !== undefined ? perDay[d] : perDay.all;
    return [d, slots ? { closed: false, slots } : { closed: true, slots: [] }];
  })),
});
const errorsOf = (h) => {
  try {
    hours.validate(h);
    return [];
  } catch (err) {
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('hours_invalid');
    return err.errors.map((e) => e.path);
  }
};

describe('R-113 H2 / H3: what a schedule may be', () => {
  test('a normal week is accepted and stored with its slots sorted by opening time', () => {
    const h = week({ all: [slot('16:00', '19:00', 'women'), slot('06:00', '11:00')], sun: null });
    const out = hours.validate(h);
    expect(out.days.mon.slots.map((s) => s.open)).toEqual(['06:00', '16:00']);
    expect(out.days.sun).toEqual({ closed: true, slots: [] });
  });

  test('all seven days are required, and nothing else', () => {
    const h = week({ all: [slot('06:00', '22:00')] });
    delete h.days.sun;
    expect(errorsOf(h)).toContain('days.sun');
    const extra = week({ all: [slot('06:00', '22:00')] });
    extra.days.holiday = { closed: true, slots: [] };
    expect(errorsOf(extra)).toContain('days.holiday');
    expect(errorsOf({ ...week({ all: [slot('06:00', '22:00')] }), v: 2 })).toContain('v');
  });

  test('real times only: 25:99 and 24:00 as an opening time are refused; 24:00 closes', () => {
    expect(errorsOf(week({ all: [slot('25:99', '22:00')] }))).toContain('days.mon.slots[0].open');
    expect(errorsOf(week({ all: [slot('24:00', '23:00')] }))).toContain('days.mon.slots[0].open');
    expect(errorsOf(week({ all: [slot('06:00', '24:00')] }))).toEqual([]);
  });

  test('1 to 4 slots on an open day; a closed day has none; for is all / men / women', () => {
    expect(errorsOf(week({ all: [] }))).toContain('days.mon.slots');
    const five = [slot('01:00', '02:00'), slot('03:00', '04:00'), slot('05:00', '06:00'), slot('07:00', '08:00'), slot('09:00', '10:00')];
    expect(errorsOf(week({ all: five }))).toContain('days.mon.slots');
    const closedWithSlots = week({ all: [slot('06:00', '22:00')] });
    closedWithSlots.days.sun = { closed: true, slots: [slot('06:00', '09:00')] };
    expect(errorsOf(closedWithSlots)).toContain('days.sun.slots');
    expect(errorsOf(week({ all: [slot('06:00', '22:00', 'kids')] }))).toContain('days.mon.slots[0].for');
  });

  test('after midnight: only on the day\'s last slot, at most 12 hours past midnight', () => {
    expect(errorsOf(week({ all: [slot('06:00', '11:00'), slot('22:00', '02:00')] }))).toEqual([]);
    expect(errorsOf(week({ all: [slot('22:00', '02:00'), slot('23:00', '23:30')] }))).not.toEqual([]);
    expect(errorsOf(week({ all: [slot('20:00', '13:00')] }))).toContain('days.mon.slots[0].close');
  });

  test('open == close is refused except 00:00-24:00, which is "open 24 hours"', () => {
    expect(errorsOf(week({ all: [slot('08:00', '08:00')] }))).toContain('days.mon.slots[0].close');
    expect(errorsOf(week({ all: [slot('00:00', '24:00')] }))).toEqual([]);
  });

  test('no overlaps on a day, whatever the audience; the after-midnight part counts against the next day', () => {
    expect(errorsOf(week({ all: [slot('06:00', '12:00'), slot('11:00', '14:00', 'women')] }))).toContain('days.mon.slots[1]');
    const spill = week({ all: [slot('06:00', '22:00')] });
    spill.days.mon.slots = [slot('18:00', '03:00')];
    spill.days.tue.slots = [slot('02:00', '10:00')];
    expect(errorsOf(spill)).toContain('days.tue.slots[0]');
    const wrap = week({ all: [slot('06:00', '22:00')] });
    wrap.days.sun.slots = [slot('20:00', '04:00')];
    wrap.days.mon.slots = [slot('03:00', '10:00')];
    expect(errorsOf(wrap)).toContain('days.mon.slots[0]');
  });
});

describe('R-113 H5: the summary pair and old clients', () => {
  test('the pair is the week\'s earliest open and latest close; 24 hours is 00:00 / 23:59; all closed is none', () => {
    const h = hours.validate(week({ all: [slot('06:00', '11:00'), slot('16:00', '22:00')], sat: [slot('08:00', '23:30')], sun: null }));
    expect(hours.summaryPair(h)).toEqual({ openingTime: '06:00', closingTime: '23:30' });
    expect(hours.summaryPair(hours.validate(week({ all: [slot('00:00', '24:00')] })))).toEqual({ openingTime: '00:00', closingTime: '23:59' });
    expect(hours.summaryPair(hours.validate(week({ all: null })))).toEqual({ openingTime: null, closingTime: null });
    // An after-midnight close is the latest close, shown as its clock time.
    expect(hours.summaryPair(hours.validate(week({ all: [slot('06:00', '22:00')], fri: [slot('06:00', '02:00')] })))).toEqual({ openingTime: '06:00', closingTime: '02:00' });
  });

  test('a stored pair with no schedule reads as every day, one slot for everyone', () => {
    expect(hours.fromPair('06:00', '22:00')).toEqual(week({ all: [slot('06:00', '22:00')] }));
    expect(hours.fromPair(null, null)).toBeNull();
  });

  describe('resolveWrite: what a create / update stores', () => {
    const stored = (hoursJson, openingTime = null, closingTime = null) => ({ hoursJson, openingTime, closingTime });

    test('a new-style write stores the schedule and its summary pair', () => {
      const out = hours.resolveWrite({ hours: week({ all: [slot('06:00', '22:00')], sun: null }) }, stored(null));
      expect(out.openingTime).toBe('06:00');
      expect(out.closingTime).toBe('22:00');
      expect(out.hoursJson.days.sun.closed).toBe(true);
    });

    test('hours: null clears everything', () => {
      expect(hours.resolveWrite({ hours: null }, stored(week({ all: [slot('06:00', '22:00')] }), '06:00', '22:00')))
        .toEqual({ hoursJson: null, openingTime: null, closingTime: null });
    });

    test('a body with hours and the old pair is refused', () => {
      expect(() => hours.resolveWrite({ hours: week({ all: [slot('06:00', '22:00')] }), openingTime: '06:00' }, stored(null)))
        .toThrow(expect.objectContaining({ statusCode: 422, code: 'hours_invalid' }));
    });

    test('an old-style pair on a branch with no schedule or a uniform one: stored as a uniform week plus the pair', () => {
      const out = hours.resolveWrite({ openingTime: '07:00', closingTime: '21:00' }, stored(null, '06:00', '22:00'));
      expect(out).toEqual({ hoursJson: week({ all: [slot('07:00', '21:00')] }), openingTime: '07:00', closingTime: '21:00' });
      const uniform = hours.resolveWrite({ openingTime: '05:00' }, stored(week({ all: [slot('06:00', '22:00')] }), '06:00', '22:00'));
      expect(uniform.hoursJson).toEqual(week({ all: [slot('05:00', '22:00')] }));
    });

    test('an old-style pair on a weekly schedule is refused (409), unless it is the same pair sent back', () => {
      const weekly = hours.validate(week({ all: [slot('06:00', '22:00')], sun: null }));
      expect(() => hours.resolveWrite({ openingTime: '07:00', closingTime: '21:00' }, stored(weekly, '06:00', '22:00')))
        .toThrow(expect.objectContaining({ statusCode: 409, code: 'hours_schedule_newer' }));
      // A form that sends every field back unchanged (the CMS) must not be blocked.
      expect(hours.resolveWrite({ openingTime: '06:00', closingTime: '22:00' }, stored(weekly, '06:00', '22:00'))).toBeNull();
    });

    test('a body without any hours field changes nothing', () => {
      expect(hours.resolveWrite({ branchName: 'x' }, stored(null, '06:00', '22:00'))).toBeNull();
    });

    test('an old-style pair is checked too: 25:99 is refused', () => {
      expect(() => hours.resolveWrite({ openingTime: '25:99', closingTime: '22:00' }, stored(null)))
        .toThrow(expect.objectContaining({ statusCode: 422, code: 'hours_invalid' }));
    });
  });
});

describe('R-113 H6: today, open now and the next change, in the branch\'s timezone', () => {
  // Wednesday 2026-11-18. Karachi is UTC+5, New York UTC-5 in November.
  const at = (iso) => new Date(iso);
  const gym = hours.validate(week({ all: [slot('06:00', '11:00'), slot('16:00', '19:00', 'women')], fri: [slot('06:00', '02:00')], sun: null }));

  test('open now, for whom, and when it closes (Karachi)', () => {
    const now = hours.computeNow(gym, 'Asia/Karachi', at('2026-11-18T12:30:00Z')); // 17:30 local, Wednesday
    expect(now.hoursToday.day).toBe('wed');
    expect(now.openNow).toBe(true);
    expect(now.openNowFor).toBe('women');
    expect(now.nextChange).toEqual({ at: '2026-11-18T14:00:00.000Z', kind: 'closes', for: 'women' });
    expect(now.utcOffsetMinutes).toBe(300);
  });

  test('closed now: when it opens next and for whom', () => {
    const now = hours.computeNow(gym, 'Asia/Karachi', at('2026-11-18T07:00:00Z')); // 12:00 local
    expect(now.openNow).toBe(false);
    expect(now.openNowFor).toBeNull();
    expect(now.nextChange).toEqual({ at: '2026-11-18T11:00:00.000Z', kind: 'opens', for: 'women' });
  });

  test('after midnight: Friday 06:00-02:00 is still open at 01:00 on Saturday, and today shows that slot', () => {
    const now = hours.computeNow(gym, 'Asia/Karachi', at('2026-11-20T20:00:00Z')); // Sat 01:00 local
    expect(now.hoursToday.day).toBe('sat');
    expect(now.openNow).toBe(true);
    expect(now.nextChange).toEqual({ at: '2026-11-20T21:00:00.000Z', kind: 'closes', for: 'all' });
    expect(now.hoursToday.slots[0]).toMatchObject({ open: '06:00', close: '02:00', startsYesterday: true });
  });

  test('the same schedule in New York uses New York time, never the server\'s', () => {
    const now = hours.computeNow(gym, 'America/New_York', at('2026-11-18T12:30:00Z')); // 07:30 local
    expect(now.openNow).toBe(true);
    expect(now.openNowFor).toBe('all');
    expect(now.utcOffsetMinutes).toBe(-300);
    expect(now.nextChange).toEqual({ at: '2026-11-18T16:00:00.000Z', kind: 'closes', for: 'all' });
  });

  test('a closed day: Sunday shows closed, and it opens on Monday', () => {
    const now = hours.computeNow(gym, 'Asia/Karachi', at('2026-11-22T07:00:00Z')); // Sun 12:00 local
    expect(now.hoursToday).toEqual({ day: 'sun', closed: true, slots: [] });
    expect(now.openNow).toBe(false);
    expect(now.nextChange).toEqual({ at: '2026-11-23T01:00:00.000Z', kind: 'opens', for: 'all' });
  });

  test('open 24 hours every day: open now, no next change', () => {
    const allDay = hours.validate(week({ all: [slot('00:00', '24:00')] }));
    const now = hours.computeNow(allDay, 'Asia/Karachi', at('2026-11-18T12:30:00Z'));
    expect(now.openNow).toBe(true);
    expect(now.nextChange).toBeNull();
  });

  test('no hours: open now is unknown (null)', () => {
    expect(hours.computeNow(null, 'Asia/Karachi', at('2026-11-18T12:30:00Z'))).toMatchObject({ hoursToday: null, openNow: null, openNowFor: null, nextChange: null });
  });
});
