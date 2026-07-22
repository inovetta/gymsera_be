require('dotenv').config();
const { sequelize } = require('./src/models/platform');
const meService = require('./src/services/me.service');

async function main() {
  try {
    await sequelize.authenticate();
    console.log('Database connected successfully.');

    const userId = '19d7af2f-d3b4-4d0e-8929-b07cd71cd298';
    const subscriptionId = '86f9013d-e86c-4fd5-ac50-866ee03768d3'; // FitLife Studio subscription

    const payment = await meService.submitPaymentRequest(userId, {
      subscriptionId,
      method: 'BANK_TRANSFER',
      amount: 100.00,
      notes: 'Test script payment'
    });

    console.log('Created payment JSON:', JSON.stringify(payment.toJSON(), null, 2));
  } catch (err) {
    console.error('Error running script:', err);
  } finally {
    await sequelize.close();
  }
}

main();
