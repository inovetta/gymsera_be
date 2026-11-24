/**
 * NEW-256 (App Store 1.2, Google Play UGC policy): report, block and the word filter.
 *
 *  - POST /reports: a signed-in person reports a visible review, or a message in their own
 *    conversation (traveller side or the gym's side). One report per person per item. A reported
 *    review is hidden from the reporter at once; others still see it.
 *  - Blocks: a traveller blocks the gym, or the gym blocks the traveller. Messages are refused both
 *    ways (every send path, REST and socket, goes through inbox.service); the conversation is hidden
 *    only for the side that blocked; unblocking restores sending.
 *  - Word filter: a listed word (whole word, any case) refuses a chat message or a review (422
 *    content_blocked); platform admins replace the list.
 *  - Admin queue: platform admins list, open and act (dismiss, hide review, delete message, suspend
 *    author); one decision closes every open report on the same item; others get 403.
 */
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { createUser } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');
const { Conversation, Message, GymReview, ContentReport, UserBlock, User, RefreshToken, sequelize } =
  require('../../src/models/platform');
const inbox = require('../../src/services/inbox.service');
const discoveryService = require('../../src/services/discovery.service');
const moderationWords = require('../../src/services/moderation-words.service');
const { settingsFor } = require('../../src/middleware/rateLimiters');
const { STARTER_WORDS } = require('../../src/constants/moderation');

let personas;
let ctx;
let organizationId;

const tokenFor = (user) =>
  signToken({ sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true });

/** A supertest caller for an ad-hoc traveller (personas only have one member). */
const asUser = (user) => {
  const request = require('supertest');
  const server = require('../harness/personas').personaManager.server;
  const path = (p) => `/api/v1${p}`;
  const auth = (req) => req.set('Authorization', `Bearer ${tokenFor(user)}`).set('Accept', 'application/json');
  return {
    get: (p) => auth(request(server).get(path(p))),
    post: (p, body) => auth(request(server).post(path(p))).send(body),
  };
};

const newConversation = (userId, tid = organizationId) =>
  Conversation.create({ id: uuidv4(), organizationId: tid, branchId: ctx.branch1.id, userId, type: 'INQUIRY' });

const newReview = (userId, status = 'APPROVED', extra = {}) =>
  GymReview.create({
    businessId: ctx.listing1.id,
    branchId: ctx.branch1.id,
    organizationId,
    userId,
    rating: 2,
    title: 'Not great',
    body: 'Crowded at night',
    status,
    ...extra,
  });

const reviewIdsIn = (res) => (res.body.data.reviews || []).map((r) => r.id);

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  ctx = require('../harness/personas').personaManager.context;
  organizationId = personas.owner.organizationId;
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

beforeEach(() => moderationWords.clearCache());

