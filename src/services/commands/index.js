/**
 * Approvable command registry.
 *
 * An approvable action is registered here exactly once and executed through
 * `execute()` on both paths — immediately when the actor holds `<key>.direct`, and
 * on approval when they do not.
 *
 * That "exactly once" is the whole design. If creation logic is written twice —
 * once for the direct path, once for the post-approval path — they diverge within
 * three sprints, and the approved path is the one nobody tests because it is
 * harder to reach.
 *
 * A command:
 *   actionKey   a permission key from the catalogue ('members.create')
 *   summarize   one line for the approval inbox, computed at request time
 *   validate    re-run at approval time, not only at request time
 *   execute     performs the action; receives the same ctx and payload on both paths
 *
 * `validate` running again at decision time is not optional. Between request and
 * approval the member may already exist, the plan may have been archived, the
 * branch may have hit capacity, or the requester may have been revoked.
 */
const { createError } = require('../../utils/response.utils');

/** @type {Map<string, object>} */
const registry = new Map();

/**
 * Register a command. Throws on a duplicate so two modules cannot silently
 * claim the same action key.
 */
const register = (command) => {
  if (!command || !command.actionKey) {
    throw new Error('[commands] a command must declare an actionKey');
  }
  if (registry.has(command.actionKey)) {
    throw new Error(`[commands] duplicate command for ${command.actionKey}`);
  }
  if (typeof command.execute !== 'function') {
    throw new Error(`[commands] ${command.actionKey} has no execute()`);
  }
  registry.set(command.actionKey, {
    actionKey: command.actionKey,
    summarize: command.summarize || (() => null),
    validate: command.validate || (async () => {}),
    execute: command.execute,
  });
  return command;
};

const get = (actionKey) => registry.get(actionKey) || null;

const has = (actionKey) => registry.has(actionKey);

/**
 * The command for an action key, or a 400 explaining that the action is not
 * approvable yet. Better than a generic 500 when a module has a permission in the
 * catalogue but no command wired up.
 */
const getOrThrow = (actionKey) => {
  const cmd = registry.get(actionKey);
  if (!cmd) {
    throw createError(`No approvable command is registered for "${actionKey}"`, 400);
  }
  return cmd;
};

const registeredKeys = () => [...registry.keys()];

module.exports = { register, get, has, getOrThrow, registeredKeys };

// ── Built-in commands ────────────────────────────────────────────────────────
// Loaded *after* module.exports is assigned. Each command file requires this
// module back to call register(), and would otherwise receive a half-built
// exports object.
require('./member.commands');
require('./subscription.commands');
require('./expense.commands');
require('./announcement.commands');
require('./schedule.commands');
