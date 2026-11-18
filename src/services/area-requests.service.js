/**
 * NEW-265 Part A (R-108, R-109): typed areas, and Google roads / landmarks, are pending area requests,
 * never official areas, until a platform admin approves, merges or rejects them. Spec §13 "NEW-265
 * Part A" A2 (name rules), A3 (host routes), A4 (gym writes), A6 (admin queue), A9 (host-flow rules).
 *
 * One place for:
 *   - the name rules (validateAreaName) used by /check, create and the admin approve;
 *   - the host routes (checkAreaName, createAreaRequest, getAreaRequestForCaller);
 *   - the area choice every gym write makes (parseAreaChoice → resolveAreaChoice → applyChoiceToLink):
 *     a real `areaId`, a pending `areaRequestId`, an explicit clear, or "keep" when neither key is sent;
 *   - the reads (`pendingArea`) and the admin decisions, which write the area to every linked row.
 *
 * A location waits on at most one request (`area_request_links`, UNIQUE target + tenant + target id).
 * Targets: `tenant` (organisation), `main_branch` (draft first branch in main_branch_data_json, before any
 * branch row exists), `listing` (gym_listings), `branch` (branches in the tenant database).
 */
const { Op } = require('sequelize');
const {
  sequelize, City, Area, AreaRequest, AreaRequestLink, AreaAlias, Tenant, GymListing, User, PlatformAuditLog,
} = require('../models/platform');
const { createError } = require('../utils/response.utils');
const moderationWords = require('./moderation-words.service');

// ── A2: name rules ────────────────────────────────────────────────────────────

const NAME_MIN = 3;
const NAME_MAX = 60;
const DAILY_LIMIT = 5;
const CITY_LIMIT = 3;
const SIMILAR_MAX = 3;
const INVALID_MESSAGE = 'Area names are 3 to 60 letters, numbers and . - \' / &';
const BLOCKED_MESSAGE = 'Please choose a different name.';
const REJECTED_MESSAGE = 'That area was not accepted. Please pick your area again.';
const NOT_FOUND_MESSAGE = 'Area request not found';

const ALLOWED = /^[\p{L}\p{M}\p{N} .\-'/&]+$/u;
const LINK = /(^|[\s.])www\.|\.(com|net|org|pk|io|co|info|biz)(\b|$)/iu;

/** Trim, collapse spaces, Unicode NFC. */
const cleanAreaName = (name) => String(name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

/** Lower case, no spaces or punctuation: how two spellings are compared. */
const nameKeyOf = (name) => cleanAreaName(name).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '').slice(0, NAME_MAX);

const invalidName = () => createError(INVALID_MESSAGE, 422, 'area_name_invalid');

/**
 * Throws 422 `area_name_invalid` / `area_name_blocked`; returns the cleaned name. The blocked word is
 * never echoed.
 */
const validateAreaName = async (name) => {
  const clean = cleanAreaName(name);
  if (clean.length < NAME_MIN || clean.length > NAME_MAX) throw invalidName();
  if (!ALLOWED.test(clean)) throw invalidName();
  if ((clean.match(/\p{L}/gu) || []).length < 2) throw invalidName();
  if (/\p{Nd}{7,}/u.test(clean.replace(/\s/g, ''))) throw invalidName();
  if (LINK.test(clean)) throw invalidName();
  if (await moderationWords.containsBlockedWord(clean)) throw createError(BLOCKED_MESSAGE, 422, 'area_name_blocked');
  return clean;
};

const levenshtein = (a, b) => {
  if (a === b) return 0;
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= y.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
};

/** Similar per A2: distance ≤ 1 (6 characters or fewer) or ≤ 2 (longer), or one key contains the other (4+). */
const similarity = (key, other) => {
  if (!key || !other || key === other) return key === other ? 0 : null;
  const d = levenshtein(key, other);
  const limit = Math.max([...key].length, [...other].length) <= 6 ? 1 : 2;
  if (d <= limit) return d;
  const [short, long] = key.length <= other.length ? [key, other] : [other, key];
  if ([...short].length >= 4 && long.includes(short)) return limit + 1 + (long.length - short.length) / 100;
  return null;
};

/** The city's areas and aliases, keyed. */
const cityVocabulary = async (cityId, transaction) => {
  const [areas, aliases] = await Promise.all([
    Area.findAll({ where: { cityId }, attributes: ['id', 'name'], transaction }),
    AreaAlias.findAll({ where: { cityId }, attributes: ['id', 'aliasKey', 'areaId'], transaction }),
  ]);
  const byId = new Map(areas.map((a) => [a.id, a]));
  return { areas, aliases, byId };
};

/** An area of the city whose name or alias has this key, or null. */
const findAreaByKey = async (cityId, key, transaction) => {
  if (!key) return null;
  const { areas, aliases, byId } = await cityVocabulary(cityId, transaction);
  const direct = areas.find((a) => nameKeyOf(a.name) === key);
  if (direct) return direct;
  const alias = aliases.find((a) => a.aliasKey === key);
  return alias ? byId.get(alias.areaId) || null : null;
};

/**
 * Similar names in the city: its areas, aliases (shown as their area) and pending requests. At most 3,
 * closest first. `exactPending` marks another person's pending request with the same key (it groups for
 * the admin, so it does not trigger the "Did you mean …?" refusal).
 */
const findSimilar = async (cityId, key, { excludeUserId = null } = {}) => {
  const { areas, aliases, byId } = await cityVocabulary(cityId);
  const pending = await AreaRequest.findAll({
    where: { cityId, status: 'pending_review' },
    attributes: ['id', 'name', 'nameKey', 'requestedByUserId'],
  });
  const found = [];
  const seenAreas = new Set();
  const seenPending = new Set();
  const consider = (score, entry) => {
    if (score === null) return;
    found.push({ score, ...entry });
  };
  for (const a of areas) consider(similarity(key, nameKeyOf(a.name)), { name: a.name, areaId: a.id, status: 'approved' });
  for (const al of aliases) {
    const area = byId.get(al.areaId);
    if (area) consider(similarity(key, al.aliasKey), { name: area.name, areaId: area.id, status: 'approved' });
  }
  for (const r of pending) {
    if (excludeUserId && r.requestedByUserId === excludeUserId && r.nameKey === key) continue;
    consider(similarity(key, r.nameKey), { name: r.name, areaId: null, status: 'pending_review', exactPending: r.nameKey === key });
  }
  found.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  const out = [];
  for (const f of found) {
    if (f.areaId !== null) {
      if (seenAreas.has(f.areaId)) continue;
      seenAreas.add(f.areaId);
    } else {
      if (seenPending.has(nameKeyOf(f.name))) continue;
      seenPending.add(nameKeyOf(f.name));
    }
    out.push(f);
    if (out.length >= SIMILAR_MAX) break;
  }
  return out;
};

const publicSimilar = (list) => list.map(({ name, areaId, status }) => ({ name, areaId, status }));

const findCityOr404 = async (cityId) => {
  const id = Number(cityId);
  const city = Number.isInteger(id) && id > 0 ? await City.findByPk(id) : null;
  if (!city) throw createError('City not found', 404, 'city_not_found');
  return city;
};

/** Why this person may not open one more request in this city now, or null (R-108 point 4). */
const limitReason = async (userId, cityId, transaction) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const today = await AreaRequest.count({ where: { requestedByUserId: userId, createdAt: { [Op.gte]: since } }, transaction });
  if (today >= DAILY_LIMIT) return 'area_requests_daily_limit';
  const open = await AreaRequest.count({ where: { requestedByUserId: userId, cityId, status: 'pending_review' }, transaction });
  if (open >= CITY_LIMIT) return 'area_requests_city_limit';
  return null;
};
const LIMIT_MESSAGES = {
  area_requests_daily_limit: 'You have asked for 5 new areas today. Please try again tomorrow, or pick an area from the list.',
  area_requests_city_limit: 'You have 3 areas waiting for review in this city. Please wait for them, or pick an area from the list.',
};

