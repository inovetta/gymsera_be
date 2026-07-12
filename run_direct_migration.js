const mysql = require('mysql2/promise');

async function main() {
  // Connect to the MySQL server as root
  const connection = await mysql.createConnection({
    host: 'localhost',
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
      
      // Check if columns already exist
      const [columns] = await connection.query(`SHOW COLUMNS FROM \`branches\`;`);
      const colNames = columns.map(c => c.Field);
      
      if (!colNames.includes('tagline')) {
        await connection.query('ALTER TABLE `branches` ADD COLUMN `tagline` VARCHAR(255) NULL;');
        console.log('  Added tagline column');
      }
      if (!colNames.includes('category')) {
        await connection.query('ALTER TABLE `branches` ADD COLUMN `category` VARCHAR(100) NULL;');
        console.log('  Added category column');
      }
      if (!colNames.includes('tags_json')) {
        await connection.query('ALTER TABLE `branches` ADD COLUMN `tags_json` JSON NULL;');
        console.log('  Added tags_json column');
      }
      console.log(`  Database ${dbName} migrated successfully!`);
    } catch (err) {
      console.error(`  Failed to migrate database ${dbName}:`, err.message);
    }
  }

  await connection.end();
  console.log('\nMigration check complete.');
}

main().catch(console.error);
