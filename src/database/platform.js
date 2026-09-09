const { Sequelize } = require('sequelize');
// Explicit require so Vercel's file tracer (nft) includes mysql2 in the bundle.
// Sequelize loads it dynamically based on dialect, which static analyzers miss.
require('mysql2');
const dbConfig = require('../config/database.config');

const { host, port, database, username, password } = dbConfig.platform;

const sequelize = new Sequelize(database, username, password, {
  host,
  port,
  dialect: 'mysql',
  logging: process.env.NODE_ENV === 'development' ? (sql) => console.log('[Platform DB]', sql) : false,
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
  dialectOptions: {
    connectTimeout: 20000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  },
  define: {
    underscored: true,
    timestamps: true,
  },
});

/**
 * Authenticate and sync the platform database.
 * In development, uses `alter: true` to keep schema in sync with model changes.
 * In production, `sync` is a no-op — use migrations.
 */
const connect = async () => {
  await sequelize.authenticate();
  console.log('[Platform DB] Connected');

  if (process.env.NODE_ENV === 'development' && !process.env.VERCEL) {
    // Lazy-load models to ensure they're registered before sync
    require('../models/platform');
    await sequelize.sync({ alter: true });
    console.log('[Platform DB] Schema synced (development)');

    try {
      const { Tenant, GymListing, User, Conversation, Message } = require('../models/platform');
      const convCount = await Conversation.count();
      if (convCount === 0) {
        console.log('[Platform DB] Seeding initial conversations...');
        const users = await User.findAll({ where: { role: 'MEMBER' } });
        const tenants = await Tenant.findAll();
        
        const dummyConversations = [
          {
            type: 'MEMBER',
            messages: [
              { text: "Hey! Is the squat rack at the Warehouse location free around 5 PM? Looking to get a heavy session in.", senderType: 'USER' },
              { text: "Hi! Yes, the 5 PM slot is usually quiet on Tuesdays. We have three squat racks, so you should be good.", senderType: 'HOST' },
              { text: "Awesome. Do I need a new entry code or will my current one work?", senderType: 'USER' },
              { text: "Your current QR code will work fine. Valid for the next 30 days.", senderType: 'HOST' },
              { text: "Perfect. One more thing — can I bring a guest tomorrow?", senderType: 'USER' },
              { text: "Yes! Guests are welcome. Just register them at the reception with your member ID.", senderType: 'HOST' },
              { text: "Amazing, thanks! See you tomorrow.", senderType: 'USER' },
              { text: "See you then! Have a great workout 💪", senderType: 'HOST' }
            ]
          },
          {
            type: 'INQUIRY',
            messages: [
              { text: "Hi, I'm interested in joining. Do you offer student discounts on the Premium Monthly plan?", senderType: 'USER' },
              { text: "Hello! Yes, we offer a 15% discount for students with a valid student ID. You can register at the front desk.", senderType: 'HOST' },
              { text: "Regarding membership pause policy, what's the limit? Can I pause for 2 weeks?", senderType: 'USER' }
            ]
          },
          {
            type: 'MEMBER',
            messages: [
              { text: "Hey, my locker key isn't working today. Can someone help me at 5pm?", senderType: 'USER' }
            ]
          }
        ];

        if (users.length > 0 && tenants.length > 0) {
          for (const tenant of tenants) {
            const listings = await GymListing.findAll({ where: { tenantId: tenant.id } });
            for (const listing of listings) {
              if (!listing.branchId) continue;
              
              for (let i = 0; i < Math.min(dummyConversations.length, users.length); i++) {
                const user = users[i];
                const dummy = dummyConversations[i];
                
                const conversation = await Conversation.create({
                  tenantId: tenant.id,
                  branchId: listing.branchId,
                  userId: user.id,
                  type: dummy.type,
                  unreadCountHost: 0,
                  unreadCountUser: 0
                });

                let lastMsg = null;
                let unreadHost = 0;
                let unreadUser = 0;

                for (const msgData of dummy.messages) {
                  const senderId = msgData.senderType === 'USER' ? user.id : tenant.ownerUserId;
                  const createdMsg = await Message.create({
                    conversationId: conversation.id,
                    senderId: senderId || null,
                    senderType: msgData.senderType,
                    text: msgData.text,
                    isRead: false
                  });
                  lastMsg = createdMsg;

                  if (msgData.senderType === 'USER') {
                    unreadHost++;
                  } else if (msgData.senderType === 'HOST') {
                    unreadUser++;
                  }
                }

                if (lastMsg) {
                  await conversation.update({
                    lastMessageText: lastMsg.text,
                    lastMessageAt: lastMsg.createdAt,
                    unreadCountHost: unreadHost,
                    unreadCountUser: unreadUser
                  });
                }
              }
            }
          }
          console.log('[Platform DB] Auto-seeded conversations.');
        }
      }
    } catch (seedErr) {
      console.warn('[Platform DB] Auto-seed failed:', seedErr.message);
    }
  }
};

module.exports = { sequelize, connect };
