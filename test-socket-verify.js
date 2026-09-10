/**
 * test-socket-verify.js
 * End-to-end verification script for real-time Socket.IO messaging gateway,
 * rooms, typing indicators, read receipts, bidirectional messaging (Host <-> Traveler),
 * and notification payloads.
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

// Stub DB operations so real-time socket events can be tested without live DB connection
inboxService.markTravelerRead = async (convId, userId) => {
  socketGateway.emitToConversation(convId, 'messages_read', {
    conversationId: convId,
    readerRole: 'USER',
    readBy: userId,
    readAt: new Date().toISOString(),
  });
  socketGateway.emitConversationUpdated(convId, { unreadCountUser: 0 });
  return { success: true };
};

inboxService.markInquiryRead = async (convId, tenantId) => {
  socketGateway.emitToConversation(convId, 'messages_read', {
    conversationId: convId,
    readerRole: 'HOST',
    readBy: tenantId || 'host',
    readAt: new Date().toISOString(),
  });
  socketGateway.emitConversationUpdated(convId, { unreadCountHost: 0 });
  return { success: true };
};

inboxService.replyToInquiry = async (convId, senderId, text, tenantId) => {
  const msg = {
    id: `msg-host-${Date.now()}`,
    conversationId: convId,
    senderId,
    senderType: 'HOST',
    text,
    isRead: false,
    createdAt: new Date().toISOString(),
  };
  socketGateway.emitToConversation(convId, 'new_message', {
    message: msg,
    conversationId: convId,
  });
  socketGateway.emitConversationUpdated(convId, {
    lastMessageText: text,
    lastMessageAt: msg.createdAt,
    unreadCountUser: 1,
  });
  return msg;
};

inboxService.replyAsUser = async (convId, senderId, text) => {
  const msg = {
    id: `msg-user-${Date.now()}`,
    conversationId: convId,
    senderId,
    senderType: 'USER',
    text,
    isRead: false,
    createdAt: new Date().toISOString(),
  };
  socketGateway.emitToConversation(convId, 'new_message', {
    message: msg,
    conversationId: convId,
  });
  socketGateway.emitConversationUpdated(convId, {
    lastMessageText: text,
    lastMessageAt: msg.createdAt,
    unreadCountHost: 1,
  });
  return msg;
};

async function runTests() {
  console.log('\n======================================================');
  console.log('  STARTING BIDIRECTIONAL REAL-TIME WEBSOCKET TESTS');
  console.log('======================================================\n');

  // 1. Create HTTP server and initialize socket gateway
  const server = http.createServer();
  const io = socketGateway.init(server);
  await new Promise((resolve) => server.listen(5099, resolve));
  console.log('✓ Socket.IO server listening on port 5099');

  // 2. Generate valid JWT tokens
  const hostUser = { id: 'host-uuid-1', role: 'GYM_HOST', tenantId: 'tenant-42', fullName: 'Iron Host' };
  const travelerUser = { id: 'traveler-uuid-2', role: 'USER', fullName: 'Alex Traveler' };

  const hostToken = jwt.sign(hostUser, process.env.JWT_SECRET, { expiresIn: '1h' });
  const travelerToken = jwt.sign(travelerUser, process.env.JWT_SECRET, { expiresIn: '1h' });
  const invalidToken = 'invalid.bearer.token';

  // 3. Test Unauthorized Connection Rejection
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

  // 4. Test Authorized Connections for Host (User A) and Traveler (User B)
  const clientHost = Client('http://localhost:5099', {
    auth: { token: hostToken },
    transports: ['websocket'],
  });

  const clientTraveler = Client('http://localhost:5099', {
    auth: { token: travelerToken },
    transports: ['websocket'],
  });

  await Promise.all([
    new Promise((resolve) => clientHost.on('connect', resolve)),
    new Promise((resolve) => clientTraveler.on('connect', resolve)),
  ]);
  console.log('✓ User A (Host) and User B (Traveler) connected successfully via WebSocket');

  const testConvId = 'conv-test-realtime-888';

  // 5. Test Room Joins
  clientHost.emit('join_conversation', { conversationId: testConvId });
  clientTraveler.emit('join_conversation', { conversationId: testConvId });
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(`✓ Both users joined room: conversation:${testConvId}`);

  // 6. Test Host -> Traveler Typing Indicator
  const hostTypingPromise = new Promise((resolve) => {
    clientTraveler.once('user_typing', (data) => {
      assert.strictEqual(data.conversationId, testConvId);
      assert.strictEqual(data.userId, hostUser.id);
      assert.strictEqual(data.isTyping, true);
      console.log('✓ Traveler received real-time user_typing (started) from Host');
      resolve();
    });
  });
  clientHost.emit('typing_start', { conversationId: testConvId });
  await hostTypingPromise;

  // 7. Test Host -> Traveler Send Message via send_message with ACK
  const hostText = 'Welcome to Iron Gym! Do you need a guest pass?';
  const travelerReceiveMsgPromise = new Promise((resolve) => {
    clientTraveler.once('new_message', (payload) => {
      assert.strictEqual(payload.conversationId, testConvId);
      assert.strictEqual(payload.message.text, hostText);
      assert.strictEqual(payload.message.senderType, 'HOST');
      console.log('✓ Traveler received real-time new_message from Host:', payload.message.text);
      resolve();
    });
  });

  const hostAckPromise = new Promise((resolve, reject) => {
    clientHost.emit(
      'send_message',
      { conversationId: testConvId, text: hostText, tempId: 'temp-host-1' },
      (ack) => {
        if (ack && ack.success) {
          console.log('✓ Host received send_message ACK with persisted message id:', ack.message.id);
          resolve(ack);
        } else {
          reject(new Error('Host send_message ACK failed: ' + JSON.stringify(ack)));
        }
      }
    );
  });

  await Promise.all([hostAckPromise, travelerReceiveMsgPromise]);

  // 8. Test Traveler -> Host Read Receipt
  const hostReadPromise = new Promise((resolve) => {
    clientHost.once('messages_read', (data) => {
      assert.strictEqual(data.conversationId, testConvId);
      assert.strictEqual(data.readerRole, 'USER');
      console.log('✓ Host received real-time messages_read receipt from Traveler');
      resolve();
    });
  });
  clientTraveler.emit('mark_read', { conversationId: testConvId });
  await hostReadPromise;

  // 9. Test Traveler -> Host Typing Indicator
  const travelerTypingPromise = new Promise((resolve) => {
    clientHost.once('user_typing', (data) => {
      assert.strictEqual(data.conversationId, testConvId);
      assert.strictEqual(data.userId, travelerUser.id);
      assert.strictEqual(data.isTyping, true);
      console.log('✓ Host received real-time user_typing (started) from Traveler');
      resolve();
    });
  });
  clientTraveler.emit('typing_start', { conversationId: testConvId });
  await travelerTypingPromise;

  // 10. Test Traveler -> Host Send Message via send_message with ACK
  const travelerText = 'Yes please! I am arriving tomorrow at 9am.';
  const hostReceiveMsgPromise = new Promise((resolve) => {
    clientHost.once('new_message', (payload) => {
      assert.strictEqual(payload.conversationId, testConvId);
      assert.strictEqual(payload.message.text, travelerText);
      assert.strictEqual(payload.message.senderType, 'USER');
      console.log('✓ Host received real-time new_message from Traveler:', payload.message.text);
      resolve();
    });
  });

  const travelerAckPromise = new Promise((resolve, reject) => {
    clientTraveler.emit(
      'send_message',
      { conversationId: testConvId, text: travelerText, tempId: 'temp-traveler-1' },
      (ack) => {
        if (ack && ack.success) {
          console.log('✓ Traveler received send_message ACK with persisted message id:', ack.message.id);
          resolve(ack);
        } else {
          reject(new Error('Traveler send_message ACK failed: ' + JSON.stringify(ack)));
        }
      }
    );
  });

  await Promise.all([travelerAckPromise, hostReceiveMsgPromise]);

  // 11. Test Host -> Traveler Read Receipt
  const travelerReadPromise = new Promise((resolve) => {
    clientTraveler.once('messages_read', (data) => {
      assert.strictEqual(data.conversationId, testConvId);
      assert.strictEqual(data.readerRole, 'HOST');
      console.log('✓ Traveler received real-time messages_read receipt from Host');
      resolve();
    });
  });
  clientHost.emit('mark_read', { conversationId: testConvId });
  await travelerReadPromise;

  // 12. Test Inbox Broadcast when Host is outside Conversation Room
  clientHost.emit('leave_conversation', { conversationId: testConvId });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const hostInboxUpdatePromise = new Promise((resolve) => {
    clientHost.once('conversation_updated', (data) => {
      assert.strictEqual(data.conversationId, testConvId);
      assert.strictEqual(data.lastMessageText, 'Are towels provided?');
      console.log('✓ Host outside conversation room received conversation_updated inbox preview');
      resolve();
    });
  });

  // Traveler sends while host is outside conversation room
  clientTraveler.emit(
    'send_message',
    { conversationId: testConvId, text: 'Are towels provided?', tempId: 'temp-traveler-2' },
    () => {}
  );
  await hostInboxUpdatePromise;

  // 13. Test Push Deduplication Config
  const pushPayload = {
    title: 'New Message from Alex Traveler',
    body: 'Are towels provided?',
    data: {
      type: 'inquiry_replied',
      conversationId: testConvId,
      deepLink: `/host/inbox`,
    },
  };
  const builtMsg = pushService._buildFcmPayload(pushPayload);
  assert.ok(builtMsg.android.collapseKey, 'Expected collapseKey');
  assert.strictEqual(builtMsg.android.notification.tag, 'inquiry_replied');
  assert.ok(builtMsg.apns.headers['apns-collapse-id'], 'Expected apns-collapse-id');
  console.log('✓ Push notification payload contains FCM collapseKey and APNs collapse-id');

  // Clean up
  clientHost.disconnect();
  clientTraveler.disconnect();
  server.close();
  console.log('\n======================================================');
  console.log('  ALL REAL-TIME WEBSOCKET TESTS PASSED SUCCESSFULLY!  ');
  console.log('======================================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n✗ Test Failed:', err);
  process.exit(1);
});
