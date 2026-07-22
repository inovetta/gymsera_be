const mysql = require('mysql2/promise');

async function main() {
  // Connect to the MySQL server as root
  const connection = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
  });

  console.log('Connected to MySQL server');

  const [databases] = await connection.query('SHOW DATABASES;');
  const dbNames = databases.map(db => db.Database).filter(name => name.startsWith('gymsera_tenant_'));

  console.log('Found tenant databases:', dbNames);

  for (const dbName of dbNames) {
    console.log(`\nMigrating database: ${dbName}...`);
    try {
      await connection.query(`USE \`${dbName}\`;`);
      
      const [columns] = await connection.query(`SHOW COLUMNS FROM \`member_subscriptions\`;`);
      const colNames = columns.map(c => c.Field);
      
      if (!colNames.includes('notes')) {
        await connection.query('ALTER TABLE `member_subscriptions` ADD COLUMN `notes` TEXT NULL;');
        console.log('  Added notes column to member_subscriptions');
      } else {
        console.log('  notes column already exists');
      }
      console.log(`  Database ${dbName} migrated successfully!`);
    } catch (err) {
      console.error(`  Failed to migrate database ${dbName}:`, err.message);
    }
  }

  await connection.end();
  console.log('\nMigration complete.');
}

main().catch(console.error);
