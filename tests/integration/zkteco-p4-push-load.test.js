/**
 * ZKTeco Phase 4: manual push under load (spec §9, §13, §15 Phase 4 "load test with 50 simulated devices").
 *
 * ZK_PUSH_LOAD_DEVICES devices (default 50) on 5 branches of one tenant, ZK_PUSH_LOAD_MEMBERS members
 * (default 150) spread over the branches, all devices in their first sync. While every device polls, staff
 * press Push now for ZK_PUSH_LOAD_PUSHES members (default 40), in waves of ZK_PUSH_LOAD_WAVE (default 5),
 * each press sent twice at once (a double click). Checked:
 *   - every push request answers at once (202) and none is created twice for the same person and member;
 *   - every device ends with exactly its branch's members (no other branch's, no other tenant's);
 *   - no command is handed out twice; once in sync every poll is a plain OK;
 *   - every push request is `done` with each device `applied`;
 *   - timing: the slowest push answer, the slowest poll and the 95th percentile poll stay under limits.
 *
 * Load model: an idle device asks again after ZK_PUSH_LOAD_IDLE_MS (default 1000, three times the real rate).
 *
 * Timing limits (ms), like the Phase 2 load test: ZK_PUSH_LOAD_MAX_MS (slowest poll, default
 * 3000), ZK_PUSH_LOAD_P95_MS (95th percentile poll, default 1500) and ZK_PUSH_LOAD_PUSH_MS (slowest push answer
 * in a wave, default 5000). CI sets generous values; a local run
 * before a release uses the defaults (`npm run test:zk-push-load`). Correctness never depends on them.
 */
const { createWorld } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');

function positive(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}
const DEVICES = positive('ZK_PUSH_LOAD_DEVICES', 50);
const MEMBERS = positive('ZK_PUSH_LOAD_MEMBERS', 150);
const PUSHES = Math.min(positive('ZK_PUSH_LOAD_PUSHES', 40), MEMBERS);
const MAX_MS = positive('ZK_PUSH_LOAD_MAX_MS', 3000);
const P95_MS = positive('ZK_PUSH_LOAD_P95_MS', 1500);
// The slowest Push now answer (202) in a wave of 10 requests at once on one tenant. Its own limit: the tenant
// pool has 3 connections (PERF-07, TENANT_POOL_MAX_CONNECTIONS), so a burst queues. Default 5000 ms, a third
// of the 15-second push window; measured 4.2 s on the dev Mac (2026-11-11), recorded as NEW-238.
const PUSH_MS = positive('ZK_PUSH_LOAD_PUSH_MS', 5000);
const BRANCHES = 5;
// A device with nothing to do asks again after this long. Real devices ask every RequestDelay (3 s, spec §13:
// 50 devices ≈ 17 requests a second); 1 s keeps the load 3 times higher than that. A device with commands
// asks again at once (faster than a real one), so the first sync is not slowed down.
const IDLE_MS = positive('ZK_PUSH_LOAD_IDLE_MS', 1000);

const REG = 'DeviceType=acc,~DeviceName=SpeedFace Sim,FirmVer=SIM,PushVersion=3.1.2,MaxPackageSize=2048000,' +
  'MultiBioDataSupport=0:1:0:0:0:0:0:0:0:1:0,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:0,MultiBioVersion=0:10.0:0:0:0:0:0:0:0:40.1:0,DateFmtFunOn=1';

let w;
beforeAll(async () => { w = await createWorld(); }, 120000);
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

