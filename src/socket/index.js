/**
 * src/socket/index.js
 *
 * Real-time WebSocket gateway powered by Socket.IO.
 * Provides live bi-directional messaging, typing indicators, read receipts,
 * unread badges, and tenant/user room isolation.
 */
let Server = null;
try {
  Server = require('socket.io').Server;
} catch (loadErr) {
  try {
    Server = require('./socket-bundle').Server;
    console.log('[Socket] Loaded Socket.IO from bundled distribution');
  } catch (bundleErr) {
    console.warn('[Socket] socket.io package not installed and bundle not found:', bundleErr.message);
  }
}

const jwt = require('jsonwebtoken');

let _io = null;

/**
 * Room authorization (RT-04, spec §9.2). The server decides every room a
 * socket is in; a client can only ask to join a conversation, and only one it
 * belongs to:
 *  - as the traveler/member (`conversation.userId`), or
 *  - as the host side, when the token's tenant owns the conversation and the
 *    user still belongs to that tenant.
 * Returns `{ conversation, side: 'HOST' | 'USER' }`, or null (treated as
 * "not found": nothing is joined, sent or marked).
 */
const authorizeConversation = async (user, conversationId) => {
  if (!conversationId || typeof conversationId !== 'string') return null;
  const { Conversation } = require('../models/platform');
  const conversation = await Conversation.findByPk(conversationId, { attributes: ['id', 'tenantId', 'userId'] });
  if (!conversation) return null;

  const role = (user.role || '').toUpperCase();
  if (role === 'GYM_HOST' && user.tenantId && conversation.tenantId === user.tenantId) {
    const { userBelongsToTenant } = require('../middleware/tenantContext');
    if (await userBelongsToTenant(user.id, conversation.tenantId)) return { conversation, side: 'HOST' };
  }
  if (conversation.userId === user.id) return { conversation, side: 'USER' };
  return null;
};

const conversationRoom = (conversationId) => `conversation:${conversationId}`;

/**
 * Initialize Socket.IO with HTTP server instance.
 */
