require('dotenv').config();

// Refuse to start without SMTP settings — there is no built-in fallback. On
// Vercel this fails the function at load with the message in the logs.
require('../src/config/smtp.config').assertSmtpConfigured();

const app = require('../app');
const { connect: connectPlatformDb } = require('../src/database/platform');

// Vercel may reuse the function instance across requests.
// We track the connection promise so we only connect once per warm instance.
let dbConnectionPromise = null;

const ensureDbConnected = () => {
  if (!dbConnectionPromise) {
    dbConnectionPromise = connectPlatformDb().catch((err) => {
      // Reset so the next request can retry
      dbConnectionPromise = null;
      throw err;
    });
  }
  return dbConnectionPromise;
};

module.exports = async (req, res) => {
  await ensureDbConnected();
  app(req, res);
};
