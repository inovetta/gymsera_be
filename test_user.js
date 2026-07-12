const { sequelize } = require('./src/models/platform');
const discoveryService = require('./src/services/discovery.service');

async function main() {
  try {
    await sequelize.authenticate();
    console.log('Database connected successfully.');

    const gymId = '00410ec3-06f3-45ae-97e0-0efc4d1afec5';
    const result = await discoveryService.getGym(gymId);
    console.log('gymKeys =', Object.keys(result.gym));
    console.log('gym.branchId =', result.gym.branchId);
    console.log('gym.title =', result.gym.title);
  } catch (err) {
    console.error('Error running script:', err);
  } finally {
    await sequelize.close();
  }
}

main();
