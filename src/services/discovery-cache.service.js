/**
 * Discovery snapshot cache (PERF-06 / API-04, spec §4.4, §10.3).
 *
 * Every public discovery read used to open every ACTIVE tenant database
 * (about 3 queries per tenant, per request). They all start from the same
 * "every visible branch" list, so that list is built once and shared:
 *
 *  - TTL: DISCOVERY_SNAPSHOT_TTL_MS (default 60 s; 0 turns the cache off).
 *  - Single flight: concurrent callers share one build.
 *  - Immediate invalidation: invalidate() drops the snapshot AND any build
 *    already in flight, so a build that started before a hide / suspend /
 *    delete can never be stored. Model hooks (watchModels) call it on every
 *    write to the models the snapshot is built from; a write inside an open
 *    transaction invalidates again after commit.
 *  - A build that skipped a tenant (database unreachable) is kept for at most
 *    10 s, so an outage is neither frozen in for the full TTL nor rebuilt on
 *    every request.
 *  - Callers needing read-your-writes (anything that authorizes a write) pass
 *    { fresh: true } and never see a cached value.
 *
 * Scope: in-process. With more than one API instance a hide done on instance A
 * reaches instance B within the TTL, not instantly (no shared store: Redis
 * is out of scope for this prompt).
 */
const DEFAULT_TTL_MS = 60000;
const INCOMPLETE_TTL_MS = 10000;

const ttlMs = () => {
  const n = parseInt(process.env.DISCOVERY_SNAPSHOT_TTL_MS, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
};

const state = {
  value: null,
  expiresAt: 0,
  building: null,
  generation: 0,
  hits: 0,
  builds: 0,
  invalidations: 0,
};

/**
 * @param {() => Promise<{ branches: object[], complete: boolean }>} build
 * @param {{ fresh?: boolean }} [opts]
 * @returns {Promise<object[]>} a frozen array: callers must copy before sorting or annotating
 */
const getSnapshot = async (build, { fresh = false } = {}) => {
  const ttl = ttlMs();
  const now = Date.now();

  if (!fresh && ttl > 0) {
    if (state.value && now < state.expiresAt) {
      state.hits += 1;
      return state.value;
    }
    if (state.building) return state.building;
  }

  const generation = state.generation;
  state.builds += 1;
  const promise = (async () => {
    const { branches, complete } = await build();
    const frozen = Object.freeze(branches.map((b) => Object.freeze(b)));
    if (ttl > 0 && generation === state.generation) {
      state.value = frozen;
      // A snapshot that skipped a tenant (database unreachable) is kept only
      // briefly, so an outage is neither frozen in for a minute nor rebuilt
      // (about 3 queries per tenant) on every request.
      state.expiresAt = Date.now() + (complete ? ttl : Math.min(ttl, INCOMPLETE_TTL_MS));
    }
    return frozen;
  })();

  if (!fresh && ttl > 0) {
    state.building = promise;
    const clear = () => { if (state.building === promise) state.building = null; };
    promise.then(clear, clear);
  }
  return promise;
};

const MEMO_MAX_KEYS = 500;
/** @type {Map<string, { value: any, expiresAt: number, building: Promise<any>|null }>} */
const memos = new Map();

/**
 * Same TTL / single-flight / invalidation rules for a derived read keyed by
 * its parameters (organizations list, one organization's branches). The key
 * set is bounded: public input must not grow memory without limit.
 */
const memo = async (key, build, { fresh = false } = {}) => {
  const ttl = ttlMs();
  if (ttl <= 0 || fresh) return build();
  const now = Date.now();
  const hit = memos.get(key);
  if (hit && hit.value !== undefined && now < hit.expiresAt) {
    state.hits += 1;
    return hit.value;
  }
  if (hit && hit.building) return hit.building;

  if (memos.size >= MEMO_MAX_KEYS) memos.clear();
  const generation = state.generation;
  state.builds += 1;
  const entry = { value: undefined, expiresAt: 0, building: null };
  entry.building = build().then((value) => {
    if (generation === state.generation) {
      entry.value = value;
      entry.expiresAt = Date.now() + ttl;
      entry.building = null;
      memos.set(key, entry);
    }
    return value;
  }, (err) => {
    if (memos.get(key) === entry) memos.delete(key);
    throw err;
  });
  memos.set(key, entry);
  return entry.building;
};

const invalidate = () => {
  memos.clear();
  state.generation += 1;
  state.invalidations += 1;
  state.value = null;
  state.expiresAt = 0;
  state.building = null;
};

const _fire = (options) => {
  invalidate();
  const tx = options && options.transaction;
  if (tx && typeof tx.afterCommit === 'function') tx.afterCommit(invalidate);
};

const HOOKS = ['afterSave', 'afterDestroy', 'afterBulkCreate', 'afterBulkUpdate', 'afterBulkDestroy', 'afterUpsert', 'afterRestore'];

/** Invalidate on every write to these models (call once per model class). */
const watchModels = (models) => {
  for (const Model of models) {
    if (!Model || Model.__discoveryWatched) continue;
    Model.__discoveryWatched = true;
    for (const hook of HOOKS) {
      Model.addHook(hook, `discovery-cache-${hook}`, (...args) => {
        // afterSave(instance, options), afterBulk*(options), afterUpsert([row], options)
        const options = args.length > 1 ? args[args.length - 1] : args[0];
        _fire(options && typeof options === 'object' ? options : null);
      });
    }
  }
};

const getStats = () => ({
  cached: !!(state.value && Date.now() < state.expiresAt),
  hits: state.hits,
  builds: state.builds,
  invalidations: state.invalidations,
});

const _resetForTests = () => {
  invalidate();
  state.hits = 0;
  state.builds = 0;
  state.invalidations = 0;
};

module.exports = { getSnapshot, memo, invalidate, watchModels, getStats, _resetForTests };
