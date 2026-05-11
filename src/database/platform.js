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
    min: 2,
    acquire: 30000,
    idle: 10000,
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
  }
};

module.exports = { sequelize, connect };