const openKeyOf = (userId, cityId, key) => `${userId}:${cityId}:${key}`;

const shapeRequest = (r) => ({ id: r.id, cityId: r.cityId, name: r.name, status: r.status, source: r.source });

const audit = async (actorUserId, action, targetId, details, transaction) => {
  try {
    await PlatformAuditLog.create({
      actorUserId, action, targetType: 'area_request', targetId: String(targetId), details, createdAt: new Date(),
    }, { transaction });
  } catch (err) {
    if (transaction) throw err;
    console.warn(`[areas] audit ${action} not written: ${err.message}`);
  }
};

// ── A3: host routes ───────────────────────────────────────────────────────────

/** POST /places/area-requests/check. Writes nothing. */
const checkAreaName = async ({ userId, cityId, name }) => {
  const city = await findCityOr404(cityId);
  const clean = await validateAreaName(name);
  const key = nameKeyOf(clean);
  const area = await findAreaByKey(city.id, key);
  if (area) return { name: clean, match: { areaId: area.id, name: area.name }, similar: [], canRequest: true, reason: null };
  const own = await AreaRequest.findOne({ where: { openKey: openKeyOf(userId, city.id, key) } });
  const reason = own ? null : await limitReason(userId, city.id);
  const similar = await findSimilar(city.id, key, { excludeUserId: userId });
  return { name: clean, match: null, similar: publicSimilar(similar), canRequest: reason === null, reason };
};

/**
 * Creates (or answers) a request. `confirmNotListed` skips the "Did you mean …?" refusal; Google picks
 * (road / landmark) never get it. Returns { status, body }: 201 { areaRequest }, 200 { area } or 200 { areaRequest }.
 */
const createAreaRequest = async ({ userId, cityId, name, confirmNotListed = false, source = 'typed', googlePlaceId = null }) => {
  const city = await findCityOr404(cityId);
  const clean = await validateAreaName(name);
  const key = nameKeyOf(clean);

  const area = await findAreaByKey(city.id, key);
  if (area) return { status: 200, body: { area: { id: area.id, name: area.name } } };

  const openKey = openKeyOf(userId, city.id, key);
  const own = await AreaRequest.findOne({ where: { openKey } });
  if (own) return { status: 200, body: { areaRequest: shapeRequest(own) } };

  if (source === 'typed' && confirmNotListed !== true) {
    const similar = (await findSimilar(city.id, key, { excludeUserId: userId })).filter((s) => !s.exactPending);
    if (similar.length) {
      const err = createError('Did you mean one of these areas?', 409, 'area_similar_exists');
      err.data = { similar: publicSimilar(similar) };
      throw err;
    }
  }

  // Self-review (owner, 2026-11-17): the limits are counted and the request inserted while this person's
  // user row is locked, so requests sent at the same moment are counted one after the other (before:
  // count-then-insert, 12 at once all passed). Any spelling counts: the limits are per person, not per name.
  let request;
  let existing = false;
  try {
    request = await sequelize.transaction(async (transaction) => {
      await User.findByPk(userId, { attributes: ['id'], lock: transaction.LOCK.UPDATE, transaction });
      const again = await AreaRequest.findOne({ where: { openKey }, transaction });
      if (again) {
        existing = true;
        return again;
      }
      const reason = await limitReason(userId, city.id, transaction);
      if (reason) throw createError(LIMIT_MESSAGES[reason], 429, reason);
      const created = await AreaRequest.create({
        cityId: city.id, name: clean, nameKey: key, source, googlePlaceId, status: 'pending_review', openKey, requestedByUserId: userId,
      }, { transaction });
      await audit(userId, 'areas.request.create', created.id, { cityId: city.id, source }, transaction);
      return created;
    });
  } catch (err) {
    if (err.name !== 'SequelizeUniqueConstraintError') throw err;
    request = await AreaRequest.findOne({ where: { openKey } }); // the same person, twice at once
    existing = true;
  }
  return { status: existing ? 200 : 201, body: { areaRequest: shapeRequest(request) } };
};

