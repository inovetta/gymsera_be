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
  console.warn('[Socket] socket.io package not installed on this host. Real-time sockets will be inactive until npm i socket.io is run.');
}

const jwt = require('jsonwebtoken');

let _io = null;

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
        origin: allowedOrigins.length > 0 && !allowedOrigins.includes('*') ? allowedOrigins : '*',
        methods: ['GET', 'POST', 'PATCH', 'DELETE'],
        credentials: true,
      },
      pingTimeout: 30000,
      pingInterval: 25000,
      transports: ['websocket', 'polling'],
    });

  // 1. JWT Authentication Middleware
  _io.use((socket, next) => {
    try {
      const authHeader = socket.handshake.headers?.authorization;
      const token =
        socket.handshake.auth?.token ||
        (authHeader && authHeader.replace(/^Bearer\s+/i, '')) ||
        socket.handshake.query?.token;

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
    console.log(`[Socket] User connected: ${userId} (${user.role || 'USER'}) [socketId: ${socket.id}]`);

    // Auto-join user-specific room
    socket.join(`user:${userId}`);

    // If host or staff with tenantId, join tenant room for team broadcasts
    if (user.tenantId) {
      socket.join(`tenant:${user.tenantId}`);
    }

    // Join active conversation room
    socket.on('join_conversation', ({ conversationId }) => {
      if (!conversationId) return;
      socket.join(`conversation:${conversationId}`);
      console.log(`[Socket] ${userId} joined conversation:${conversationId}`);
    });

    // Leave conversation room
    socket.on('leave_conversation', ({ conversationId }) => {
      if (!conversationId) return;
      socket.leave(`conversation:${conversationId}`);
      console.log(`[Socket] ${userId} left conversation:${conversationId}`);
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
        const role = (user.role || '').toUpperCase();
        const isHost = role === 'GYM_HOST' || role === 'PLATFORM_ADMIN';

        let messageRecord;
        if (isHost) {
          // If host has tenantId, reply as host
          messageRecord = await inboxService.replyToInquiry(
            conversationId,
            userId,
            text.trim(),
            user.tenantId
          );
        } else {
          // Reply as user/traveler
          messageRecord = await inboxService.replyAsUser(
            conversationId,
            userId,
            text.trim()
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

        // Broadcast to conversation room (including sender or acknowledge sender)
        _io.to(`conversation:${conversationId}`).emit('new_message', {
          message: messageData,
          conversationId,
        });

        // Broadcast conversation list preview update to conversation participants
        emitConversationUpdated(conversationId, {
          lastMessageText: messageRecord.text,
          lastMessageAt: messageRecord.createdAt,
        });

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

    // Typing indicators
    socket.on('typing_start', ({ conversationId }) => {
      if (!conversationId) return;
      socket.to(`conversation:${conversationId}`).emit('user_typing', {
        conversationId,
        userId,
        userName: user.fullName || user.email || 'User',
        isTyping: true,
      });
    });

    socket.on('typing_stop', ({ conversationId }) => {
      if (!conversationId) return;
      socket.to(`conversation:${conversationId}`).emit('user_typing', {
        conversationId,
        userId,
        isTyping: false,
      });
    });

    // Real-time read receipt
    socket.on('mark_read', async ({ conversationId }) => {
      if (!conversationId) return;
      try {
        const inboxService = require('../services/inbox.service');
        const role = (user.role || '').toUpperCase();
        const isHost = role === 'GYM_HOST' || role === 'PLATFORM_ADMIN';

        if (isHost && user.tenantId) {
          await inboxService.markInquiryRead(conversationId, user.tenantId);
        } else {
          await inboxService.markTravelerRead(conversationId, userId);
        }

        // Notify room that messages are read
        _io.to(`conversation:${conversationId}`).emit('messages_read', {
          conversationId,
          readerId: userId,
          readBy: userId,
          readerRole: isHost ? 'HOST' : 'USER',
          readAt: new Date().toISOString(),
        });
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
    const { Conversation } = require('../models/platform');
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

    // Emit to conversation room
    _io.to(`conversation:${conversationId}`).emit('conversation_updated', payload);
    // Emit to traveler's personal room
    if (conv.userId) {
      _io.to(`user:${conv.userId}`).emit('conversation_updated', payload);
    }
    // Emit to tenant room for hosts
    if (conv.tenantId) {
      _io.to(`tenant:${conv.tenantId}`).emit('conversation_updated', payload);
    }
  } catch (err) {
    console.warn('[Socket emitConversationUpdated warning]:', err.message);
  }
};

module.exports = {
  init,
  getIO,
  emitToUser,
  emitToConversation,
  emitToTenant,
  emitConversationUpdated,
};
