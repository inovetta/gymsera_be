/**
 * test-socket-verify.js
 * End-to-end verification script for real-time Socket.IO messaging gateway,
 * rooms, typing indicators, read receipts, and notification payloads.
 */
const http = require('http');
const jwt = require('jsonwebtoken');
const { io: Client } = require('socket.io-client');
const assert = require('assert');

// Set test environment secrets
process.env.JWT_SECRET = process.env.JWT_SECRET || 'gymsera-super-secret-jwt-key-for-testing';
process.env.PORT = '5099';

const socketGateway = require('./src/socket/index');
const pushService = require('./src/services/push.service');
const inboxService = require('./src/services/inbox.service');

// Stub DB operations so real-time socket events can be tested without MySQL dependency
inboxService.markTravelerRead = async () => true;
inboxService.markInquiryRead = async () => true;
inboxService.replyToInquiry = async (convId, senderId, text) => ({
  id: 'msg-rec-1',
  conversationId: convId,
  senderId,
  senderType: 'STAFF',
  text,
  isRead: false,
  createdAt: new Date().toISOString(),
});

async function runTests() {
  console.log('\n--- Starting Notifications & Real-Time Messaging E2E Tests ---\n');

  // 1. Create HTTP server and initialize socket gateway
  const server = http.createServer();
  const io = socketGateway.init(server);
  await new Promise((resolve) => server.listen(5099, resolve));
  console.log('✓ Socket.IO server listening on port 5099');

  // 2. Generate valid JWT tokens
  const hostUser = { id: 'host-uuid-1', role: 'GYM_HOST', tenantId: 'tenant-42' };
  const memberUser = { id: 'member-uuid-2', role: 'MEMBER' };

  const hostToken = jwt.sign(hostUser, process.env.JWT_SECRET, { expiresIn: '1h' });
  const memberToken = jwt.sign(memberUser, process.env.JWT_SECRET, { expiresIn: '1h' });
  const invalidToken = 'invalid.bearer.token';

  // 3. Test Unauthorized Connection
  await new Promise((resolve, reject) => {
    const unauthClient = Client('http://localhost:5099', {
      auth: { token: invalidToken },
      transports: ['websocket'],
    });

    unauthClient.on('connect_error', (err) => {
      console.log('✓ Rejected unauthorized socket handshake as expected:', err.message);
      unauthClient.disconnect();
      resolve();
    });

    unauthClient.on('connect', () => {
      reject(new Error('Unauthorized socket should not have connected'));
    });
  });

  // 4. Test Authorized Connections for Host and Member
  const clientA = Client('http://localhost:5099', {
    auth: { token: hostToken },
    transports: ['websocket'],
  });

  const clientB = Client('http://localhost:5099', {
    auth: { token: memberToken },
    transports: ['websocket'],
  });

  await Promise.all([
    new Promise((resolve) => clientA.on('connect', resolve)),
    new Promise((resolve) => clientB.on('connect', resolve)),
  ]);
  console.log('✓ Both Client A (Host) and Client B (Member) connected with valid JWT');

  // 5. Test Room Joins
  const testConvId = 'conv-test-123';
  clientA.emit('join_conversation', { conversationId: testConvId });
  clientB.emit('join_conversation', { conversationId: testConvId });
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(`✓ Both clients joined room conversation:${testConvId}`);

  // 6. Test Typing Indicator (Client A types -> Client B receives user_typing with isTyping: true)
  const typingPromise = new Promise((resolve) => {
    clientB.once('user_typing', (data) => {
      assert.strictEqual(data.conversationId, testConvId);
      assert.strictEqual(data.userId, hostUser.id);
      assert.strictEqual(data.isTyping, true);
      console.log('✓ Client B received real-time user_typing (started) from Client A');
      resolve();
    });
  });
  clientA.emit('typing_start', { conversationId: testConvId });
  await typingPromise;

  // 7. Test Stop Typing Indicator (Client A stops -> Client B receives user_typing with isTyping: false)
  const stopTypingPromise = new Promise((resolve) => {
    clientB.once('user_typing', (data) => {
      assert.strictEqual(data.conversationId, testConvId);
      assert.strictEqual(data.userId, hostUser.id);
      assert.strictEqual(data.isTyping, false);
      console.log('✓ Client B received real-time user_typing (stopped) from Client A');
      resolve();
    });
  });
  clientA.emit('typing_stop', { conversationId: testConvId });
  await stopTypingPromise;

  // 8. Test Live Message Broadcast
  const testMsg = {
    id: 'msg-abc-999',
    conversationId: testConvId,
    senderId: hostUser.id,
    body: 'Hello from Host! Welcome to Iron Forge!',
    createdAt: new Date().toISOString(),
  };

  const receiveMsgPromise = new Promise((resolve) => {
    clientB.once('new_message', (msg) => {
      assert.strictEqual(msg.id, testMsg.id);
      assert.strictEqual(msg.body, testMsg.body);
      console.log('✓ Client B received real-time new_message via socket broadcast');
      resolve();
    });
  });
  socketGateway.emitToConversation(testConvId, 'new_message', testMsg);
  await receiveMsgPromise;

  // 9. Test Read Receipts
  const readReceiptPromise = new Promise((resolve) => {
    clientA.once('messages_read', (data) => {
      assert.strictEqual(data.conversationId, testConvId);
      assert.strictEqual(data.readBy, memberUser.id);
      console.log('✓ Client A received real-time messages_read receipt');
      resolve();
    });
  });
  clientB.emit('mark_read', { conversationId: testConvId });
  await readReceiptPromise;

  // 10. Test Push Service Deduplication Headers
  const pushPayload = {
    title: 'New Customer Registered',
    body: 'John Doe subscribed to Premium Plan',
    data: {
      type: 'new_customer',
      subscriptionId: 'sub-789',
      branchId: 'branch-10',
      userId: 'member-uuid-2',
      deepLink: '/host/gyms/branch-10/members/member-uuid-2',
    },
  };
  const builtMsg = pushService._buildFcmPayload(pushPayload);
  assert.ok(builtMsg.android, 'Expected android config in FCM message');
  assert.ok(builtMsg.android.collapseKey, 'Expected collapseKey for deduplication');
  assert.strictEqual(builtMsg.android.notification.tag, 'new_customer');
  assert.ok(builtMsg.apns.headers['apns-collapse-id'], 'Expected apns-collapse-id');
  console.log('✓ Push notification payload contains FCM collapseKey, Android tag, and APNs collapse id for deduplication');

  // Clean up
  clientA.disconnect();
  clientB.disconnect();
  server.close();
  console.log('\n--- All E2E Integration Tests Passed Successfully! ---\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n✗ Test Failed:', err);
  process.exit(1);
});
