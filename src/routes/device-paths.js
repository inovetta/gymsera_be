/**
 * ZKTeco device paths (docs/ZKTECO_PUSH_DEVICE_SYNC.md §4.5): /iclock/… and /d/<key>/iclock/….
 * No dependencies, so middleware that runs before the device router (the request timeout, NEW-240) can ask
 * without loading the device services and their database connections.
 */
const DEVICE_PATH = /^\/(?:d\/([A-Za-z0-9]{8})\/)?iclock(?:\/|$)/;
const isDevicePath = (path) => DEVICE_PATH.test(path);

module.exports = { DEVICE_PATH, isDevicePath };
