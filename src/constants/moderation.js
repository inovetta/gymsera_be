'use strict';
/**
 * NEW-256: reporting, blocking and the word filter (App Store 1.2, Google Play UGC policy).
 * One list of values shared by the routes, the services, the migration seed and the tests.
 */

/** What can be reported. */
const ReportTargetType = Object.freeze({
  REVIEW: 'REVIEW',
  MESSAGE: 'MESSAGE',
});

/** Why. The clients show these as a picker; OTHER takes a short note. */
const ReportReason = Object.freeze({
  SPAM: 'SPAM',
  HARASSMENT: 'HARASSMENT',
  HATE: 'HATE',
  SEXUAL: 'SEXUAL',
  VIOLENCE: 'VIOLENCE',
  FALSE_INFO: 'FALSE_INFO',
  OTHER: 'OTHER',
});

const ReportStatus = Object.freeze({
  OPEN: 'OPEN',
  ACTIONED: 'ACTIONED',
  DISMISSED: 'DISMISSED',
});

/** What a platform admin can do with a report. */
const ReportAction = Object.freeze({
  DISMISS: 'DISMISS',
  HIDE_REVIEW: 'HIDE_REVIEW',
  DELETE_MESSAGE: 'DELETE_MESSAGE',
  SUSPEND_USER: 'SUSPEND_USER',
});

/** Which actions fit which target. SUSPEND_USER suspends the author of the content. */
const ACTIONS_BY_TARGET = Object.freeze({
  [ReportTargetType.REVIEW]: [ReportAction.DISMISS, ReportAction.HIDE_REVIEW, ReportAction.SUSPEND_USER],
  [ReportTargetType.MESSAGE]: [ReportAction.DISMISS, ReportAction.DELETE_MESSAGE, ReportAction.SUSPEND_USER],
});

/** Target response time for an open report (owner, 2026-11-16). The CMS flags older ones. */
const REPORT_RESPONSE_HOURS = 24;

/** Who blocked: the traveller (blocks the gym) or the gym (blocks the traveller). */
const BlockSide = Object.freeze({
  USER: 'USER',
  ORGANIZATION: 'ORGANIZATION', // R-120 NEW-307 (p034): was TENANT
});

/**
 * The starter word list (owner: "a short starter list I can edit"). Seeded once by platform
 * migration p031; after that the list lives in `moderation_words` and is edited in the CMS.
 * Matched as whole words, case-insensitive.
 */
const STARTER_WORDS = Object.freeze([
  'fuck',
  'fucking',
  'motherfucker',
  'shit',
  'bullshit',
  'bitch',
  'bastard',
  'asshole',
  'dickhead',
  'cunt',
  'slut',
  'whore',
]);

const WORD_LIST_LIMITS = Object.freeze({ maxWords: 500, minLength: 2, maxLength: 50 });

/** What a person sees when the filter stops a message or review. */
const BLOCKED_WORDS_MESSAGE = 'Please remove offensive language and try again.';

module.exports = {
  ReportTargetType,
  ReportReason,
  ReportStatus,
  ReportAction,
  ACTIONS_BY_TARGET,
  REPORT_RESPONSE_HOURS,
  BlockSide,
  STARTER_WORDS,
  WORD_LIST_LIMITS,
  BLOCKED_WORDS_MESSAGE,
};