/**
 * The request is the caller's, or of the caller's tenant (a link of that tenant, or made by its owner).
 */
const isCallersRequest = async (request, { userId, tenantId }) => {
  if (!request) return false;
  if (request.requestedByUserId === userId) return true;
  if (!tenantId) return false;
  if (await AreaRequestLink.count({ where: { areaRequestId: request.id, tenantId } })) return true;
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'ownerUserId'] });
  return Boolean(tenant && tenant.ownerUserId === request.requestedByUserId);
};

/** GET /places/area-requests/:id */
const getAreaRequestForCaller = async (id, caller) => {
  const n = Number(id);
  const request = Number.isInteger(n) && n > 0 ? await AreaRequest.findByPk(n) : null;
  if (!(await isCallersRequest(request, caller))) throw createError(NOT_FOUND_MESSAGE, 404, 'area_request_not_found');
  const area = request.resolvedAreaId ? await Area.findByPk(request.resolvedAreaId, { attributes: ['id', 'name'] }) : null;
  return {
    areaRequest: {
      id: request.id, cityId: request.cityId, name: request.name, status: request.status,
      area: area ? { id: area.id, name: area.name } : null, rejectReason: request.rejectReason || null,
    },
  };
};

// ── A4: the area choice of a gym write ────────────────────────────────────────

const isEmpty = (v) => v === null || v === '' || v === 0 || v === '0';

/**
 * What a body says about the area (R-109 keep / clear rule):
 *   keep    – neither key sent: the stored area, request, link and marker stay;
 *   clear   – `areaId: null` (and no request), or `areaRequestId: null` (and no area);
 *   area    – a real area id;
 *   request – an area request id.
 * Both a real area and a request → 422 area_choice_conflict.
 */
const parseAreaChoice = (src = {}) => {
  const hasArea = src && Object.prototype.hasOwnProperty.call(src, 'areaId') && src.areaId !== undefined;
  const hasRequest = src && Object.prototype.hasOwnProperty.call(src, 'areaRequestId') && src.areaRequestId !== undefined;
  if (!hasArea && !hasRequest) return { kind: 'keep' };
  const area = hasArea && !isEmpty(src.areaId) ? src.areaId : null;
  const request = hasRequest && !isEmpty(src.areaRequestId) ? src.areaRequestId : null;
  if (area !== null && request !== null) {
    throw createError('Send an area or an area request, not both.', 422, 'area_choice_conflict');
  }
  if (request !== null) return { kind: 'request', requestId: Number(request) };
  if (area !== null) return { kind: 'area', areaId: area };
  return { kind: 'clear' };
};

/**
 * Checks a choice against the record's city and the caller. A request that is already approved / merged
 * becomes its area. Returns the choice with `area` / `request` loaded.
 */
const resolveAreaChoice = async (choice, { cityId, userId, tenantId }) => {
  if (choice.kind === 'keep' || choice.kind === 'clear') return choice;
  const places = require('./places.service');
  if (choice.kind === 'area') {
    const area = await places.assertAreaInCity({ cityId, areaId: choice.areaId });
    return { kind: 'area', areaId: area.id, area };
  }
  const id = Number(choice.requestId);
  const request = Number.isInteger(id) && id > 0 ? await AreaRequest.findByPk(id) : null;
  if (!(await isCallersRequest(request, { userId, tenantId }))) throw createError(NOT_FOUND_MESSAGE, 404, 'area_request_not_found');
  if (!cityId || Number(request.cityId) !== Number(cityId)) {
    throw createError(places.AREA_NOT_LISTED_MESSAGE, 422, 'area_not_listed');
  }
  if (request.status === 'rejected') throw createError(REJECTED_MESSAGE, 422, 'area_request_rejected');
  if ((request.status === 'approved' || request.status === 'merged') && request.resolvedAreaId) {
    const area = await Area.findByPk(request.resolvedAreaId);
    if (area) return { kind: 'area', areaId: area.id, area };
  }
  return { kind: 'request', requestId: request.id, request };
};

/** The values a resolved choice gives a row: { areaId, areaStatus, areaRequestId }, or null for keep. */
const rowValues = (choice) => {
  if (choice.kind === 'keep') return null;
  if (choice.kind === 'request') return { areaId: null, areaStatus: 'pending_review', areaRequestId: choice.requestId };
  return { areaId: choice.kind === 'area' ? choice.areaId : null, areaStatus: null, areaRequestId: null };
};