const init = (httpServer) => {
  if (!Server) return null;
  if (_io) return _io;

  try {
    const allowedOrigins = (process.env.CORS_ORIGIN || '*')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

    _io = new Server(httpServer, {
      cors: {
        origin: (origin, callback) => {
          // Allow all origins, including mobile apps (where origin is null/undefined)
          callback(null, true);
        },
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
      },
      pingTimeout: 30000,
      pingInterval: 25000,
      transports: ['websocket', 'polling'],
      allowUpgrades: true,
    });

  // 1. JWT Authentication Middleware
  _io.use((socket, next) => {
    try {
      const authHeader = socket.handshake.headers?.authorization;
      // Never from the query string: URLs end up in access logs (RT-04, SEC-07).
      const token =
        socket.handshake.auth?.token ||
        (authHeader && authHeader.replace(/^Bearer\s+/i, ''));

      if (!token) {
        return next(new Error('Authentication error: Token required'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userId = decoded.id || decoded.sub || decoded.userId;
      if (!userId) {
        return next(new Error('Authentication error: Malformed token'));
      }

      socket.user = {
        ...decoded,
        id: userId,
      };

      next();
    } catch (err) {
      console.warn('[Socket Auth] Handshake rejected:', err.message);
      return next(new Error('Authentication error: Invalid or expired token'));
    }
  });

  // 2. Connection and Event Handlers
  _io.on('connection', (socket) => {
    const user = socket.user;
    const userId = user.id;
    const role = (user.role || '').toUpperCase();
    console.log(`[Socket] User connected: ${userId} (${role || 'USER'}) [socketId: ${socket.id}]`);

    // Auto-join user-specific room
    socket.join(`user:${userId}`);

    // Tenant room for team broadcasts: only while the user still belongs to
    // the token's tenant (a token outlives a revoked role).
    if (user.tenantId) {
      const { userBelongsToTenant } = require('../middleware/tenantContext');
      userBelongsToTenant(userId, user.tenantId)
        .then((belongs) => {
          if (belongs && socket.connected) socket.join(`tenant:${user.tenantId}`);
        })
        .catch((err) => console.warn('[Socket] Tenant room check failed:', err.message));
    }

    // Join a conversation room: only one this user is part of (RT-04).
    socket.on('join_conversation', async (payload, callback) => {
      const conversationId = payload?.conversationId;
      const ack = typeof callback === 'function' ? callback : () => {};
      try {
        const access = await authorizeConversation(user, conversationId);
        if (!access) {
          console.warn(`[Socket] ${userId} denied join for conversation:${conversationId}`);
          return ack({ success: false, error: 'Conversation not found' });
        }
        socket.join(conversationRoom(conversationId));
        return ack({ success: true });
      } catch (err) {
        console.warn('[Socket join_conversation error]:', err.message);
        return ack({ success: false, error: 'Conversation not found' });
      }
    });

    // Leave conversation room
    socket.on('leave_conversation', (payload) => {
      const conversationId = payload?.conversationId;
      if (!conversationId) return;
      socket.leave(conversationRoom(conversationId));
    });

    // Real-time message dispatch
    socket.on('send_message', async (payload, callback) => {
      try {
        const { conversationId, text, tempId } = payload || {};
        if (!conversationId || !text || !text.trim()) {
          if (typeof callback === 'function') {
            return callback({ success: false, error: 'conversationId and text required' });
          }
          return;
        }

        const inboxService = require('../services/inbox.service');

        // The conversation's own tenant is never borrowed: the sender must
        // belong to it (RT-04).
        const access = await authorizeConversation(user, conversationId);
        if (!access) {
          if (typeof callback === 'function') {
            return callback({ success: false, error: 'Conversation not found' });
          }
          return;
        }

        let messageRecord;
        if (access.side === 'HOST') {
          messageRecord = await inboxService.replyToInquiry(
            conversationId,
            userId,
            text.trim(),
            access.conversation.tenantId,
            { tempId }
          );
        } else {
          // Reply as user/traveler
          messageRecord = await inboxService.replyAsUser(
            conversationId,
            userId,
            text.trim(),
            { tempId }
          );
        }

        const messageData = {
          id: messageRecord.id,
          conversationId: messageRecord.conversationId,
          senderId: messageRecord.senderId,
          senderType: messageRecord.senderType,
          text: messageRecord.text,
          isRead: messageRecord.isRead,
          createdAt: messageRecord.createdAt,
          tempId: tempId || null,
        };

        // Note: inboxService already broadcasts new_message and conversation_updated.
        // Acknowledge the sender via socket callback
        if (typeof callback === 'function') {
          callback({ success: true, message: messageData, tempId });
        }
      } catch (err) {
        console.error('[Socket send_message error]:', err.message);
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    // Typing indicators: only into a room this socket was allowed to join.
    socket.on('typing_start', (payload) => {
      const conversationId = payload?.conversationId;
      if (!conversationId || !socket.rooms.has(conversationRoom(conversationId))) return;
      socket.to(conversationRoom(conversationId)).emit('user_typing', {
        conversationId,
        userId,
        userName: user.fullName || user.email || 'User',
        isTyping: true,
      });
    });

    socket.on('typing_stop', (payload) => {
      const conversationId = payload?.conversationId;
      if (!conversationId || !socket.rooms.has(conversationRoom(conversationId))) return;
      socket.to(conversationRoom(conversationId)).emit('user_typing', {
        conversationId,
        userId,
        isTyping: false,
      });
    });

    // Real-time read receipt
    socket.on('mark_read', async (payload) => {
      const conversationId = payload?.conversationId;
      if (!conversationId) return;
      try {
        const inboxService = require('../services/inbox.service');
        const access = await authorizeConversation(user, conversationId);
        if (!access) return;
        if (access.side === 'HOST') {
          await inboxService.markInquiryRead(conversationId, access.conversation.tenantId);
        } else {
          await inboxService.markTravelerRead(conversationId, userId);
        }
      } catch (err) {
        console.warn('[Socket mark_read warning]:', err.message);
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] User disconnected: ${userId} (${reason})`);
    });
  });

  console.log('⚡ Socket.IO real-time messaging gateway initialized');
  return _io;
  } catch (initErr) {
    console.warn('[Socket] Socket.IO initialization failed:', initErr.message);
    _io = null;
    return null;
  }
};

/**
 * Get active io instance.
 */
const getIO = () => {
  return _io;
};

/**
 * Emit event to a specific user across all their devices.
 */
const emitToUser = (userId, event, data) => {
  if (!_io || !userId) return;
  _io.to(`user:${userId}`).emit(event, data);
};

/**
 * Emit event to all sockets in an active conversation room.
 */
const emitToConversation = (conversationId, event, data) => {
  if (!_io || !conversationId) return;
  _io.to(`conversation:${conversationId}`).emit(event, data);
};

/**
 * Emit event to all host staff/owner of a tenant.
 */
const emitToTenant = (tenantId, event, data) => {
  if (!_io || !tenantId) return;
  _io.to(`tenant:${tenantId}`).emit(event, data);
};

/**
 * Broadcast conversation preview updates (e.g. on new message via REST or Socket).
 */
const emitConversationUpdated = async (conversationId, extraData = {}) => {
  if (!_io || !conversationId) return;
  try {
    const { Conversation, Tenant } = require('../models/platform');
    const conv = await Conversation.findByPk(conversationId);
    if (!conv) return;

    const payload = {
      conversationId: conv.id,
      lastMessageText: extraData.lastMessageText || conv.lastMessageText,
      lastMessageAt: extraData.lastMessageAt || conv.lastMessageAt,
      unreadCountUser: conv.unreadCountUser,
      unreadCountHost: conv.unreadCountHost,
      type: conv.type,
      ...extraData,
    };

    // 1. Emit to conversation room
    _io.to(`conversation:${conversationId}`).emit('conversation_updated', payload);
    // 2. Emit to traveler's personal room
    if (conv.userId) {
      _io.to(`user:${conv.userId}`).emit('conversation_updated', payload);
    }
    // 3. Emit to tenant room for hosts & staff
    if (conv.tenantId) {
      _io.to(`tenant:${conv.tenantId}`).emit('conversation_updated', payload);
      try {
        const tenant = await Tenant.findByPk(conv.tenantId, { attributes: ['ownerUserId'] });
        if (tenant && tenant.ownerUserId) {
          _io.to(`user:${tenant.ownerUserId}`).emit('conversation_updated', payload);
        }
      } catch (_) {}
    }
  } catch (err) {
    console.warn('[Socket emitConversationUpdated warning]:', err.message);
  }
};

const close = async () => {
  if (_io) {
    try {
      await new Promise((resolve) => _io.close(resolve));
    } catch (err) {
      console.warn('[Socket] Error closing socket gateway:', err.message);
    }
    _io = null;
  }
};

module.exports = {
  init,
  close,
  getIO,
  emitToUser,
  emitToConversation,
  emitToTenant,
  emitConversationUpdated,
};
