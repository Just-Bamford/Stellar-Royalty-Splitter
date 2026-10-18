/**
 * User Segmentation Service
 *
 * Provides audience segmentation based on earnings, activity, tenure,
 * and geography. Segments are computed from user profiles and can be
 * used by the campaign manager for targeted messaging.
 */

'use strict';

/** Default thresholds for earnings based segmentation. */
const DEFAULT_EARNINGS_THRESHOLDS = {
  high: 5000,
  medium: 1000,
};

/** Default thresholds for activity based segmentation (in days). */
const DEFAULT_ACTIVITY_THRESHOLDS = {
  active: 7,
  inactive: 30,
};

/** Default thresholds for tenure based segmentation (in days). */
const DEFAULT_TENURE_THRESHOLDS = {
  new: 30,
  established: 365,
};

/** Supported dimensions for segmentation. */
const SEGMENT_DIMENSIONS = ['earnings', 'activity', 'tenure', 'geography'];

/** Supported operators for targeting rules. */
const SUPPORTED_OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn'];

/**
 * Normalize an array of users into a consistent shape.
 * @param {Array<Object>} users
 * @returns {Array<Object>}
 */
function normalizeUsers(users) {
  if (!Array.isArray(users)) {
    throw new TypeError('users must be an array');
  }
  return users.map((user) => {
    if (!user || typeof user !== 'object') {
      throw new TypeError('each user must be an object');
    }
    const id = user.id != null ? user.id : user.userId;
    if (id == null) {
      throw new TypeError('each user must have an id or userId');
    }
    return {
      id: String(id),
      earnings: Number(user.earnings ?? 0),
      lastActiveAt: user.lastActiveAt ? new Date(user.lastActiveAt) : null,
      createdAt: user.createdAt ? new Date(user.createdAt) : null,
      country: user.country ? String(user.country).toUpperCase() : null,
      region: user.region ? String(user.region) : null,
      city: user.city ? String(user.city) : null,
      metadata: user.metadata || {},
    };
  });
}

/**
 * Classify a user by earnings level.
 * @param {number} earnings
 * @param {Object} thresholds
 * @returns {string}
 */
function classifyEarnings(earnings, thresholds) {
  if (earnings >= thresholds.high) return 'high';
  if (earnings >= thresholds.medium) return 'medium';
  return 'low';
}

/**
 * Classify a user by activity level.
 * @param {Date|null} lastActiveAt
 * @param {Date} now
 * @param {Object} thresholds
 * @returns {string}
 */
function classifyActivity(lastActiveAt, now, thresholds) {
  if (!lastActiveAt) return 'churned';
  const days = (now.getTime() - lastActiveAt.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= thresholds.active) return 'active';
  if (days <= thresholds.inactive) return 'inactive';
  return 'churned';
}

/**
 * Classify a user by tenure.
 * @param {Date|null} createdAt
 * @param {Date} now
 * @param {Object} thresholds
 * @returns {string}
 */
function classifyTenure(createdAt, now, thresholds) {
  if (!createdAt) return 'veteran';
  const days = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  if (days < thresholds.new) return 'new';
  if (days < thresholds.established) return 'established';
  return 'veteran';
}

/**
 * Classify a user by geography.
 * @param {Object} user
 * @returns {string}
 */
function classifyGeography(user) {
  if (user.country) return user.country;
  if (user.region) return user.region;
  if (user.city) return user.city;
  return 'unknown';
}

/**
 * Build a lookup of user id -> segment memberships for all dimensions.
 * @param {Array<Object>} users
 * @param {Object} [options]
 * @returns {Object}
 */
function buildSegmentMap(users, options = {}) {
  const normalized = normalizeUsers(users);
  const now = options.now ? new Date(options.now) : new Date();
  const earningsThresholds = { ...DEFAULT_EARNINGS_THRESHOLDS, ...(options.earningsThresholds || {}) };
  const activityThresholds = { ...DEFAULT_ACTIVITY_THRESHOLDS, ...(options.activityThresholds || {}) };
  const tenureThresholds = { ...DEFAULT_TENURE_THRESHOLDS, ...(options.tenureThresholds || {}) };

  const map = {};
  for (const user of normalized) {
    map[user.id] = {
      earnings: classifyEarnings(user.earnings, earningsThresholds),
      activity: classifyActivity(user.lastActiveAt, now, activityThresholds),
      tenure: classifyTenure(user.createdAt, now, tenureThresholds),
      geography: classifyGeography(user),
    };
  }
  return map;
}

/**
 * Create and size segments from a list of users.
 * @param {Array<Object>} users
 * @param {Object} [options]
 * @returns {Object}
 */
function createSegments(users, options = {}) {
  const normalized = normalizeUsers(users);
  const map = buildSegmentMap(normalized, options);

  const segments = {
    earnings: { high: [], medium: [], low: [] },
    activity: { active: [], inactive: [], churned: [] },
    tenure: { new: [], established: [], veteran: [] },
    geography: {},
  };

  for (const user of normalized) {
    const membership = map[user.id];
    segments.earnings[membership.earnings].push(user.id);
    segments.activity[membership.activity].push(user.id);
    segments.tenure[membership.tenure].push(user.id);
    if (!segments.geography[membership.geography]) {
      segments.geography[membership.geography] = [];
    }
    segments.geography[membership.geography].push(user.id);
  }

  return {
    totalUsers: normalized.length,
    segments: sizeSegments(segments),
    membershipMap: map,
  };
}