/** Writes / removes the link of one location for a resolved choice (keep = nothing). */
const applyChoiceToLink = async (choice, { tenantId, target, targetId }, { transaction } = {}) => {
  if (!choice || choice.kind === 'keep' || !tenantId || !targetId) return;
  const where = { target, tenantId, targetId: String(targetId) };
  if (choice.kind !== 'request') {
    await AreaRequestLink.destroy({ where, transaction });
    return;
  }
  const existing = await AreaRequestLink.findOne({ where, transaction });
  if (existing) {
    await existing.update({ areaRequestId: choice.requestId, propagatedAt: null, propagationError: null }, { transaction });
  } else {
    await AreaRequestLink.create({ ...where, areaRequestId: choice.requestId }, { transaction });
  }
};

/** Same-city check for a link kept while the record's city changes (as NEW-259 does for areas). */
const assertKeptLinkInCity = async ({ tenantId, target, targetId, cityId }) => {
  if (!tenantId || !targetId || !cityId) return;
  const link = await AreaRequestLink.findOne({ where: { target, tenantId, targetId: String(targetId) } });
  if (!link) return;
  const request = await AreaRequest.findByPk(link.areaRequestId, { attributes: ['id', 'cityId', 'status'] });
  if (!request || !['pending_review', 'rejected'].includes(request.status)) return;
  if (Number(request.cityId) !== Number(cityId)) {
    const places = require('./places.service');
    throw createError(places.AREA_NOT_LISTED_MESSAGE, 422, 'area_not_listed');
  }
};

/** Removes the link of one location (admin saving a real area, R-109 F7). */
const removeLink = (where, { transaction } = {}) =>
  AreaRequestLink.destroy({ where: { ...where, targetId: String(where.targetId) }, transaction });

// ── Reads: pendingArea ────────────────────────────────────────────────────────

const shapePending = (request) => (request && ['pending_review', 'rejected'].includes(request.status)
  ? { requestId: request.id, name: request.name, status: request.status, rejectReason: request.rejectReason || null }
  : null);

