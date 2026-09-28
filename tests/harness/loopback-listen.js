/**
 * Guard (TEST-FLAKE-1B): in tests, a server may not listen on a random port
 * on every address. Loaded by jest.config.js `setupFiles`, next to the network
 * block.
 *
 * supertest 7 starts a bare Express app with `app.listen(0)` — every address
 * (::) — and then calls 127.0.0.1 (node_modules/supertest/lib/test.js :90,
 * :105). On macOS the OS can hand that listen a port another program already
 * holds on 127.0.0.1 only; the request then reaches that program. That was the
 * intermittent full-suite failure (a different test each time, 403 / 400 /
 * "socket hang up", nothing in our own logs).
 *
 * Refusing it turns that rare, random failure into an immediate one with the
 * fix in the message. Test files use tests/harness/test-server.js instead.
 */
const http = require('http');

if (!http.Server.prototype.__gymseraLoopbackGuard) {
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function guardedListen(...args) {
    const [first] = args;
    const randomPortEveryAddress =
      (first === 0 && typeof args[1] !== 'string') ||
      (first && typeof first === 'object' && !first.path && !first.fd && !first.handle && first.port === 0 && !first.host);
    if (randomPortEveryAddress) {
      throw new Error(
        'Test servers must listen on 127.0.0.1: pass a server from tests/harness/test-server.js ' +
          '(startTestServer) to supertest instead of the bare app (TEST-FLAKE-1B).'
      );
    }
    return originalListen.apply(this, args);
  };
  Object.defineProperty(http.Server.prototype, '__gymseraLoopbackGuard', { value: true });
}