test(`${DEVICES} devices, ${MEMBERS} members, ${PUSHES} pushes at once during the first sync`, async () => {
  const branches = [];
  for (let i = 0; i < BRANCHES; i++) branches.push(await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: `Load ${i}` }));
  const members = new Map(branches.map((b) => [b.id, []]));
  const all = [];
  for (let j = 0; j < MEMBERS; j++) {
    const b = branches[j % BRANCHES];
    const u = await w.member(`Push Load ${j}`);
    await w.subscribe(w.db1, { user: u, branch: b });
    members.get(b.id).push(u.id);
    all.push({ user: u, branch: b });
  }
  // Another tenant's members on a device of its own: never seen by tenant 1's devices.
  const foreignBranch = w.ctx.branch2 || (await w.branch(w.db2, {}));
  const foreign = await w.member('Foreign Load');
  await w.subscribe(w.db2, { user: foreign, branch: foreignBranch });

  const devices = await Promise.all(Array.from({ length: DEVICES }, (_, i) => w.device(w.db1, { branch: branches[i % BRANCHES], registryBody: REG, name: `Load Door ${i}` })));
  await w.settled();

  const polls = [];
  const seen = new Map();
  let running = true;
  const pollAll = Promise.all(devices.map(async (d) => {
    // Every device keeps polling (like a real one every RequestDelay) until the test has seen all in sync.
    const stopAt = Date.now() + 300000;
    while (running && Date.now() < stopAt) {
      const s = await d.sim.step();
      polls.push(s.poll.ms);
      for (const c of s.commands) {
        const key = `${d.id}:${c.id}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      if (!s.commands.length) await new Promise((r) => setTimeout(r, IDLE_MS));
    }
  }));

  // Staff press Push now for PUSHES members at once, each from the owner's session, twice (double click).
  const owner = asPersona('owner');
  const targets = all.slice(0, PUSHES);
  const pushTimes = [];
  // Waves of ZK_PUSH_LOAD_WAVE members (default 5: 10 requests) while all devices poll: the local test client
  // shares one listen backlog with the devices (macOS caps it at 128), a real front desk does not.
  const WAVE = positive('ZK_PUSH_LOAD_WAVE', 5);
  const pushed = [];
  for (let i = 0; i < targets.length; i += WAVE) {
    pushed.push(...await Promise.all(targets.slice(i, i + WAVE).flatMap(({ user }) => [0, 1].map(async () => {
      const t0 = Date.now();
      const res = await owner.post(`/host/members/${user.id}/device-push`, {});
      pushTimes.push(Date.now() - t0);
      return { user, res };
    }))));
  }
  for (const { res } of pushed) expect(res.status).toBe(202);
  const byMember = new Map();
  for (const { user, res } of pushed) {
    if (!byMember.has(user.id)) byMember.set(user.id, new Set());
    byMember.get(user.id).add(res.body.data.requestId);
  }
  for (const ids of byMember.values()) expect(ids.size).toBe(1); // the double click got the same request

  // Wait until every device is in sync (the poll loops above keep running meanwhile).
  const deadline = Date.now() + 240000;
  for (;;) {
    const [p] = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_member_sync WHERE desired = 1 AND state <> \'in_sync\'');
    const [q] = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_commands WHERE status IN (\'queued\', \'sent\')');
    if ((Number(p.n) === 0 && Number(q.n) === 0) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  running = false;
  await pollAll;

  expect([...seen.values()].every((n) => n === 1)).toBe(true);
  const foreignPin = await w.pinOf(w.db2, foreign.id);
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    const want = new Set();
    for (const id of members.get(branches[i % BRANCHES].id)) want.add(await w.pinOf(w.db1, id));
    expect(new Set(d.sim.users.keys())).toEqual(want);
    if (foreignPin) expect([...d.sim.users.values()].some((u) => u.name === 'Foreign Load')).toBe(false);
  }
  const again = await Promise.all(devices.map((d) => d.sim.poll()));
  expect(again.every((r) => r.text === 'OK\n')).toBe(true);

  for (const ids of byMember.values()) {
    const [id] = [...ids];
    const st = await owner.get(`/host/device-push-requests/${id}`);
    expect(st.status).toBe(200);
    expect(st.body.data.status).toBe('done');
    for (const dv of st.body.data.devices) expect(dv.state).toBe('applied');
  }

  polls.sort((a, b) => a - b);
  const p95 = polls[Math.floor(polls.length * 0.95)];
  const slowestPush = Math.max(...pushTimes);
  console.log(`[zkteco-p4-push-load] ${DEVICES} devices, ${MEMBERS} members, ${PUSHES} pushes x2: ${polls.length} polls, p95 ${p95} ms, max ${polls[polls.length - 1]} ms; slowest push answer ${slowestPush} ms (limits: poll max < ${MAX_MS} ms, p95 < ${P95_MS} ms, push answer < ${PUSH_MS} ms)`);
  expect(polls[polls.length - 1]).toBeLessThan(MAX_MS);
  expect(p95).toBeLessThan(P95_MS);
  expect(slowestPush).toBeLessThan(PUSH_MS);
}, 600000);
