/**
 * The app, already listening on 127.0.0.1, for supertest (TEST-FLAKE-1B).
 *
 * `request(expressApp)` makes supertest start the app itself with
 * `app.listen(0)` — every address (::) — and then call 127.0.0.1
 * (node_modules/supertest/lib/test.js:90, :105). On macOS the OS can give that
 * listen a port another program already holds on 127.0.0.1 only; the request
 * then reaches that program: a random 403 / 400 / "socket hang up" in
 * whichever test drew the port. Given a server that is already listening,
 * supertest uses its address as it is, so the port is one that was free on
 * 127.0.0.1 itself.
 *
 * Usage, at the top of a test file:
 *   const { startTestServer, stopTestServer } = require('../harness/test-server');
 *   let app;
 *   beforeAll(async () => { app = await startTestServer(); });
 *   afterAll(stopTestServer);
 * …and `request(app)` everywhere as before.
 */
const http = require('http');

let server = null;

const startTestServer = async () => {
  if (server?.listening) return server;
  server = http.createServer(require('../../app'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
};

const stopTestServer = async () => {
  if (!server) return;
  const s = server;
  server = null;
  if (s.closeAllConnections) s.closeAllConnections();
  await new Promise((resolve) => s.close(() => resolve()));
};

module.exports = { startTestServer, stopTestServer };
