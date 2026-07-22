const mysql = require('mysql2/promise');

async function run() {
  const connection = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    password: '',
    database: 'gymsera_platform',
    port: 3306
  });
  
  const [rows] = await connection.execute('select id, user_id, role, type, title, message, created_at from notifications order by created_at desc limit 10');
  console.log('--- RECENT NOTIFICATIONS ---');
  console.log(JSON.stringify(rows, null, 2));
  
  const [tenants] = await connection.execute('select id, owner_user_id, business_name, gym_name from tenants');
  console.log('--- TENANTS ---');
  console.log(JSON.stringify(tenants, null, 2));
  
  const [users] = await connection.execute('select id, email, role, full_name from users');
  console.log('--- USERS ---');
  console.log(JSON.stringify(users, null, 2));

  await connection.end();
}

run().catch(console.error);