/**
 * Attach counts to each segment bucket.
 * @param {Object} segments
 * @returns {Object}
 */
function sizeSegments(segments) {
  const result = {};
  for (const dimension of SEGMENT_DIMENSIONS) {
    const buckets = segments[dimension] || {};
    result[dimension] = {};
    for (const [key, ids] of Object.entries(buckets)) {
      result[dimension][key] = { count: ids.length, userIds: ids.slice() };
    }
  }
  return result;
}

/**
 * Evaluate a single targeting rule against a user's segment membership.
 * @param {Object} membership
 * @param {Object} rule
 * @returns {boolean}
 */
function matchRule(membership, rule) {
  if (!rule || typeof rule !== 'object') {
    throw new TypeError('rule must be an object');
  }
  const { dimension, operator = 'eq', value } = rule;
  if (!SEGMENT_DIMENSIONS.includes(dimension)) {
    throw new Error(`Unsupported segment dimension: ${dimension}`);
  }
  if (!SUPPORTED_OPERATORS.includes(operator)) {
    throw new Error(`Unsupported operator: ${operator}`);
  }
  const actual = membership[dimension];
  switch (operator) {
    case 'eq':
      return actual === value;
    case 'ne':
      return actual !== value;
    case 'in':
      return Array.isArray(value) && value.includes(actual);
    case 'notIn':
      return Array.isArray(value) && !value.includes(actual);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const numericActual = Number(actual);
      const numericValue = Number(value);
      if (Number.isNaN(numericActual) || Number.isNaN(numericValue)) {
        return false;
      }
      if (operator === 'gt') return numericActual > numericValue;
      if (operator === 'gte') return numericActual >= numericValue;
      if (operator === 'lt') return numericActual < numericValue;
      return numericActual <= numericValue;
    }
    default:
      return false;
  }
}

/**
 * Evaluate a targeting spec (and/or groups) against a user's membership.
 * @param {Object} membership
 * @param {Object} targeting
 * @returns {boolean}
 */
function matchTargeting(membership, targeting) {
  if (!targeting) return true;
  const { all, any, not } = targeting;
  if (Array.isArray(all) && all.length > 0) {
    if (!all.every((rule) => matchRule(membership, rule))) return false;
  }
  if (Array.isArray(any) && any.length > 0) {
    if (!any.some((rule) => matchRule(membership, rule))) return false;
  }
  if (Array.isArray(not) && not.length > 0) {
    if (not.some((rule) => matchRule(membership, rule))) return false;
  }
  return true;
}

/**
 * Return the user IDs that match a targeting spec.
 * @param {Array<Object>|Object>} usersOrSegmentData
 * @param {Object} targeting
 * @param {Object} [options]
 * @returns {Array<string>}
 */
function getTargetedUserIds(usersOrSegmentData, targeting, options = {}) {
  const map = usersOrSegmentData.membershipMap
    ? usersOrSegmentData.membershipMap
    : buildSegmentMap(usersOrSegmentData, options);
  const ids = [];
  for (const [id, membership] of Object.entries(map)) {
    if (matchTargeting(membership, targeting)) ids.push(id);
  }
  return ids;
}

/**
 * Export an audience list for a targeting spec as CSV.
 * @param {Array<Object>} users
 * @param {Object} targeting
 * @param {Object} [options]
 * @returns {string}
 */
function exportAudienceCsv(users, targeting, options = {}) {
  const normalized = normalizeUsers(users);
  const map = buildSegmentMap(normalized, options);
  const header = ['id', 'earnings', 'activity', 'tenure', 'geography', 'earnings', 'country'];
  const lines = [header.join(',')];
  for (const user of normalized) {
    const membership = map[user.id];
    if (!matchTargeting(membership, targeting)) continue;
    const row = [
      user.id,
      membership.earnings,
      membership.activity,
      membership.tenure,
      membership.geography,
      user.earnings,
      user.country || '',
    ];
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\n');
}

/**
 * Escape a CSV field.
 * @param {*} value
 * @returns {string}
 */
function csvEscape(value) {
  if (value == null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `" ${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Return the complete segment catalog with sizes and metadata.
 * @param {Array<Object>} users
 * @param {Object} [options]
 * @returns {Object}
 */
function getSegmentCatalog(users, options = {}) {
  const { totalUsers, segments } = createSegments(users, options);
  const catalog = {};
  for (const dimension of SEGMENT_DIMENSIONS) {
    catalog[dimension] = Object.entries(segments[dimension] || {}).map(([key, info]) => ({
      key,
      count: info.count,
      percentage: totalUsers > 0 ? Number(((info.count / totalUsers) * 100).toFixed(2)) : 0,
    }));
  }
  return { totalUsers, catalog };
}

module.exports = {
  SEGMENT_DIMENSIONS,
  SUPPORTED_OPERATORS,
  DEFAULT_EARNINGS_THRESHOLDS,
  DEFAULT_ACTIVITY_THRESHOLDS,
  DEFAULT_TENURE_THRESHOLDS,
  normalizeUsers,
  classifyEarnings,
  classifyActivity,
  classifyTenure,
  classifyGeography,
  buildSegmentMap,
  createSegments,
  sizeSegments,
  matchRule,
  matchTargeting,
  getTargetedUserIds,
  exportAudienceCsv,
  getSegmentCatalog,
};
