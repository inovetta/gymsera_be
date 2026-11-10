/**
 * ZKTeco Phase 2: 50 simulated devices polling one API process at once (spec §13, §15).
 * 5 branches of one tenant, 10 devices each, 6 members per branch. Every device registers, gets its
 * branch's members (and no one else's), every poll answers well under the device's 10 s timeout,
 * no command is handed out twice, and repeated polls once in sync are plain OK.
 */
const { createWorld } = require('../harness/zkteco-world');

let w;
beforeAll(async () => { w = await createWorld(); }, 120000);
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

const REG = 'DeviceType=acc,~DeviceName=SpeedFace Sim,FirmVer=SIM,PushVersion=3.1.2,MaxPackageSize=2048000,' +
  'MultiBioDataSupport=0:1:0:0:0:0:0:0:0:1:0,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:0,MultiBioVersion=0:10.0:0:0:0:0:0:0:0:40.1:0,DateFmtFunOn=1';

test('50 devices, 30 members: each device holds exactly its branch\'s members; polls stay fast; no command twice', async () => {
  const branches = [];
  for (let i = 0; i < 5; i++) branches.push(await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id }));
  const members = new Map(); // branchId → [userId]
  for (const b of branches) {
    members.set(b.id, []);
    for (let j = 0; j < 6; j++) {
      const u = await w.member(`Load ${j}`);
      await w.subscribe(w.db1, { user: u, branch: b });
      members.get(b.id).push(u.id);
    }
  }
  const devices = await Promise.all(Array.from({ length: 50 }, (_, i) => w.device(w.db1, { branch: branches[i % 5], registryBody: REG, name: `Door ${i}` })));
  await w.settled();

  const started = Date.now();
  const timings = [];
  const seen = new Map();
  await Promise.all(devices.map(async (d) => {
    for (let round = 0; round < 10; round++) {
      const s = await d.sim.step();
      timings.push(s.poll.ms);
      for (const c of s.commands) {
        const key = `${d.id}:${c.id}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      if (!s.commands.length) break;
    }
  }));
  const elapsed = Date.now() - started;

  expect([...seen.values()].every((n) => n === 1)).toBe(true);
  expect(Math.max(...timings)).toBeLessThan(2000);
  timings.sort((a, b) => a - b);
  expect(timings[Math.floor(timings.length * 0.95)]).toBeLessThan(1000);
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    const want = new Set();
    for (const id of members.get(branches[i % 5].id)) want.add(await w.pinOf(w.db1, id));
    expect(new Set(d.sim.users.keys())).toEqual(want);
  }
  // In sync: every device's next poll is a plain OK.
  const again = await Promise.all(devices.map((d) => d.sim.poll()));
  expect(again.every((r) => r.text === 'OK\n')).toBe(true);
  const pending = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_member_sync WHERE state <> \'in_sync\' AND desired = 1');
  expect(Number(pending[0].n)).toBe(0);
  console.log(`[zkteco-p2-load] 50 devices, ${timings.length} polls, p95 ${timings[Math.floor(timings.length * 0.95)]} ms, max ${timings[timings.length - 1]} ms, ${elapsed} ms total`);
}, 180000);
