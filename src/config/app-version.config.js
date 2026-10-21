/**
 * NEW-81: the minimum app version, per platform, and where the update button goes.
 *
 * MIN_APP_VERSION_IOS / MIN_APP_VERSION_ANDROID  "1.2.3" or "1.2.3+45". Unset or malformed means no gate on
 *   that platform: a typo must never lock every user out.
 * APP_STORE_URL_IOS / APP_STORE_URL_ANDROID      https links. Android defaults to the Play listing.
 *
 * Read on every call so ops can change the value without a restart-sensitive cache.
 */
const VERSION_RE = /^\d+\.\d+\.\d+(\+\d+)?$/;
const DEFAULT_ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.inovettatech.gymsera';

const version = (name) => {
  const raw = (process.env[name] || '').trim();
  if (!raw) return null;
  if (VERSION_RE.test(raw)) return raw;
  console.warn(`[app-version] ${name} is not "x.y.z" or "x.y.z+build" and is ignored`);
  return null;
};

const url = (name, fallback = null) => {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  if (/^https:\/\//i.test(raw)) return raw;
  console.warn(`[app-version] ${name} must be an https link and is ignored`);
  return fallback;
};

const appConfig = () => ({
  minAppVersion: {
    ios: version('MIN_APP_VERSION_IOS'),
    android: version('MIN_APP_VERSION_ANDROID'),
  },
  storeUrls: {
    ios: url('APP_STORE_URL_IOS'),
    android: url('APP_STORE_URL_ANDROID', DEFAULT_ANDROID_URL),
  },
});

module.exports = { appConfig };