/** pendingArea for many locations of one target: Map<targetId, pendingArea>. */
const pendingAreasFor = async (target, tenantId, targetIds) => {
  const ids = [...new Set((targetIds || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!tenantId || !ids.length) return out;
  const links = await AreaRequestLink.findAll({ where: { target, tenantId, targetId: { [Op.in]: ids } } });
  if (!links.length) return out;
  const requests = await AreaRequest.findAll({ where: { id: { [Op.in]: [...new Set(links.map((l) => l.areaRequestId))] } } });
  const byId = new Map(requests.map((r) => [r.id, r]));
  for (const l of links) {
    const p = shapePending(byId.get(l.areaRequestId));
    if (p) out.set(l.targetId, p);
  }
  return out;
};

const pendingAreaFor = async (target, tenantId, targetId) =>
  (await pendingAreasFor(target, tenantId, [targetId])).get(String(targetId)) || null;

/** Adds `pendingArea` to plain objects (rows) of one target, by `idKey`. */
const withPendingAreas = async (target, tenantId, rows, idKey = 'id') => {
  const list = rows.map((r) => (r && typeof r.toJSON === 'function' ? r.toJSON() : { ...r }));
  const map = await pendingAreasFor(target, tenantId, list.map((r) => r[idKey]));
  return list.map((r) => ({ ...r, pendingArea: map.get(String(r[idKey])) || null }));
};

/**
 * GET /host/status `area` (R-109, F3): what "Choose your area again" needs. A rejected area first
 * (tenant, then draft first branch), else a pending one; null when there is none.
 */
const hostStatusArea = async (tenant) => {
  if (!tenant) return null;
  const tenantPending = await pendingAreaFor('tenant', tenant.id, tenant.id);
  const branchPending = await pendingAreaFor('main_branch', tenant.id, tenant.id);
  const shape = (p, target) => ({ status: p.status, name: p.name, rejectReason: p.rejectReason, target });
  if (tenantPending && tenantPending.status === 'rejected') return shape(tenantPending, 'tenant');
  if (branchPending && branchPending.status === 'rejected') return shape(branchPending, 'main_branch');
  if (tenantPending) return shape(tenantPending, 'tenant');
  if (branchPending) return shape(branchPending, 'main_branch');
  return null;
};

// ── Discovery (A5): which branches wait on a request ─────────────────────────

/** Set of `${tenantId}:${branchId}` whose own link is pending or rejected. */
const waitingBranchKeys = async () => {
  const rows = await AreaRequestLink.findAll({
    where: { target: 'branch' },
    attributes: ['tenantId', 'targetId', 'areaRequestId'],
    raw: true,
  });
  if (!rows.length) return new Set();
  const open = await AreaRequest.findAll({
    where: { id: { [Op.in]: [...new Set(rows.map((r) => r.areaRequestId))] }, status: { [Op.in]: ['pending_review', 'rejected'] } },
    attributes: ['id'],
    raw: true,
  });
  const openIds = new Set(open.map((r) => r.id));
  return new Set(rows.filter((r) => openIds.has(r.areaRequestId)).map((r) => `${r.tenantId}:${r.targetId}`));
};

// ── A9 rule 3: approval (provisioning) carries the links over ─────────────────

const parseJson = (v) => {
  if (typeof v !== 'string') return v || {};
  try { return JSON.parse(v) || {}; } catch { return {}; }
};

/** The open request (pending / rejected) a link points at, or null. */
const openRequestOfLink = async (link) => {
  if (!link) return null;
  const r = await AreaRequest.findByPk(link.areaRequestId);
  return r && ['pending_review', 'rejected'].includes(r.status) ? r : null;
};

/** Provisioning step 3: the new listing takes the tenant's link (copied; the tenant keeps its own). */
const carryTenantLinkToListing = async (tenant, listing) => {
  const tenantLink = await AreaRequestLink.findOne({ where: { target: 'tenant', tenantId: tenant.id, targetId: String(tenant.id) } });
  const request = await openRequestOfLink(tenantLink);
  if (!request) return;
  await applyChoiceToLink({ kind: 'request', requestId: request.id }, { tenantId: tenant.id, target: 'listing', targetId: listing.id });
  await listing.update({ areaId: null, areaStatus: request.status === 'rejected' ? 'rejected' : 'pending_review', areaRequestId: request.id });
};

/**
 * Provisioning step 4: the first branch's area (A9 rule 3). Own area of the draft; else the draft's own
 * link; else (old data) the tenant's first-branch default (R-111) or its link, only when it is in the branch's city; else none.
 * Returns { areaId, link: request | null } for the branch row about to be created.
 */
const firstBranchArea = async (tenant, draft, branchCityId) => {
  const ownLink = await AreaRequestLink.findOne({ where: { target: 'main_branch', tenantId: tenant.id, targetId: String(tenant.id) } });
  const ownRequest = await openRequestOfLink(ownLink);
  if (ownRequest) return { areaId: null, request: ownRequest };
  if (draft.areaId) return { areaId: draft.areaId, request: null };
  if (tenant.areaId && !tenant.areaStatus) {
    const area = await Area.findByPk(tenant.areaId, { attributes: ['id', 'cityId'] });
    return { areaId: area && Number(area.cityId) === Number(branchCityId) ? area.id : null, request: null };
  }
  const tenantLink = await AreaRequestLink.findOne({ where: { target: 'tenant', tenantId: tenant.id, targetId: String(tenant.id) } });
  const tenantRequest = await openRequestOfLink(tenantLink);
  if (tenantRequest && Number(tenantRequest.cityId) === Number(branchCityId)) return { areaId: null, request: tenantRequest };
  return { areaId: null, request: null };
};

/** Provisioning step 4, after the branch exists: main_branch → branch link (or the tenant's, old data). */
const carryLinkToFirstBranch = async (tenant, branch, request) => {
  if (request) {
    await applyChoiceToLink({ kind: 'request', requestId: request.id }, { tenantId: tenant.id, target: 'branch', targetId: branch.id });
  }
  await AreaRequestLink.destroy({ where: { target: 'main_branch', tenantId: tenant.id, targetId: String(tenant.id) } });
};

// ── A6: admin queue ───────────────────────────────────────────────────────────

const PAGE_MAX = 50;

const titleFor = async (link) => {
  const TenantDbManager = require('../database/TenantDbManager');
  const base = { tenantId: link.tenantId, listingId: null, branchId: null, title: null, latitude: null, longitude: null };
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  try {
    if (link.target === 'tenant' || link.target === 'main_branch') {
      const t = await Tenant.findByPk(link.tenantId, { attributes: ['id', 'gymName', 'businessName', 'latitude', 'longitude', 'mainBranchDataJson'] });
      if (!t) return base;
      const mb = parseJson(t.mainBranchDataJson);
      if (link.target === 'main_branch') {
        return { ...base, title: mb.name || t.gymName || t.businessName || null, latitude: num(mb.latitude ?? t.latitude), longitude: num(mb.longitude ?? t.longitude) };
      }
      return { ...base, title: t.gymName || t.businessName || null, latitude: num(t.latitude), longitude: num(t.longitude) };
    }
    if (link.target === 'listing') {
      const l = await GymListing.findByPk(link.targetId, { attributes: ['id', 'title', 'latitude', 'longitude'] });
      return { ...base, listingId: link.targetId, title: l ? l.title : null, latitude: num(l?.latitude), longitude: num(l?.longitude) };
    }
    const t = await Tenant.findByPk(link.tenantId, { attributes: ['id', 'connectionStringEncrypted'] });
    const out = { ...base, branchId: link.targetId };
    if (!t || !t.connectionStringEncrypted || t.connectionStringEncrypted === 'PENDING_PROVISIONING') return out;
    const db = await TenantDbManager.getConnection(t.id, t.connectionStringEncrypted);
    const b = await db.models.Branch.findByPk(link.targetId, { attributes: ['id', 'branchName', 'latitude', 'longitude'] });
    return b ? { ...out, title: b.branchName, latitude: num(b.latitude), longitude: num(b.longitude) } : out;
  } catch {
    return { ...base, ...(link.target === 'branch' ? { branchId: link.targetId } : {}) };
  }
};

/** GET /admin/area-requests: grouped by city and spelling. */
const listForAdmin = async ({ status = 'pending_review', cityId = null, page = 1, limit = 20 } = {}) => {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), PAGE_MAX);
  const pg = Math.max(Number(page) || 1, 1);
  const where = { status };
  if (cityId) where.cityId = Number(cityId);
  const groupsRaw = await AreaRequest.findAll({
    where,
    attributes: ['cityId', 'nameKey', [sequelize.fn('MIN', sequelize.col('created_at')), 'firstRequestedAt']],
    group: ['city_id', 'name_key'],
    order: [[sequelize.fn('MIN', sequelize.col('created_at')), 'ASC'], ['cityId', 'ASC'], ['nameKey', 'ASC']],
    raw: true,
  });
  const total = groupsRaw.length;
  const slice = groupsRaw.slice((pg - 1) * lim, pg * lim);
  const groups = [];
  for (const g of slice) {
    const requests = await AreaRequest.findAll({ where: { ...where, cityId: g.cityId, nameKey: g.nameKey }, order: [['id', 'ASC']] });
    const ids = requests.map((r) => r.id);
    const [city, links, users] = await Promise.all([
      City.findByPk(g.cityId, { attributes: ['id', 'name'] }),
      AreaRequestLink.findAll({ where: { areaRequestId: { [Op.in]: ids } }, order: [['id', 'ASC']] }),
      User.findAll({ where: { id: { [Op.in]: [...new Set(requests.map((r) => r.requestedByUserId))] } }, attributes: ['id', 'fullName'] }),
    ]);
    const gyms = [];
    for (const l of links) gyms.push(await titleFor(l));
    const first = requests[0];
    groups.push({
      requestIds: ids,
      cityId: g.cityId,
      cityName: city ? city.name : null,
      name: first.name,
      source: first.source,
      googlePlaceId: (requests.find((r) => r.googlePlaceId) || {}).googlePlaceId || null,
      gymCount: links.length,
      gyms,
      requestedBy: users.map((u) => ({ userId: u.id, name: u.fullName || null })),
      firstRequestedAt: g.firstRequestedAt,
      similar: publicSimilar((await findSimilar(g.cityId, g.nameKey)).filter((s) => s.areaId !== null)),
    });
  }
  return { groups, pagination: { page: pg, limit: lim, total, totalPages: Math.max(Math.ceil(total / lim), 1) } };
};

