/**
 * Test-run network jail (spec §14 R-19). Loaded by jest.config.js `setupFiles`
 * before any test or app code.
 *
 * Every outbound TCP/TLS connection and every DNS lookup is refused unless it
 * targets the local test infrastructure (MySQL, Redis, supertest's in-process
 * server). This is a network block, not blanked credentials: even with a real
 * Apple / Google / Stripe key loaded, a test has no path to their servers.
 *
 * It hooks net.Socket.prototype.connect, which http, https, tls, undici
 * (global fetch), axios, google-auth-library, the Stripe SDK, nodemailer and
 * mysql2 all go through, and every name-resolving function in `dns`
 * (lookup, resolve*, reverse, lookupService, dns.promises, dns.Resolver),
 * so an external hostname is never even resolved.
 */
const net = require('net');
const dns = require('dns');

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', 'mysql']);

/** Pure allow-list check — exported so a test can prove provider hosts are refused. */
const isAllowedHost = (host) => {
  if (host === undefined || host === null || host === '') return true; // Node's default is localhost
  return ALLOWED_HOSTS.has(String(host).toLowerCase().replace(/^\[|\]$/g, ''));
};

const blockedAttempts = [];

const blockedError = (host, port) => {
  const err = new Error(`[no-network] Outbound connection to ${host}${port ? `:${port}` : ''} blocked in tests (R-19)`);
  err.code = 'TEST_NETWORK_BLOCKED';
  return err;
};

if (!net.Socket.prototype.__gymseraNetworkJail) {
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(...args) {
    // connect(options[, cb]) | connect(path[, cb]) | connect(port[, host][, cb])
    let host;
    let port;
    let isPipe = false;
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]; // Node passes normalized [options, cb] internally
    if (first && typeof first === 'object') {
      if (first.path) isPipe = true;
      host = first.host;
      port = first.port;
    } else if (typeof first === 'string' && Number.isNaN(Number(first))) {
      isPipe = true; // unix socket path
    } else {
      port = first;
      host = typeof args[1] === 'string' ? args[1] : undefined;
    }

    if (!isPipe && !isAllowedHost(host)) {
      blockedAttempts.push({ host, port, at: new Date().toISOString() });
      const err = blockedError(host, port);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return originalConnect.apply(this, args);
  };

  const originalLookup = dns.lookup;
  dns.lookup = function patchedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    if (!isAllowedHost(hostname)) {
      blockedAttempts.push({ host: hostname, port: null, at: new Date().toISOString(), dns: true });
      process.nextTick(() => cb(blockedError(hostname)));
      return {};
    }
    return originalLookup.call(this, hostname, options, callback);
  };
  const originalPromisesLookup = dns.promises.lookup;
  dns.promises.lookup = async function patchedPromisesLookup(hostname, options) {
    if (!isAllowedHost(hostname)) {
      blockedAttempts.push({ host: hostname, port: null, at: new Date().toISOString(), dns: true });
      throw blockedError(hostname);
    }
    return originalPromisesLookup.call(this, hostname, options);
  };

  // dns.lookup (above) uses the OS resolver; the resolve* family and
  // dns.Resolver query DNS servers directly over the network — nodemailer
  // resolves SMTP hosts this way — so they are refused for non-local names
  // too. Covers the top-level functions, dns.promises, and both Resolver
  // classes, callback and promise styles.
  const RESOLVER_METHODS = [
    'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
    'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse',
  ];
  const recordDns = (hostname) =>
    blockedAttempts.push({ host: hostname, port: null, at: new Date().toISOString(), dns: true });
  const wrapCallbackStyle = (target, name) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function patchedResolve(hostname, ...rest) {
      if (!isAllowedHost(hostname)) {
        recordDns(hostname);
        const cb = rest[rest.length - 1];
        if (typeof cb === 'function') process.nextTick(() => cb(blockedError(hostname)));
        return this instanceof dns.Resolver ? undefined : {};
      }
      return original.call(this, hostname, ...rest);
    };
  };
  const wrapPromiseStyle = (target, name) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = async function patchedResolvePromise(hostname, ...rest) {
      if (!isAllowedHost(hostname)) {
        recordDns(hostname);
        throw blockedError(hostname);
      }
      return original.call(this, hostname, ...rest);
    };
  };
  for (const name of RESOLVER_METHODS) {
    wrapCallbackStyle(dns, name);
    wrapCallbackStyle(dns.Resolver.prototype, name);
    wrapPromiseStyle(dns.promises, name);
    wrapPromiseStyle(dns.promises.Resolver.prototype, name);
  }
  wrapCallbackStyle(dns, 'lookupService');
  wrapPromiseStyle(dns.promises, 'lookupService');

  Object.defineProperty(net.Socket.prototype, '__gymseraNetworkJail', { value: { blockedAttempts, isAllowedHost } });
}

module.exports = net.Socket.prototype.__gymseraNetworkJail;