describe('POST /reports', () => {
  test('needs a signed-in person', async () => {
    const res = await asPersona('anonymous').post('/reports', { targetType: 'REVIEW', targetId: uuidv4(), reason: 'SPAM' });
    expect(res.status).toBe(401);
  });

  test('a review: 201 OPEN, a repeat is the same report (200), and it is hidden from the reporter only', async () => {
    const author = await createUser({ role: 'MEMBER' });
    const bystander = await createUser({ role: 'MEMBER' });
    const review = await newReview(author.id);

    const res = await asPersona('member').post('/reports', { targetType: 'review', targetId: review.id, reason: 'harassment', note: 'rude' });
    expect(res.status).toBe(201);
    expect(res.body.data.report).toMatchObject({ status: 'OPEN', targetType: 'REVIEW', targetId: review.id });
    const again = await asPersona('member').post('/reports', { targetType: 'REVIEW', targetId: review.id, reason: 'SPAM' });
    expect(again.status).toBe(200);
    expect(again.body.data.report.id).toBe(res.body.data.report.id);

    const row = await ContentReport.findByPk(res.body.data.report.id);
    expect(row).toMatchObject({ reporterUserId: personas.member.user.id, targetUserId: author.id, organizationId, reason: 'HARASSMENT', note: 'rude' });
    expect(row.snapshotText).toBe('Not great\nCrowded at night');

    const path = `/discovery/businesses/${ctx.listing1.id}/reviews`;
    expect(reviewIdsIn(await asPersona('member').get(path))).not.toContain(review.id);
    expect(reviewIdsIn(await asPersona('anonymous').get(path))).toContain(review.id);
    expect(reviewIdsIn(await asUser(bystander).get(path))).toContain(review.id);
    // An expired or forged token on a public read is anonymous, not a 401.
    const forged = await asPersona('anonymous', { Authorization: 'Bearer not-a-token' }).get(path);
    expect(forged.status).toBe(200);
    expect(reviewIdsIn(forged)).toContain(review.id);

    // The branch listing (service) hides it from the reporter too.
    const viaBranch = await discoveryService.listReviews(ctx.listing1.id, ctx.branch1.id, { page: 1, limit: 50, offset: 0, viewerUserId: personas.member.user.id });
    expect(viaBranch.reviews.map((r) => r.id)).not.toContain(review.id);

    // The gym page's preview review (the newest) is never one the viewer reported; totals unchanged.
    const mine = await discoveryService.getReviewsSummary(ctx.listing1.id, ctx.branch1.id, { viewerUserId: personas.member.user.id });
    const theirs = await discoveryService.getReviewsSummary(ctx.listing1.id, ctx.branch1.id, { viewerUserId: bystander.id });
    expect(theirs.previewReview.id).toBe(review.id);
    expect(mine.previewReview?.id).not.toBe(review.id);
    expect(mine.totalReviews).toBe(theirs.totalReviews);
  });

  test('own review: 400; a review nobody can see (PENDING): 404', async () => {
    const mine = await newReview(personas.member.user.id);
    const own = await asPersona('member').post('/reports', { targetType: 'REVIEW', targetId: mine.id, reason: 'SPAM' });
    expect(own.status).toBe(400);
    expect(own.body.code || own.body.error?.code).toBe('own_content');

    const other = await createUser({ role: 'MEMBER' });
    const pending = await newReview(other.id, 'PENDING');
    const res = await asPersona('member').post('/reports', { targetType: 'REVIEW', targetId: pending.id, reason: 'SPAM' });
    expect(res.status).toBe(404);
    await mine.destroy();
  });

  test('a bad body is refused: unknown target type, missing reason, unknown field', async () => {
    const id = uuidv4();
    expect((await asPersona('member').post('/reports', { targetType: 'USER', targetId: id, reason: 'SPAM' })).status).toBe(422);
    expect((await asPersona('member').post('/reports', { targetType: 'REVIEW', targetId: id })).status).toBe(422);
    expect((await asPersona('member').post('/reports', { targetType: 'REVIEW', targetId: id, reason: 'SPAM', evil: 1 })).status).toBe(422);
  });

  test('a message: the gym reports the traveller, the traveller reports the gym; outsiders get 404; own message 400', async () => {
    const conv = await newConversation(personas.member.user.id);
    const fromMember = await inbox.replyAsUser(conv.id, personas.member.user.id, 'please call me back');
    const fromGym = await inbox.replyToInquiry(conv.id, personas.owner.user.id, 'we are closed today', organizationId);

    const byGym = await asPersona('owner').post('/reports', { targetType: 'MESSAGE', targetId: fromMember.id, reason: 'SPAM' });
    expect(byGym.status).toBe(201);
    const row = await ContentReport.findByPk(byGym.body.data.report.id);
    expect(row).toMatchObject({ targetUserId: personas.member.user.id, conversationId: conv.id, organizationId, snapshotText: 'please call me back' });

    const byMember = await asPersona('member').post('/reports', { targetType: 'MESSAGE', targetId: fromGym.id, reason: 'OTHER', note: 'wrong info' });
    expect(byMember.status).toBe(201);

    const outsider = await asPersona('otherTenantOwner').post('/reports', { targetType: 'MESSAGE', targetId: fromMember.id, reason: 'SPAM' });
    expect(outsider.status).toBe(404);
    const stranger = await asUser(await createUser({ role: 'MEMBER' })).post('/reports', { targetType: 'MESSAGE', targetId: fromGym.id, reason: 'SPAM' });
    expect(stranger.status).toBe(404);

    const own = await asPersona('member').post('/reports', { targetType: 'MESSAGE', targetId: fromMember.id, reason: 'SPAM' });
    expect(own.status).toBe(400);
  });

  test('reporting is rate-limited per person in production (30 an hour by default)', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(settingsFor('REPORT_USER')).toEqual({ windowMs: 3600 * 1000, max: 30 });
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe('blocking in chat', () => {
  const codeOf = (res) => res.body.code || res.body.error?.code;
  const memberInbox = async () => (await asPersona('member').get('/me/inbox')).body.data.conversations.map((c) => c.id);
  const hostInbox = async () => (await asPersona('owner').get('/host/inbox/inquiries')).body.data.map((c) => c.id);

  afterEach(async () => {
    await UserBlock.destroy({ where: {} });
  });

  /** The lists link the newest conversation of the blocked pair (a block is per gym, not per conversation). */
  const expectPairConversation = async (conversationId, userId, tid) => {
    const c = await Conversation.findByPk(conversationId);
    expect(c).toMatchObject({ userId, organizationId: tid });
  };

  test('the traveller blocks the gym: no messages either way, hidden for the traveller only, unblock restores', async () => {
    const conv = await newConversation(personas.member.user.id);
    await inbox.replyAsUser(conv.id, personas.member.user.id, 'hello');

    const blocked = await asPersona('member').post(`/me/inbox/${conv.id}/block`);
    expect(blocked.status).toBe(200);
    expect(blocked.body.data.block).toEqual({ blockedByMe: true, blockedByOther: false, canSend: false });

    const memberSend = await asPersona('member').post(`/me/inbox/${conv.id}/reply`, { text: 'again' });
    expect(memberSend.status).toBe(403);
    expect(codeOf(memberSend)).toBe('conversation_blocked');
    const gymSend = await asPersona('owner').post(`/host/inbox/inquiries/${conv.id}/reply`, { text: 'hi' });
    expect(gymSend.status).toBe(403);
    expect(codeOf(gymSend)).toBe('conversation_blocked');
    // New inquiry to the same gym (discovery "Message gym") is refused too.
    await expect(inbox.createTravelerInquiry(personas.member.user.id, ctx.listing1.id, 'new one'))
      .rejects.toMatchObject({ statusCode: 403, code: 'conversation_blocked' });

    expect(await memberInbox()).not.toContain(conv.id);
    expect(await hostInbox()).toContain(conv.id);
    const hostView = await asPersona('owner').get(`/host/inbox/inquiries/${conv.id}`);
    expect(hostView.body.data.block).toEqual({ blockedByMe: false, blockedByOther: true, canSend: false });

    const list = await asPersona('member').get('/me/blocks');
    expect(list.body.data.blocks).toEqual([expect.objectContaining({ organizationId, name: expect.any(String) })]);
    await expectPairConversation(list.body.data.blocks[0].conversationId, personas.member.user.id, organizationId);

    const unblocked = await asPersona('member').delete(`/me/inbox/${conv.id}/block`);
    expect(unblocked.body.data.block).toEqual({ blockedByMe: false, blockedByOther: false, canSend: true });
    expect((await asPersona('member').post(`/me/inbox/${conv.id}/reply`, { text: 'back' })).status).toBe(201);
    expect(await memberInbox()).toContain(conv.id);
  });

  test('the gym blocks the traveller: no messages either way, hidden for the gym only', async () => {
    const conv = await newConversation(personas.member.user.id);
    const res = await asPersona('owner').post(`/host/inbox/inquiries/${conv.id}/block`);
    expect(res.status).toBe(200);
    expect(res.body.data.block).toEqual({ blockedByMe: true, blockedByOther: false, canSend: false });

    expect((await asPersona('member').post(`/me/inbox/${conv.id}/reply`, { text: 'hi' })).status).toBe(403);
    expect((await asPersona('owner').post(`/host/inbox/inquiries/${conv.id}/reply`, { text: 'hi' })).status).toBe(403);
    // A gym opening a conversation with a message, to a traveller it blocked, is refused.
    await expect(inbox.findOrCreateHostConversation(organizationId, personas.member.user.id, ctx.branch1.id, 'promo'))
      .rejects.toMatchObject({ statusCode: 403 });

    expect(await hostInbox()).not.toContain(conv.id);
    expect(await memberInbox()).toContain(conv.id);
    const memberView = await asPersona('member').get(`/me/inbox/${conv.id}`);
    expect(memberView.body.data.block).toEqual({ blockedByMe: false, blockedByOther: true, canSend: false });

    const list = await asPersona('owner').get('/host/inbox/blocks');
    expect(list.body.data.blocks).toEqual([expect.objectContaining({ userId: personas.member.user.id, name: 'Gym Member' })]);
    await expectPairConversation(list.body.data.blocks[0].conversationId, personas.member.user.id, organizationId);

    await asPersona('owner').delete(`/host/inbox/inquiries/${conv.id}/block`);
    expect((await asPersona('owner').post(`/host/inbox/inquiries/${conv.id}/reply`, { text: 'sorry' })).status).toBe(201);
  });

  test('both sides blocked: each unblock removes only its own side', async () => {
    const conv = await newConversation(personas.member.user.id);
    await asPersona('member').post(`/me/inbox/${conv.id}/block`);
    await asPersona('owner').post(`/host/inbox/inquiries/${conv.id}/block`);
    await asPersona('member').delete(`/me/inbox/${conv.id}/block`);
    const view = await asPersona('member').get(`/me/inbox/${conv.id}`);
    expect(view.body.data.block).toEqual({ blockedByMe: false, blockedByOther: true, canSend: false });
    expect(await UserBlock.count({ where: { userId: personas.member.user.id, organizationId } })).toBe(1);
  });

  test('only a party to the conversation can block it', async () => {
    const conv = await newConversation(personas.member.user.id);
    expect((await asPersona('otherTenantOwner').post(`/host/inbox/inquiries/${conv.id}/block`)).status).toBe(404);
    const stranger = await createUser({ role: 'MEMBER' });
    expect((await asUser(stranger).post(`/me/inbox/${conv.id}/block`)).status).toBe(404);
    expect(await UserBlock.count()).toBe(0);
  });

  test('the socket path (same service) is refused with the code', async () => {
    const conv = await newConversation(personas.member.user.id);
    await asPersona('owner').post(`/host/inbox/inquiries/${conv.id}/block`);
    await expect(inbox.replyAsUser(conv.id, personas.member.user.id, 'via socket'))
      .rejects.toMatchObject({ statusCode: 403, code: 'conversation_blocked' });
    expect(await Message.count({ where: { conversationId: conv.id } })).toBe(0);
  });
});

describe('word filter', () => {
  const codeOf = (res) => res.body.code || res.body.error?.code;

  // The seed itself is proven by platform-migrations-p031 (a local test database keeps
  // schema_migrations between runs, so p031 does not seed it again here).
  beforeAll(async () => {
    await moderationWords.replaceWords([...STARTER_WORDS]);
  });

  test('the list is the starter list', async () => {
    expect([...(await moderationWords.getWords())].sort()).toEqual([...STARTER_WORDS].sort());
  });

  test('a chat message with a listed word is refused (any case, whole words only); nothing is stored', async () => {
    const conv = await newConversation(personas.member.user.id);
    const bad = await asPersona('member').post(`/me/inbox/${conv.id}/reply`, { text: 'you are a BITCH' });
    expect(bad.status).toBe(422);
    expect(codeOf(bad)).toBe('content_blocked');
    const gym = await asPersona('owner').post(`/host/inbox/inquiries/${conv.id}/reply`, { text: 'Shit happens' });
    expect(gym.status).toBe(422);
    expect(await Message.count({ where: { conversationId: conv.id } })).toBe(0);
    // Part of a longer word is not a match.
    expect((await asPersona('member').post(`/me/inbox/${conv.id}/reply`, { text: 'Shitake soup at the cafe?' })).status).toBe(201);
    await expect(inbox.createTravelerInquiry(personas.member.user.id, ctx.listing1.id, 'fuck this'))
      .rejects.toMatchObject({ statusCode: 422, code: 'content_blocked' });
  });

  test('a review with a listed word is refused before anything is stored', async () => {
    const before = await GymReview.count();
    await expect(discoveryService.submitReview(personas.member.user.id, ctx.listing1.id, ctx.branch1.id, { rating: 1, title: 'ok', body: 'the owner is an asshole' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'content_blocked' });
    expect(await GymReview.count()).toBe(before);
  });

  test('platform admins replace the list; it applies at once; others get 403; bad words 422', async () => {
    const original = await moderationWords.getWords();
    try {
      expect((await asPersona('owner').put('/admin/moderation/words', { words: ['x'] })).status).toBe(403);
      expect((await asPersona('platformAdmin').put('/admin/moderation/words', { words: ['a'] })).status).toBe(422);

      const saved = await asPersona('platformAdmin').put('/admin/moderation/words', { words: [' Scam ', 'idiot', 'scam'] });
      expect(saved.status).toBe(200);
      expect(saved.body.data.words).toEqual(['idiot', 'scam']);
      expect((await asPersona('platformAdmin').get('/admin/moderation/words')).body.data.words).toEqual(['idiot', 'scam']);

      const conv = await newConversation(personas.member.user.id);
      expect((await asPersona('member').post(`/me/inbox/${conv.id}/reply`, { text: 'This is a scam' })).status).toBe(422);
      expect((await asPersona('member').post(`/me/inbox/${conv.id}/reply`, { text: 'bitch' })).status).toBe(201);
    } finally {
      await moderationWords.replaceWords(original);
    }
  });
});

describe('admin report queue', () => {
  const codeOf = (res) => res.body.code || res.body.error?.code;

  beforeEach(async () => {
    await ContentReport.destroy({ where: {} });
  });

  test('platform admins only', async () => {
    expect((await asPersona('owner').get('/admin/reports')).status).toBe(403);
    expect((await asPersona('member').get('/admin/reports')).status).toBe(403);
  });

  test('the queue lists open reports oldest first with open and overdue (> 24 h) counts', async () => {
    const a = await newReview((await createUser({ role: 'MEMBER' })).id);
    const b = await newReview((await createUser({ role: 'MEMBER' })).id);
    const r1 = (await asPersona('member').post('/reports', { targetType: 'REVIEW', targetId: a.id, reason: 'SPAM' })).body.data.report;
    const r2 = (await asPersona('member').post('/reports', { targetType: 'REVIEW', targetId: b.id, reason: 'HATE' })).body.data.report;
    await sequelize.query('UPDATE content_reports SET created_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 25 HOUR) WHERE id = ?', { replacements: [r1.id] });

    const res = await asPersona('platformAdmin').get('/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toEqual({ open: 2, overdue: 1 });
    expect(res.body.data.responseHours).toBe(24);
    expect(res.body.data.reports.map((r) => r.id)).toEqual([r1.id, r2.id]);
    expect(res.body.data.reports[0]).toMatchObject({ overdue: true, allowedActions: ['DISMISS', 'HIDE_REVIEW', 'SUSPEND_USER'] });
    expect(res.body.data.reports[0].reporter).toMatchObject({ id: personas.member.user.id });

    const one = await asPersona('platformAdmin').get(`/admin/reports/${r2.id}`);
    expect(one.body.data.report.current).toMatchObject({ exists: true, status: 'APPROVED' });
  });

  test('hide the review: it is REJECTED, gone from public lists, and every open report on it closes', async () => {
    const review = await newReview((await createUser({ role: 'MEMBER' })).id);
    const other = await createUser({ role: 'MEMBER' });
    const r1 = (await asPersona('member').post('/reports', { targetType: 'REVIEW', targetId: review.id, reason: 'SPAM' })).body.data.report;
    await asUser(other).post('/reports', { targetType: 'REVIEW', targetId: review.id, reason: 'HATE' });

    const res = await asPersona('platformAdmin').patch(`/admin/reports/${r1.id}`, { action: 'HIDE_REVIEW', adminNote: 'abusive' });
    expect(res.status).toBe(200);
    expect(res.body.data.closedOthers).toBe(1);
    expect((await GymReview.findByPk(review.id)).status).toBe('REJECTED');
    expect(await ContentReport.count({ where: { targetId: review.id, status: 'OPEN' } })).toBe(0);
    expect(await ContentReport.count({ where: { targetId: review.id, status: 'ACTIONED', action: 'HIDE_REVIEW' } })).toBe(2);
    expect(reviewIdsIn(await asPersona('anonymous').get(`/discovery/businesses/${ctx.listing1.id}/reviews`))).not.toContain(review.id);

    const again = await asPersona('platformAdmin').patch(`/admin/reports/${r1.id}`, { action: 'DISMISS' });
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('report_closed');
  });

  test('delete the message: the row is gone, the report keeps the text, the conversation preview is replaced', async () => {
    const conv = await newConversation(personas.member.user.id);
    const msg = await inbox.replyToInquiry(conv.id, personas.owner.user.id, 'nasty words here', organizationId);
    const report = (await asPersona('member').post('/reports', { targetType: 'MESSAGE', targetId: msg.id, reason: 'HARASSMENT' })).body.data.report;

    const wrong = await asPersona('platformAdmin').patch(`/admin/reports/${report.id}`, { action: 'HIDE_REVIEW' });
    expect(wrong.status).toBe(422);
    expect(codeOf(wrong)).toBe('action_not_allowed');

    const res = await asPersona('platformAdmin').patch(`/admin/reports/${report.id}`, { action: 'DELETE_MESSAGE' });
    expect(res.status).toBe(200);
    expect(await Message.findByPk(msg.id)).toBeNull();
    expect(res.body.data.report).toMatchObject({ status: 'ACTIONED', action: 'DELETE_MESSAGE', snapshotText: 'nasty words here' });
    expect(res.body.data.report.current).toEqual({ exists: false });
    expect((await Conversation.findByPk(conv.id)).lastMessageText).toBe('Message removed');
  });

  test('suspend the author: the account is SUSPENDED and its sessions are revoked; dismiss closes without action', async () => {
    const author = await createUser({ role: 'MEMBER' });
    const conv = await newConversation(author.id);
    const msg = await inbox.replyAsUser(conv.id, author.id, 'spam spam');
    await RefreshToken.create({ userId: author.id, token: `t-${uuidv4()}`, familyId: uuidv4(), expiresAt: new Date(Date.now() + 86400000) });
    const report = (await asPersona('owner').post('/reports', { targetType: 'MESSAGE', targetId: msg.id, reason: 'SPAM' })).body.data.report;

    const res = await asPersona('platformAdmin').patch(`/admin/reports/${report.id}`, { action: 'SUSPEND_USER' });
    expect(res.status).toBe(200);
    expect((await User.findByPk(author.id)).status).toBe('SUSPENDED');
    expect(await RefreshToken.count({ where: { userId: author.id, isRevoked: false } })).toBe(0);

    const review = await newReview((await createUser({ role: 'MEMBER' })).id);
    const r2 = (await asPersona('member').post('/reports', { targetType: 'REVIEW', targetId: review.id, reason: 'SPAM' })).body.data.report;
    const dismissed = await asPersona('platformAdmin').patch(`/admin/reports/${r2.id}`, { action: 'dismiss', adminNote: 'fine' });
    expect(dismissed.body.data.report).toMatchObject({ status: 'DISMISSED', action: 'DISMISS', adminNote: 'fine' });
    expect((await GymReview.findByPk(review.id)).status).toBe('APPROVED');
  });
});
