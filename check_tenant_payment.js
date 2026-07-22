require('dotenv').config();
const models = require('./src/models/platform');
const { Tenant } = models;

async function run() {
  const tenants = await Tenant.findAll();
  for (const tenant of tenants) {
    console.log('---');
    console.log('Tenant:', tenant.businessName);
    console.log('paymentMethod:', tenant.paymentMethod);
    console.log('bankTransferRef:', tenant.bankTransferRef);
    console.log('paymentDetailsJson:', tenant.paymentDetailsJson);
  }
  process.exit(0);
}

run();
