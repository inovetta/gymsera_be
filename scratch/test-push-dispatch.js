/**
 * scratch/test-push-dispatch.js
 *
 * Diagnostic CLI script for validating Firebase Admin setup,
 * checking registered device tokens, and dispatching test push notifications.
 *
 * Usage:
 *   node scratch/test-push-dispatch.js --status
 *   node scratch/test-push-dispatch.js --tokens
 *   node scratch/test-push-dispatch.js --send-token <FCM_TOKEN>
 *   node scratch/test-push-dispatch.js --send-user <USER_ID>
 */
require('dotenv').config();
const pushService = require('../src/services/push.service');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || '--status';

  console.log('=== GymsEra FCM Diagnostic Tool ===\n');

  const status = pushService.getPushStatus();
  console.log('FCM Configuration Status:');
  console.log(`  - Configured: ${status.isConfigured ? 'YES' : 'NO'}`);
  console.log(`  - Mode:       ${status.mode.toUpperCase()}`);
  console.log(`  - Project ID: ${status.projectId || 'None'}\n`);

  if (!status.isConfigured) {
    console.warn('WARNING: Firebase Admin is not configured. Real push notifications will not be sent.');
    console.warn('To configure: set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH in .env\n');
  }

  if (command === '--status') {
    process.exit(0);
  }

  // Connect to DB for token queries
  const { connect } = require('../src/database/platform');
  const { DeviceToken, User } = require('../src/models/platform');
  await connect();

  if (command === '--tokens') {
    const tokens = await DeviceToken.findAll({
      include: [{ model: User, as: 'user', attributes: ['id', 'email', 'fullName', 'role'] }],
      order: [['lastActiveAt', 'DESC']],
      limit: 20,
    });

    console.log(`Registered Device Tokens (Total: ${tokens.length}):`);
    tokens.forEach((t, i) => {
      console.log(`  [${i + 1}] Platform: ${t.platform} | User: ${t.user?.email || t.userId} (${t.user?.role || 'unknown'})`);
      console.log(`      Token: ${t.token.slice(0, 30)}...${t.token.slice(-10)}`);
      console.log(`      Active: ${t.lastActiveAt}\n`);
    });
    process.exit(0);
  }

  if (command === '--send-token') {
    const targetToken = args[1];
    if (!targetToken) {
      console.error('Error: Please provide a token: node scratch/test-push-dispatch.js --send-token <TOKEN>');
      process.exit(1);
    }
    console.log(`Sending test notification to token: ${targetToken.slice(0, 20)}...`);
    const result = await pushService.send(
      targetToken,
      'GymsEra Test Push',
      'Diagnostic test push notification dispatched successfully.',
      { event: 'diagnostic_test', sentAt: new Date().toISOString() }
    );
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(0);
  }

  if (command === '--send-user') {
    const userId = args[1];
    if (!userId) {
      console.error('Error: Please provide a userId: node scratch/test-push-dispatch.js --send-user <USER_ID>');
      process.exit(1);
    }
    console.log(`Sending test notification to all devices of user: ${userId}`);
    const result = await pushService.sendToUser(userId, {
      title: 'GymsEra Test Push',
      body: 'Diagnostic test push notification dispatched to your registered devices.',
      data: { event: 'diagnostic_test', sentAt: new Date().toISOString() },
    });
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.log(`Unknown command "${command}". Valid commands: --status, --tokens, --send-token <TOKEN>, --send-user <USER_ID>`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
