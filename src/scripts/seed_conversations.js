require('dotenv').config();
const { connect: initPlatformDb } = require('../database/platform');
const { Tenant, GymListing, User, Conversation, Message } = require('../models/platform');
const { Op } = require('sequelize');

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

async function seed() {
  await initPlatformDb();

  const tenants = await Tenant.findAll();
  console.log(`Found ${tenants.length} tenants.`);

  const users = await User.findAll({ where: { role: 'MEMBER' } });
  if (users.length === 0) {
    console.log("No member users found to seed conversations. Please run main seeder first.");
    return;
  }
  console.log(`Found ${users.length} member users.`);

  for (const tenant of tenants) {
    const listings = await GymListing.findAll({ where: { tenantId: tenant.id } });
    console.log(`Tenant ${tenant.businessName} has ${listings.length} listings.`);

    for (const listing of listings) {
      if (!listing.branchId) continue;
      console.log(`Seeding conversations for branch: ${listing.title}`);

      for (let i = 0; i < Math.min(dummyConversations.length, users.length); i++) {
        const user = users[i];
        const dummy = dummyConversations[i];

        // Check if conversation already exists
        let conversation = await Conversation.findOne({
          where: {
            tenantId: tenant.id,
            branchId: listing.branchId,
            userId: user.id,
            type: dummy.type
          }
        });

        if (!conversation) {
          conversation = await Conversation.create({
            tenantId: tenant.id,
            branchId: listing.branchId,
            userId: user.id,
            type: dummy.type,
            unreadCountHost: 0,
            unreadCountUser: 0
          });
        }

        // Add messages
        let lastMsg = null;
        let unreadHost = 0;
        let unreadUser = 0;

        for (const msgData of dummy.messages) {
          // Check if message already exists
          const existingMsg = await Message.findOne({
            where: {
              conversationId: conversation.id,
              text: msgData.text
            }
          });

          if (!existingMsg) {
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
          } else {
            lastMsg = existingMsg;
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

  console.log("🎉 Seeded conversations successfully!");
}

seed().catch(err => {
  console.error("Error seeding conversations:", err);
  process.exit(1);
});
