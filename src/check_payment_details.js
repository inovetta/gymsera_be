const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const { sequelize } = require('./models');
const discoveryService = require('./services/discovery.service');

async function main() {
  try {
    // Sync/init database connection
    await sequelize.authenticate();
    console.log('Database connected successfully.');

    // Use FitLife Studio Listing ID
    const gymId = 'aec3db1d-3582-46ab-9f76-eede1cb5eaf3';
    const result = await discoveryService.getPaymentDetails(gymId);
    console.log('Result from getPaymentDetails:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error running script:', err);
  } finally {
    await sequelize.close();
  }
}

main();
