/**
 * API-04 / PERF-08: GET /admin/organizations.
 *  - one batched read decides which pending organizations are "additional"
 *    (was one findOne per pending listing)
 *  - the page is cut in the database (was: every tenant loaded, then sliced)
 *  - the response shape the CMS and mobile read is unchanged
 */
const { Sequelize } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');

describe('GET /admin/organizations', () => {
  let queries = 0;
  let sqlLog = [];
  const origQuery = Sequelize.prototype.query;
  let seeded = 0;
  let pendingAdditional = 0;

  const seed = async (total, pendingEvery) => {
    for (let i = seeded; i < total; i += 1) {
      const t = await factories.createTenant({
        firstBusinessName: `List ${i}`, organizationName: `List Biz ${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
      const first = await factories.createGymListing(t.id, { title: `First ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
      if (i % pendingEvery === 0) {
        await factories.createGymListing(t.id, {
          title: `Second ${i}`, status: 'PENDING', createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)),
        });
        pendingAdditional += 1;
      }
      expect(first.id).toBeTruthy();
    }
    seeded = total;
  };

  const list = async (qs = '') => {
    queries = 0;
    sqlLog = [];
    const res = await asPersona('platformAdmin').get(`/admin/organizations${qs}`);
    return { res, queries };
  };

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    await startTestServer();
    Sequelize.prototype.query = async function spy(sql, ...a) {
      queries += 1;
      sqlLog.push(typeof sql === 'string' ? sql : (sql && sql.query) || '');
      return origQuery.call(this, sql, ...a);
    };
  });
  afterAll(async () => {
    Sequelize.prototype.query = origQuery;
    await stopTestServer();
    await teardownTestDatabases();
  });

  test('query count stays flat as tenants and pending organizations grow', async () => {
    await seed(20, 2);
    await list('?page=1&limit=20'); // warm the per-user auth caches
    const at20 = await list('?page=1&limit=20');
    await seed(100, 2);
    const at100 = await list('?page=1&limit=20');
     
    console.log(`ADMIN_TENANTS_QUERIES at20=${at20.queries} at100=${at100.queries} pendingAdditional=${pendingAdditional}`);
    expect(at20.res.status).toBe(200);
    expect(at100.res.status).toBe(200);
    expect(at100.queries).toBe(at20.queries);
    expect(at100.queries).toBeLessThanOrEqual(8);
  });

  test('the page is cut in SQL: the tenants read carries a LIMIT, not every row', async () => {
    await list('?page=2&limit=10');
    const tenantSelects = sqlLog.filter((q) => /^SELECT .* FROM `organizations` AS `Tenant`/s.test(q) && /LEFT OUTER JOIN `users`/.test(q));
    expect(tenantSelects.length).toBe(1);
    expect(tenantSelects[0]).toMatch(/LIMIT 20\b/); // offset 10 + limit 10: enough to merge the page
    // and the first-listing check is one batched read, not one per listing
    const listingReads = sqlLog.filter((q) => /FROM `business_listings`/.test(q));
    expect(listingReads.length).toBeLessThanOrEqual(2);
  });

  test('response keys the clients read are unchanged', async () => {
    const { res } = await list('?page=1&limit=20');
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.organizations)).toBe(true);
    // API contract v2 §10 G1: { organizations, page, total } inside data; nothing in the envelope.
    expect(res.body.data).toEqual(expect.objectContaining({ page: 1, total: expect.any(Number) }));
    expect(Object.keys(res.body.data).sort()).toEqual(['organizations', 'page', 'total']);
    expect(res.body.pagination).toBeUndefined();
    const row = res.body.data.organizations.find((t) => !t.isAdditionalOrganization);
    for (const k of ['id', 'organizationCode', 'organizationName', 'status', 'email', 'createdAt', 'owner', 'city']) {
      expect(row).toHaveProperty(k);
    }
    const additional = res.body.data.organizations.find((t) => t.isAdditionalOrganization);
    expect(additional).toBeDefined();
    for (const k of ['id', 'organizationName', 'status', 'gymName', 'gymListing', 'owner', 'user', 'city', 'ownerUserId']) {
      expect(additional).toHaveProperty(k);
    }
    expect(additional.id).toMatch(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/);
    expect(additional.status).toBe('PENDING_REVIEW');
  });

  test('no limit / page: the same default page the CMS gets today (20, page 1)', async () => {
    const { res } = await list('');
    expect(res.status).toBe(200);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.organizations.length).toBe(20);
  });

  test('total counts tenants plus pending additional organizations', async () => {
    const { res } = await list('?limit=1');
    // 100 seeded tenants + persona tenants, plus one row per pending additional organization
    const ids = new Set();
    let page = 1;
    let total = 0;
    for (;;) {
      const r = await asPersona('platformAdmin').get(`/admin/organizations?page=${page}&limit=100`);
      total = r.body.data.total;
      r.body.data.organizations.forEach((t) => ids.add(t.id));
      if (page >= Math.ceil(total / 100)) break;
      page += 1;
    }
    expect(ids.size).toBe(total); // every row exactly once across pages
    expect(res.body.data.total).toBe(total);
    expect(total).toBeGreaterThanOrEqual(100 + pendingAdditional);
  });

  test('ordering is newest first across tenants and additional organizations, stable between pages', async () => {
    const a = await list('?page=1&limit=10');
    const b = await list('?page=2&limit=10');
    const rows = [...a.res.body.data.organizations, ...b.res.body.data.organizations];
    const times = rows.map((r) => new Date(r.createdAt).getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  test('pagination boundaries: limit is capped, bad page falls back, past the end is empty', async () => {
    const capped = await list('?limit=1000');
    expect(capped.res.status).toBe(200);
    expect(capped.res.body.data.organizations.length).toBeLessThanOrEqual(100);

    for (const bad of ['?page=0', '?page=-3', '?page=abc', '?limit=0', '?limit=-5']) {
      const r = await list(bad);
      expect(r.res.status).toBe(200);
      expect(r.res.body.data.page).toBeGreaterThanOrEqual(1);
      expect(r.res.body.data.organizations.length).toBeLessThanOrEqual(100);
    }

    const total = capped.res.body.data.total;
    const last = Math.ceil(total / 20);
    const lastPage = await list(`?page=${last}&limit=20`);
    expect(lastPage.res.body.data.organizations.length).toBe(total - (last - 1) * 20);
    const beyond = await list(`?page=${last + 1}&limit=20`);
    expect(beyond.res.status).toBe(200);
    expect(beyond.res.body.data.organizations).toEqual([]);
    expect(beyond.res.body.data.total).toBe(total);
  });

  test('status filter keeps working with pagination', async () => {
    const pending = await list('?status=PENDING_REVIEW&limit=100');
    expect(pending.res.status).toBe(200);
    for (const t of pending.res.body.data.organizations) expect(t.status).toBe('PENDING_REVIEW');
    const bad = await list('?status=NOT_A_STATUS');
    expect(bad.res.status).toBe(400);
  });

  test('non-admins are refused', async () => {
    const res = await asPersona('owner').get('/admin/organizations');
    expect([401, 403]).toContain(res.status);
  });
});
