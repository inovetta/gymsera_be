const { Router } = require('express');

const router = Router();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: API health check
 *     tags: [System]
 *     security: []
 *     responses:
 *       200:
 *         description: API is running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: GymsEra API is running
 *                 data:
 *                   type: object
 */
router.get('/health', (_req, res) => {
  res.json({
    success: true,
    message: 'GymsEra API is running',
    data: {
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
    },
  });
});

router.get('/debug-sync-db', async (_req, res) => {
  try {
    const { sequelize: platformSeq } = require('../database/platform');
    require('../models/platform');
    await platformSeq.sync({ alter: true });
    const platformStatus = 'Platform DB synced successfully';

    const { Sequelize } = require('sequelize');
    const { Tenant } = require('../models/platform');
    const registerTenantModels = require('../models/tenant');
    const { decrypt } = require('../utils/crypto.utils');

    const tenants = await Tenant.findAll();
    const results = [];

    for (const tenant of tenants) {
      if (tenant.connectionStringEncrypted && tenant.connectionStringEncrypted !== 'PENDING_PROVISIONING') {
        const connUrl = decrypt(tenant.connectionStringEncrypted);
        const tenantSeq = new Sequelize(connUrl, {
          dialect: 'mysql',
          logging: false,
        });
        try {
          await tenantSeq.authenticate();
          registerTenantModels(tenantSeq);
          await tenantSeq.sync({ force: false, alter: true });
          results.push({ tenant: tenant.tenantCode, status: 'SUCCESS' });
        } catch (err) {
          results.push({ tenant: tenant.tenantCode, status: 'FAILED', error: err.message });
        } finally {
          await tenantSeq.close();
        }
      } else {
        results.push({ tenant: tenant.tenantCode, status: 'PENDING_PROVISIONING' });
      }
    }

    res.json({ success: true, platformStatus, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/debug-cleanup-indexes', async (_req, res) => {
  try {
    const { Tenant } = require('../models/platform');
    const { decrypt } = require('../utils/crypto.utils');
    const mysql = require('mysql2/promise');

    const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
    const results = [];

    for (const tenant of tenants) {
      if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') {
        continue;
      }

      const connUrl = decrypt(tenant.connectionStringEncrypted);
      const matches = connUrl.match(/mysql:\/\/([^:]+):([^@]*)@([^:]+):(\d+)\/(.+)/);
      if (!matches) {
        results.push({ tenant: tenant.tenantCode, status: 'FAILED', error: 'Invalid conn URL format' });
        continue;
      }

      const [, dbUser, dbPass, dbHost, dbPort, dbName] = matches;
      let conn;
      let droppedCount = 0;
      try {
        conn = await mysql.createConnection({
          host: dbHost,
          port: parseInt(dbPort),
          user: dbUser,
          password: dbPass,
          database: dbName,
        });

        const [tables] = await conn.query('SHOW TABLES');
        const tableNames = tables.map(row => Object.values(row)[0]);

        for (const tableName of tableNames) {
          const [indexes] = await conn.query(`SHOW INDEX FROM \`${tableName}\``);
          const indexGroups = {};
          for (const idx of indexes) {
            const keyName = idx.Key_name;
            if (!indexGroups[keyName]) {
              indexGroups[keyName] = [];
            }
            indexGroups[keyName].push(idx.Column_name);
          }

          const keysToDrop = [];
          const normalizedGroups = {};

          for (const [keyName, columns] of Object.entries(indexGroups)) {
            if (keyName === 'PRIMARY') continue;
            const colStr = columns.sort().join(',');
            const isSequentialDup = /_\d+$/.test(keyName);

            if (normalizedGroups[colStr] || isSequentialDup) {
              keysToDrop.push(keyName);
            } else {
              normalizedGroups[colStr] = keyName;
            }
          }

          for (const keyName of keysToDrop) {
            try {
              try {
                await conn.query(`ALTER TABLE \`${tableName}\` DROP FOREIGN KEY \`${keyName}\``);
              } catch (e) {}
              await conn.query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${keyName}\``);
              droppedCount++;
            } catch (e) {}
          }
        }
        results.push({ tenant: tenant.tenantCode, status: 'SUCCESS', cleanedIndexesCount: droppedCount });
      } catch (err) {
        results.push({ tenant: tenant.tenantCode, status: 'FAILED', error: err.message });
      } finally {
        if (conn) await conn.end();
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Sprint 2 — Auth ───────────────────────────────────────────────────────────
router.use('/auth', require('./auth.routes'));

// ── Sprint 3 — Platform Core & Tenant Onboarding ────────────────────────────
router.use('/cities',            require('./cities.routes'));
router.use('/platform-packages', require('./platform-packages.routes'));
router.use('/tenants',           require('./tenants.routes'));
router.use('/admin',             require('./admin.routes'));

router.use('/gyms',      require('./gyms.routes'));
router.use('/discovery', require('./discovery.routes'));
router.use('/host',      require('./host.routes'));

// ── Sprint 5 — Membership Plans & Subscriptions ───────────────────────────────
router.use('/membership-plans', require('./membership-plans.routes'));
router.use('/subscriptions',    require('./subscriptions.routes'));
router.use('/member',           require('./member.routes'));
router.use('/me',               require('./me.routes'));
router.use('/notifications',    require('./notifications.routes'));

// ── Sprint 6 — Payments, Attendance & Trainers ────────────────────────────────
router.use('/payments',   require('./payments.routes'));
router.use('/invoices',   require('./invoices.routes'));
router.use('/attendance', require('./attendance.routes'));
router.use('/trainers',   require('./trainers.routes'));

// ── Sprint 7 — Reports ────────────────────────────────────────────────────────
router.use('/reports', require('./reports.routes'));

router.use('/users', require('./users.routes'));
router.use('/staff-invites', require('./staff-invites.routes'));
router.use('/staff', require('./staff-actions.routes'));

// ── ZKTeco Biometric Device Management ───────────────────────────────────────
const { adminRouter: devicesAdminRouter, hostRouter: devicesHostRouter } = require('./devices.routes');
router.use('/admin/devices', devicesAdminRouter);
router.use('/devices', devicesHostRouter);

module.exports = router;
