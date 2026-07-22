const { connect } = require('../src/database/platform');
const { Notification, User, Tenant } = require('../src/models/platform');

async function run() {
  await connect();
  
  const notifications = await Notification.findAll({
    limit: 10,
    order: [['createdAt', 'DESC']]
  });
  
  console.log('--- RECENT NOTIFICATIONS ---');
  for (const n of notifications) {
    const user = await User.findByPk(n.userId);
    console.log(`ID: ${n.id}`);
    console.log(`User: ${user ? user.email : 'Unknown'} (ID: ${n.userId})`);
    console.log(`Role: ${n.role}`);
    console.log(`Type: ${n.type}`);
    console.log(`Title: ${n.title}`);
    console.log(`Message: ${n.message}`);
    console.log(`Created: ${n.createdAt}`);
    console.log('-----------------------------');
  }

  const tenants = await Tenant.findAll();
  console.log('\n--- TENANTS AND OWNERS ---');
  for (const t of tenants) {
    const owner = await User.findByPk(t.ownerUserId);
    console.log(`Tenant: ${t.businessName || t.gymName} (ID: ${t.id})`);
    console.log(`Owner: ${owner ? owner.email : 'Unknown'} (ID: ${t.ownerUserId})`);
    console.log('-----------------------------');
  }
}

run().catch(console.error);
