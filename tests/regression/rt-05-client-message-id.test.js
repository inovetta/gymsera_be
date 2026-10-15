/**
 * RT-05 — a resent message is not a second message.
 *
 * `messages.client_message_id` is a client-generated key. UNIQUE
 * (conversation_id, sender_id, client_message_id) makes a resend (retry after a
 * timeout, socket reconnect, double tap) return the original row on all three
 * insert paths: host reply, traveler reply and new inquiry. A message without a
 * key behaves as before (NULLs never collide).
 */
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { Conversation, Message, City } = require('../../src/models/platform');
const inbox = require('../../src/services/inbox.service');

describe('RT-05: client_message_id idempotency', () => {
  let tenant;
  let traveler;
  let host;
  let conversation;

  beforeAll(async () => {
    await setupTestDatabases();
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenant = await factories.createTenant();
    traveler = await factories.createUser();
    host = await factories.createUser();
    conversation = await Conversation.create({
      id: uuidv4(), tenantId: tenant.id, branchId: uuidv4(), userId: traveler.id, type: 'INQUIRY',
    });
  });

  const count = (where) => Message.count({ where });

  test('traveler reply: resend with the same key returns the original and changes nothing', async () => {
    const key = uuidv4();
    const first = await inbox.replyAsUser(conversation.id, traveler.id, 'hello', { clientMessageId: key });
    const again = await inbox.replyAsUser(conversation.id, traveler.id, 'hello', { clientMessageId: key });

    expect(again.id).toBe(first.id);
    expect(await count({ conversationId: conversation.id })).toBe(1);
    await conversation.reload();
    expect(conversation.unreadCountHost).toBe(1); // not 2
  });

  test('host reply: resend returns the original and does not bump unread again', async () => {
    const key = uuidv4();
    const first = await inbox.replyToInquiry(conversation.id, host.id, 'welcome', tenant.id, { clientMessageId: key });
    const again = await inbox.replyToInquiry(conversation.id, host.id, 'welcome', tenant.id, { clientMessageId: key });

    expect(again.id).toBe(first.id);
    expect(await count({ conversationId: conversation.id })).toBe(1);
    await conversation.reload();
    expect(conversation.unreadCountUser).toBe(1);
  });

  test('new inquiry: resend returns the same message and conversation', async () => {
    const listing = await factories.createGymListing(tenant.id, { branchId: uuidv4(), cityId: 1 });
    const key = uuidv4();
    const first = await inbox.createTravelerInquiry(traveler.id, listing.branchId, 'is it open?', { clientMessageId: key });
    const again = await inbox.createTravelerInquiry(traveler.id, listing.branchId, 'is it open?', { clientMessageId: key });

    expect(again.message.id).toBe(first.message.id);
    expect(again.conversation.id).toBe(first.conversation.id);
    expect(await count({ conversationId: first.conversation.id })).toBe(1);
    const conv = await Conversation.findByPk(first.conversation.id);
    expect(conv.unreadCountHost).toBe(1);
  });

  test('concurrent sends with the same key create exactly one row', async () => {
    const key = uuidv4();
    const results = await Promise.all(
      [1, 2, 3].map(() => inbox.replyAsUser(conversation.id, traveler.id, 'race', { clientMessageId: key }))
    );
    expect(new Set(results.map((m) => m.id)).size).toBe(1);
    expect(await count({ conversationId: conversation.id })).toBe(1);
  });

  test('different keys, different senders and missing keys are all separate messages', async () => {
    await inbox.replyAsUser(conversation.id, traveler.id, 'a', { clientMessageId: 'k1' });
    await inbox.replyAsUser(conversation.id, traveler.id, 'b', { clientMessageId: 'k2' });
    await inbox.replyToInquiry(conversation.id, host.id, 'c', tenant.id, { clientMessageId: 'k1' }); // other sender
    await inbox.replyAsUser(conversation.id, traveler.id, 'd');
    await inbox.replyAsUser(conversation.id, traveler.id, 'd');
    expect(await count({ conversationId: conversation.id })).toBe(5);
  });
});
