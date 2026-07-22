const mysql = require('mysql2/promise');
require('dotenv').config();

async function run() {
  let connection;
  try {
    // 1. Connect to Platform DB
    connection = await mysql.createConnection({
      host: process.env.PLATFORM_DB_HOST || 'localhost',
      port: process.env.PLATFORM_DB_PORT || 3306,
      user: process.env.PLATFORM_DB_USER || 'root',
      password: process.env.PLATFORM_DB_PASS || '',
      database: process.env.PLATFORM_DB_NAME || 'gymsera_platform',
    });

    console.log('Connected to platform DB');

    // Find the user travelor.not@gmail.com
    const [users] = await connection.query('SELECT * FROM users WHERE email = ?', ['travelor.not@gmail.com']);
    if (users.length === 0) {
      console.log('User travelor.not@gmail.com not found!');
      process.exit(1);
    }
    const user = users[0];
    console.log('User found:', { id: user.id, fullName: user.full_name, role: user.role });

    // Find all active tenants
    const [tenants] = await connection.query('SELECT * FROM tenants WHERE status = "ACTIVE"');
    console.log(`Found ${tenants.length} active tenants.`);

    const CryptoJS = require('crypto-js');
    const ENCRYPTION_KEY = process.env.TENANT_CONN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    const decrypt = (encryptedText) => {
      const bytes = CryptoJS.AES.decrypt(encryptedText, ENCRYPTION_KEY);
      return bytes.toString(CryptoJS.enc.Utf8);
    };

    // For each tenant, connect and find staff actions
    for (const tenant of tenants) {
      console.log(`Checking tenant: ${tenant.tenant_code} (${tenant.id})`);
      let decryptedConn;
      try {
        decryptedConn = decrypt(tenant.connection_string_encrypted);
      } catch (decErr) {
        console.error(`Failed to decrypt connection string for tenant ${tenant.tenant_code}:`, decErr.message);
        continue;
      }

      // Extract host, port, user, password, database from decrypted connection string
      // Example: mysql://root:password@localhost:3306/database
      const matches = decryptedConn.match(/mysql:\/\/([^:]+):([^@]*)@([^:]+):(\d+)\/(.+)/);
      if (!matches) {
        console.error(`Invalid connection string format: ${decryptedConn}`);
        continue;
      }

      const [, dbUser, dbPass, dbHost, dbPort, dbName] = matches;
      let tenantConn;
      try {
        tenantConn = await mysql.createConnection({
          host: dbHost,
          port: parseInt(dbPort),
          user: dbUser,
          password: dbPass,
          database: dbName,
        });

        // 1. Check if user is staff
        const [staff] = await tenantConn.query('SELECT * FROM gym_staff WHERE user_id = ?', [user.id]);
        console.log(`  Staff records count: ${staff.length}`);
        for (const s of staff) {
          console.log(`    Staff ID: ${s.id}, Branch ID: ${s.branch_id}, Status: ${s.status}`);
          
          // Check action requests for this branch or staff member
          const [requests] = await tenantConn.query('SELECT * FROM staff_action_requests WHERE staff_id = ?', [s.id]);
          console.log(`    Action requests count: ${requests.length}`);
          for (const r of requests) {
            console.log(`      Request: ID=${r.id}, Action=${r.action_type}, Status=${r.status}`);
          }
        }

      } catch (tenantErr) {
        console.error(`  Error querying tenant DB for ${tenant.tenant_code}:`, tenantErr.message);
      } finally {
        if (tenantConn) await tenantConn.end();
      }
    }

    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

run();
