/**
 * push.gymsera.com may only carry device paths (spec ZKTECO_PUSH_DEVICE_SYNC.md §4.5): the second
 * copy of the IIS rule, so a mistake in one never opens /api/v1 on the relaxed Cloudflare hostname.
 *
 * A request is a "push host" request when the host the client used (X-Original-Host from the IIS
 * push site, else Host) is DEVICE_PUSH_HOST or ends with a DEVICE_HOST_KEY_SUFFIXES entry, or when
 * it arrives on the local proxy binding (DEVICE_PROXY_LOCAL_HOSTS) without X-Original-Host (fail
 * closed). Such a request may only reach /iclock/* and /d/<key>/iclock/*; anything else is 404 in
 * plain text. The local binding with another X-Original-Host (Appendix A, CMS / website) passes.
 */
const { getDeviceConfig } = require('../config/devices.config');
const { isDevicePath, effectiveHost, hostWithoutPort, send } = require('../routes/device-push.routes');

function isPushHostRequest(req) {
  const cfg = getDeviceConfig();
  const host = hostWithoutPort(effectiveHost(req));
  if (host === cfg.pushHost) return true;
  if (cfg.hostKeySuffixes.some((s) => host.endsWith(s))) return true;
  const rawHost = String(req.headers.host || '').trim().toLowerCase();
  return !req.headers['x-original-host'] && cfg.proxyLocalHosts.includes(rawHost);
}

module.exports = function pushHostGuard(req, res, next) {
  if (!isPushHostRequest(req) || isDevicePath(req.path)) return next();
  return send(res, 404, 'Not Found\n');
};
module.exports.isPushHostRequest = isPushHostRequest;
