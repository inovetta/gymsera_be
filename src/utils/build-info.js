/**
 * Which build this process runs (NEW-130), for `/health` and the boot line.
 *
 * NEW-127: on 2026-10-24 the API answered with a September build while newer files were on
 * disk, and nothing showed it (`/health` always said 1.1.0). Read once, when the process starts,
 * so it names the code this process loaded, not whatever a later `git pull` put on disk.
 *
 * Sources, first found wins:
 *   1. GYMSERA_BUILD_COMMIT (+ GYMSERA_BUILD_TIME), set by a deploy;
 *   2. `build-info.json` ({ commit, builtAt }) in the app folder, written by a copy-style deploy;
 *   3. the app folder's own git checkout (the server deploys with git pull): HEAD and its
 *      commit time. A folder that is only inside some other repo does not count;
 *   4. nothing: commit "unknown" (never a guess).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..', '..');
const STARTED_AT = new Date().toISOString();

const fromEnv = (env) => (env.GYMSERA_BUILD_COMMIT
  ? { commit: env.GYMSERA_BUILD_COMMIT, builtAt: env.GYMSERA_BUILD_TIME || null, source: 'env' }
  : null);

const fromFile = (root) => {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
    return info && info.commit ? { commit: String(info.commit), builtAt: info.builtAt || null, source: 'build-info.json' } : null;
  } catch (_) {
    return null;
  }
};

const git = (root, args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
}).trim();

const fromGit = (root) => {
  try {
    if (fs.realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== fs.realpathSync(root)) return null;
    const [commit, committedAt] = git(root, ['log', '-1', '--format=%H %cI']).split(' ');
    return /^[0-9a-f]{40}$/.test(commit) ? { commit, builtAt: committedAt || null, source: 'git' } : null;
  } catch (_) {
    return null;
  }
};

/** { commit, builtAt, source } for the app folder `root`. Never throws. */
const readBuildInfo = ({ env = process.env, root = APP_ROOT } = {}) =>
  fromEnv(env) || fromFile(root) || fromGit(root) || { commit: 'unknown', builtAt: null, source: 'none' };

let cached = null;

/** This process's build, read on first use (server.js reads it at startup) and kept. */
const getBuildInfo = () => {
  if (!cached) cached = readBuildInfo();
  return cached;
};

module.exports = { readBuildInfo, getBuildInfo, STARTED_AT };
