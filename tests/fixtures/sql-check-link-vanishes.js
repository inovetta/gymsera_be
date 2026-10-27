/**
 * Preload for NEW-128 (`node -r <this> src/scripts/run-sql-check.js ...`): the MySQL link
 * disappears while the statement whose text contains SQL_CHECK_VANISH_ON is running. The query
 * promise never settles and the socket is gone without an 'error' event, so nothing keeps
 * Node's event loop alive: the process ends by itself, which is what production showed
 * (grid 1, then nothing).
 */
const mysql = require('mysql2/promise');

const marker = process.env.SQL_CHECK_VANISH_ON;
const realCreate = mysql.createConnection;

mysql.createConnection = async (...args) => {
  const conn = await realCreate(...args);
  const realQuery = conn.query.bind(conn);
  conn.query = (sql, ...rest) => {
    if (marker && String(sql).includes(marker)) {
      const stream = conn.connection.stream;
      stream.removeAllListeners();
      stream.destroy();
      return new Promise(() => {});
    }
    return realQuery(sql, ...rest);
  };
  return conn;
};