const DECIDED_MESSAGE = 'This request was already decided.';

/**
 * Locks the request's group (same city and spelling, id order) and returns the request and the rows a
 * decision applies to. Must run inside `transaction`.
 */
const lockGroup = async (id, applyToGroup, transaction) => {
  const n = Number(id);
  const probe = Number.isInteger(n) && n > 0 ? await AreaRequest.findByPk(n, { transaction }) : null;
  if (!probe) throw createError(NOT_FOUND_MESSAGE, 404, 'area_request_not_found');
  const rows = await AreaRequest.findAll({
    where: { cityId: probe.cityId, nameKey: probe.nameKey },
    order: [['id', 'ASC']],
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  const request = rows.find((r) => r.id === probe.id);
  const targets = applyToGroup
    ? rows.filter((r) => r.id === request.id || r.status === 'pending_review')
    : [request];
  return { request, targets: targets.filter((r) => r.status === 'pending_review') };
};

const isTrue = (v, dflt = true) => (v === undefined || v === null ? dflt : v === true || v === 'true');

const addAlias = async ({ cityId, key, areaId, adminId }, transaction) => {
  if (!key) return;
  const existing = await AreaAlias.findOne({ where: { cityId, aliasKey: key }, transaction });
  if (existing) return;
  const area = await Area.findByPk(areaId, { attributes: ['id', 'name'], transaction });
  if (area && nameKeyOf(area.name) === key) return; // the area's own name: no alias needed
  await AreaAlias.create({ cityId, aliasKey: key, areaId, createdBy: adminId }, { transaction });
};

const notifyRequesters = async (requests, message) => {
  const notifications = require('./notifications.service');
  const seen = new Set();
  for (const r of requests) {
    if (seen.has(r.requestedByUserId)) continue;
    seen.add(r.requestedByUserId);
    try {
      await notifications.createNotification({
        userId: r.requestedByUserId,
        role: 'host',
        type: 'area_request_decided',
        title: 'Area request',
        message: message(r),
        metadataJson: { areaRequestId: r.id, status: r.status },
      });
    } catch (err) {
      console.warn(`[areas] notification not sent: ${err.message}`);
    }
  }
};

/**
 * Writes the area to every linked row of `requestIds` whose link is not propagated yet. A row that cannot
 * be written keeps `propagated_at` NULL and its error, and is listed in `failed` (retry later).
 */
/** The database name in a stored tenant connection URL, or null. */
const databaseOf = (encrypted) => {
  try {
    const { decrypt } = require('../utils/crypto.utils');
    return decodeURIComponent(new URL(decrypt(encrypted)).pathname.replace(/^\//, '')) || null;
  } catch {
    return null;
  }
};

/** A record that moved to another city since it was linked is never given this city's area. */
const assertSameCity = (recordCityId, areaCityId) => {
  if (recordCityId && Number(recordCityId) !== Number(areaCityId)) throw new Error('city_changed');
};

const propagate = async (requestIds, areaId) => {
  const TenantDbManager = require('../database/TenantDbManager');
  const area = await Area.findByPk(areaId, { attributes: ['id', 'cityId'] });
  if (!area) return { propagated: 0, failed: [{ tenantId: null, error: 'area_not_found' }] };
  const links = await AreaRequestLink.findAll({ where: { areaRequestId: { [Op.in]: requestIds }, propagatedAt: null }, order: [['id', 'ASC']] });
  let propagated = 0;
  const failed = [];
  for (const link of links) {
    try {
      const reqId = link.areaRequestId;
      if (link.target === 'tenant') {
        const t = await Tenant.findByPk(link.targetId);
        if (!t) throw new Error('tenant_not_found');
        assertSameCity(t.cityId, area.cityId);
        await t.update({ areaId, areaStatus: null, areaRequestId: null });
      } else if (link.target === 'listing') {
        const l = await GymListing.findByPk(link.targetId);
        if (!l) throw new Error('listing_not_found');
        if (l.tenantId !== link.tenantId) throw new Error('listing_not_of_tenant');
        assertSameCity(l.cityId, area.cityId);
        await l.update({ areaId, areaStatus: null, areaRequestId: null });
      } else if (link.target === 'main_branch') {
        const t = await Tenant.findByPk(link.targetId);
        if (!t) throw new Error('tenant_not_found');
        const mb = { ...parseJson(t.mainBranchDataJson) };
        assertSameCity(mb.cityId || t.cityId, area.cityId);
        if (mb.areaRequestId === undefined || mb.areaRequestId === null || Number(mb.areaRequestId) === Number(reqId)) {
          mb.areaId = areaId;
          delete mb.areaRequestId;
          delete mb.areaStatus;
          delete mb.pendingArea;
          await t.update({ mainBranchDataJson: mb });
        }
      } else {
        const t = await Tenant.findByPk(link.tenantId, { attributes: ['id', 'connectionStringEncrypted', 'dbName'] });
        if (!t || !t.connectionStringEncrypted || t.connectionStringEncrypted === 'PENDING_PROVISIONING') throw new Error('tenant_database_not_ready');
        // Self-review: only the database named in tenants.db_name (the one provisioning built the
        // stored connection from); anything else is refused and reported, never written.
        if (!t.dbName || databaseOf(t.connectionStringEncrypted) !== t.dbName) throw new Error('tenant_database_mismatch');
        const db = await TenantDbManager.getConnection(t.id, t.connectionStringEncrypted);
        const branch = await db.models.Branch.findByPk(link.targetId, { attributes: ['id', 'cityId'] });
        if (!branch) throw new Error('branch_not_found');
        assertSameCity(branch.cityId, area.cityId);
        await db.models.Branch.update({ areaId }, { where: { id: link.targetId } });
      }
      await link.update({ propagatedAt: new Date(), propagationError: null });
      propagated += 1;
    } catch (err) {
      const msg = String(err.message || err).slice(0, 300);
      await link.update({ propagationError: msg }).catch(() => {});
      failed.push({ tenantId: link.tenantId, error: msg });
    }
  }
  try { require('./discovery-cache.service').invalidate(); } catch { /* best effort */ }
  return { propagated, failed };
};

/**
 * Owner decision R-110 (2026-11-17): the pin is optional on approval. Both empty = no coordinates (the
 * admin can add the pin later); one without the other, or out of range = 422 area_coordinates_invalid.
 */
const blank = (v) => v === undefined || v === null || v === '';
const optionalCoordinates = (latitude, longitude) => {
  if (blank(latitude) && blank(longitude)) return { lat: null, lng: null };
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (blank(latitude) || blank(longitude) || !Number.isFinite(lat) || !Number.isFinite(lng)
    || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw createError('Send both latitude (-90 to 90) and longitude (-180 to 180), or neither.', 422, 'area_coordinates_invalid');
  }
  return { lat, lng };
};

/** POST /admin/area-requests/:id/approve */
const approve = async (id, { name, latitude, longitude, applyToGroup } = {}, adminId) => {
  const result = await sequelize.transaction(async (transaction) => {
    const { request, targets } = await lockGroup(id, isTrue(applyToGroup), transaction);
    if (request.status === 'approved') {
      const area = await Area.findByPk(request.resolvedAreaId, { attributes: ['id', 'name'], transaction });
      return { repeat: true, area, targets: [] };
    }
    if (request.status !== 'pending_review') throw createError(DECIDED_MESSAGE, 409, 'area_request_decided');
    const clean = await validateAreaName(name === undefined || name === null || name === '' ? request.name : name);
    const { lat, lng } = optionalCoordinates(latitude, longitude);
    const existing = await findAreaByKey(request.cityId, nameKeyOf(clean), transaction);
    if (existing) {
      const err = createError('An area with this name already exists. Merge the request into it.', 409, 'area_exists');
      err.data = { areaId: existing.id };
      throw err;
    }
    const area = await Area.create({ cityId: request.cityId, name: clean, latitude: lat, longitude: lng }, { transaction });
    for (const r of targets) await addAlias({ cityId: request.cityId, key: r.nameKey, areaId: area.id, adminId }, transaction);
    const now = new Date();
    for (const r of targets) {
      await r.update({ status: 'approved', resolvedAreaId: area.id, openKey: null, decidedBy: adminId, decidedAt: now }, { transaction });
    }
    await audit(adminId, 'areas.request.approve', request.id, { requestIds: targets.map((r) => r.id), areaId: area.id }, transaction);
    return { repeat: false, area, targets };
  });
  if (result.repeat) return { area: result.area ? { id: result.area.id, name: result.area.name } : null, decided: 0, propagated: 0, failed: [] };
  const { propagated, failed } = await propagate(result.targets.map((r) => r.id), result.area.id);
  await notifyRequesters(result.targets, (r) => `${r.name} was added`);
  return { area: { id: result.area.id, name: result.area.name }, decided: result.targets.length, propagated, failed };
};

/** POST /admin/area-requests/:id/merge */
const merge = async (id, { areaId, applyToGroup } = {}, adminId) => {
  const result = await sequelize.transaction(async (transaction) => {
    const { request, targets } = await lockGroup(id, isTrue(applyToGroup), transaction);
    const areaNum = Number(areaId);
    if (request.status === 'merged' && Number(request.resolvedAreaId) === areaNum) {
      const area = await Area.findByPk(request.resolvedAreaId, { attributes: ['id', 'name'], transaction });
      return { repeat: true, area, targets: [] };
    }
    if (request.status !== 'pending_review') throw createError(DECIDED_MESSAGE, 409, 'area_request_decided');
    const area = Number.isInteger(areaNum) && areaNum > 0 ? await Area.findByPk(areaNum, { transaction }) : null;
    if (!area || Number(area.cityId) !== Number(request.cityId)) {
      const places = require('./places.service');
      throw createError(places.AREA_NOT_LISTED_MESSAGE, 422, 'area_not_listed');
    }
    for (const r of targets) await addAlias({ cityId: request.cityId, key: r.nameKey, areaId: area.id, adminId }, transaction);
    const now = new Date();
    for (const r of targets) {
      await r.update({ status: 'merged', resolvedAreaId: area.id, openKey: null, decidedBy: adminId, decidedAt: now }, { transaction });
    }
    await audit(adminId, 'areas.request.merge', request.id, { requestIds: targets.map((r) => r.id), areaId: area.id }, transaction);
    return { repeat: false, area, targets };
  });
  if (result.repeat) return { area: { id: result.area.id, name: result.area.name }, decided: 0, propagated: 0, failed: [] };
  const { propagated, failed } = await propagate(result.targets.map((r) => r.id), result.area.id);
  await notifyRequesters(result.targets, (r) => `${r.name} was matched to ${result.area.name}`);
  return { area: { id: result.area.id, name: result.area.name }, decided: result.targets.length, propagated, failed };
};

/** POST /admin/area-requests/:id/reject */
const reject = async (id, { reason, applyToGroup } = {}, adminId) => {
  const text = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 3 || text.length > 300) throw createError('Give a reason of 3 to 300 characters.', 422, 'validation_error');
  const result = await sequelize.transaction(async (transaction) => {
    const { request, targets } = await lockGroup(id, isTrue(applyToGroup), transaction);
    if (request.status === 'rejected') return { repeat: true, targets: [] };
    if (request.status !== 'pending_review') throw createError(DECIDED_MESSAGE, 409, 'area_request_decided');
    const now = new Date();
    for (const r of targets) {
      await r.update({ status: 'rejected', rejectReason: text, openKey: null, decidedBy: adminId, decidedAt: now }, { transaction });
    }
    const ids = targets.map((r) => r.id);
    // The gyms' markers (R-109): tenants, listings and draft first branches; branch rows keep their link.
    const links = await AreaRequestLink.findAll({ where: { areaRequestId: { [Op.in]: ids } }, transaction });
    for (const l of links) {
      if (l.target === 'tenant') {
        await Tenant.update({ areaStatus: 'rejected' }, { where: { id: l.targetId, areaRequestId: l.areaRequestId }, transaction });
      } else if (l.target === 'listing') {
        await GymListing.update({ areaStatus: 'rejected' }, { where: { id: l.targetId, areaRequestId: l.areaRequestId }, transaction });
      } else if (l.target === 'main_branch') {
        const t = await Tenant.findByPk(l.targetId, { transaction });
        if (t) {
          const mb = { ...parseJson(t.mainBranchDataJson) };
          if (Number(mb.areaRequestId) === Number(l.areaRequestId)) {
            mb.areaStatus = 'rejected';
            await t.update({ mainBranchDataJson: mb }, { transaction });
          }
        }
      }
    }
    await audit(adminId, 'areas.request.reject', request.id, { requestIds: ids }, transaction);
    return { repeat: false, targets };
  });
  if (!result.repeat) {
    try { require('./discovery-cache.service').invalidate(); } catch { /* best effort */ }
    await notifyRequesters(result.targets, (r) => `${r.name} was not accepted: ${text}. Please pick your area again.`);
  }
  return { decided: result.targets.length };
};

/** POST /admin/area-requests/:id/retry: re-runs the writes whose propagated_at is NULL. */
const retry = async (id) => {
  const n = Number(id);
  const request = Number.isInteger(n) && n > 0 ? await AreaRequest.findByPk(n) : null;
  if (!request) throw createError(NOT_FOUND_MESSAGE, 404, 'area_request_not_found');
  if (!['approved', 'merged'].includes(request.status) || !request.resolvedAreaId) return { propagated: 0, failed: [] };
  return propagate([request.id], request.resolvedAreaId);
};

/** GET /admin/areas/:areaId/aliases */
const listAliases = async (areaId) => {
  const area = await Area.findByPk(Number(areaId), { attributes: ['id', 'cityId', 'name'] });
  if (!area) throw createError('Area not found', 404, 'area_not_found');
  const aliases = await AreaAlias.findAll({ where: { areaId: area.id }, order: [['aliasKey', 'ASC']] });
  return { area: { id: area.id, cityId: area.cityId, name: area.name }, aliases: aliases.map((a) => ({ id: a.id, aliasKey: a.aliasKey, createdAt: a.createdAt })) };
};

/** DELETE /admin/area-aliases/:id */
const deleteAlias = async (id, adminId) => {
  const alias = await AreaAlias.findByPk(Number(id));
  if (!alias) throw createError('Alias not found', 404, 'area_alias_not_found');
  await sequelize.transaction(async (transaction) => {
    await alias.destroy({ transaction });
    await PlatformAuditLog.create({
      actorUserId: adminId, action: 'areas.alias.delete', targetType: 'area_alias', targetId: String(alias.id),
      details: { areaId: alias.areaId, cityId: alias.cityId }, createdAt: new Date(),
    }, { transaction });
  });
  return { deleted: true };
};

module.exports = {
  cleanAreaName,
  nameKeyOf,
  validateAreaName,
  findAreaByKey,
  checkAreaName,
  createAreaRequest,
  getAreaRequestForCaller,
  parseAreaChoice,
  resolveAreaChoice,
  rowValues,
  applyChoiceToLink,
  assertKeptLinkInCity,
  removeLink,
  pendingAreaFor,
  pendingAreasFor,
  withPendingAreas,
  hostStatusArea,
  waitingBranchKeys,
  carryTenantLinkToListing,
  firstBranchArea,
  carryLinkToFirstBranch,
  listForAdmin,
  approve,
  merge,
  reject,
  retry,
  listAliases,
  deleteAlias,
  REJECTED_MESSAGE,
};
