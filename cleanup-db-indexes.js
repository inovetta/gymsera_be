const mysql = require('mysql2/promise');
require('dotenv').config();

async function run() {
  const { Tenant } = require('./src/models/platform');
  const { decrypt } = require('./src/utils/crypto.utils');

  try {
    const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
    console.log(`Found ${tenants.length} active tenants to clean up.`);

    for (const tenant of tenants) {
      console.log(`\n----------------------------------------`);
      console.log(`Processing Tenant: ${tenant.tenantCode} (${tenant.id})`);

      const connUrl = decrypt(tenant.connectionStringEncrypted);
      const matches = connUrl.match(/mysql:\/\/([^:]+):([^@]*)@([^:]+):(\d+)\/(.+)/);
      if (!matches) {
        console.error(`Invalid connection URL for tenant ${tenant.tenantCode}`);
        continue;
      }

      const [, dbUser, dbPass, dbHost, dbPort, dbName] = matches;
      let conn;
      try {
        conn = await mysql.createConnection({
          host: dbHost,
          port: parseInt(dbPort),
          user: dbUser,
          password: dbPass,
          database: dbName,
        });

        // Get all tables
        const [tables] = await conn.query('SHOW TABLES');
        const tableNames = tables.map(row => Object.values(row)[0]);
        console.log(`Tables in ${dbName}:`, tableNames);

        for (const tableName of tableNames) {
          // Get all indexes for this table
          const [indexes] = await conn.query(`SHOW INDEX FROM \`${tableName}\``);
          
          // Group indexes by Key_name
          const indexGroups = {};
          for (const idx of indexes) {
            const keyName = idx.Key_name;
            if (!indexGroups[keyName]) {
              indexGroups[keyName] = [];
            }
            indexGroups[keyName].push(idx.Column_name);
          }

          console.log(`Table \`${tableName}\` has ${Object.keys(indexGroups).length} indexes:`);
          
          // Identify duplicates/redundants
          // In Sequelize sync(alter: true) bug, it creates duplicate keys like:
          // name, name_2, name_3, name_4... with identical column structures
          const keysToDrop = [];
          const normalizedGroups = {}; // columnString -> primaryKeyName

          for (const [keyName, columns] of Object.entries(indexGroups)) {
            if (keyName === 'PRIMARY') continue;

            const colStr = columns.sort().join(',');
            // If we have already seen an index with the exact same columns, we can drop this one!
            // OR if the keyName matches the auto-increment pattern (e.g. keyName ends with _2, _3, _4, etc.)
            const isSequentialDup = /_\d+$/.test(keyName);

            if (normalizedGroups[colStr]) {
              console.log(`  -> Duplicate index found: ${keyName} (columns: ${colStr}) is duplicate of ${normalizedGroups[colStr]}`);
              keysToDrop.push(keyName);
            } else if (isSequentialDup) {
              console.log(`  -> Sequential duplicate index found: ${keyName} (columns: ${colStr})`);
              keysToDrop.push(keyName);
            } else {
              normalizedGroups[colStr] = keyName;
            }
          }

          // Drop duplicate indexes
          for (const keyName of keysToDrop) {
            try {
              // Check if it's a foreign key constraint
              // Sometimes dropping index fails if it's used by a foreign key, but we can drop the foreign key first or just drop the index
              console.log(`  Dropping index \`${keyName}\` from table \`${tableName}\`...`);
              
              // Try to drop foreign key first if the name is also a foreign key
              try {
                await conn.query(`ALTER TABLE \`${tableName}\` DROP FOREIGN KEY \`${keyName}\``);
                console.log(`    Successfully dropped foreign key constraint \`${keyName}\``);
              } catch (fkErr) {
                // Ignore if it's not a foreign key
              }

              await conn.query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${keyName}\``);
              console.log(`    Successfully dropped index \`${keyName}\``);
            } catch (dropErr) {
              console.error(`    Failed to drop index \`${keyName}\`:`, dropErr.message);
            }
          }
        }
      } catch (dbErr) {
        console.error(`Error processing database for tenant ${tenant.tenantCode}:`, dbErr.message);
      } finally {
        if (conn) await conn.end();
      }
    }

    console.log('\nDatabase index cleanup completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

run();
