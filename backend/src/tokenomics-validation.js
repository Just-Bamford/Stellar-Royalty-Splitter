/**
 * Request validation for the tokenomics routes (#1370).
 *
 * The analytics functions are pure and CPU-bound, so an unbounded `schedules`
 * array or a config with unexpected nested properties can burn a lot of CPU or
 * crash them. Every validator here returns an error message, or `null` when the
 * value is acceptable, so a route can answer 400 `validation_failed` before any
 * computation starts.
 *
 * Field names follow the real models in `services/token-economics.js` and
 * `services/vesting-analytics.js` (`cliffMonths` / `vestingMonths`).
 */

export const MAX_SCHEDULES = 100;
export const MAX_ALLOCATIONS = 50;
export const MAX_NAME_LENGTH = 64;
export const MAX_SYMBOL_LENGTH = 16;
export const MAX_BENEFICIARY_LENGTH = 128;
export const MAX_MONTHS = 1200;
export const MAX_HORIZON_MONTHS = 600;
export const MAX_INTERVAL_DAYS = 3650;
/** Upper bound on projection points (horizon in days / interval). */
export const MAX_PROJECTION_POINTS = 5000;

const CONFIG_KEYS = ["tokenSymbol", "totalSupply", "tgeDate", "allocations"];
const ALLOCATION_KEYS = ["name", "amount", "tgePercent", "cliffMonths", "vestingMonths"];
const SCHEDULE_KEYS = [
  "id",
  "label",
  "beneficiary",
  "contractId",
  "totalAmount",
  "releasedAmount",
  "startDate",
  "cliffMonths",
  "vestingMonths",
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Numbers and non-empty numeric strings only; everything else is NaN. */
function toFinite(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

function unexpectedKeys(value, allowed) {
  // Own enumerable keys, which includes a JSON-supplied "__proto__".
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function checkKeys(value, allowed, label) {
  const extra = unexpectedKeys(value, allowed);
  if (extra.length === 0) return null;
  return `${label} contains unexpected keys: ${extra.slice(0, 5).join(", ")}`;
}

function checkNumber(value, label, { min, max, integer = false, exclusiveMin = false } = {}) {
  const n = toFinite(value);
  if (!Number.isFinite(n)) return `${label} must be a number`;
  if (integer && !Number.isInteger(n)) return `${label} must be an integer`;
  if (min !== undefined && (exclusiveMin ? n <= min : n < min)) {
    return `${label} must be ${exclusiveMin ? "greater than" : "at least"} ${min}`;
  }
  if (max !== undefined && n > max) return `${label} must be at most ${max}`;
  return null;
}

function checkString(value, label, maxLength) {
  if (typeof value !== "string" || value.trim() === "") return `${label} must be a non-empty string`;
  if (value.length > maxLength) return `${label} must be at most ${maxLength} characters`;
  return null;
}

function checkDate(value, label) {
  if (typeof value !== "string" && typeof value !== "number") return `${label} must be a valid date`;
  if (Number.isNaN(new Date(value).getTime())) return `${label} must be a valid date`;
  return null;
}

function firstError(...results) {
  return results.find((r) => r) ?? null;
}

function validateAllocation(allocation, label) {
  if (!isPlainObject(allocation)) return `${label} must be an object`;
  return firstError(
    checkKeys(allocation, ALLOCATION_KEYS, label),
    allocation.name !== undefined ? checkString(allocation.name, `${label}.name`, MAX_NAME_LENGTH) : null,
    allocation.amount !== undefined
      ? checkNumber(allocation.amount, `${label}.amount`, { min: 0 })
      : `${label}.amount is required`,
    allocation.tgePercent !== undefined
      ? checkNumber(allocation.tgePercent, `${label}.tgePercent`, { min: 0, max: 100 })
      : null,
    allocation.cliffMonths !== undefined
      ? checkNumber(allocation.cliffMonths, `${label}.cliffMonths`, { min: 0, max: MAX_MONTHS })
      : null,
    allocation.vestingMonths !== undefined
      ? checkNumber(allocation.vestingMonths, `${label}.vestingMonths`, { min: 0, max: MAX_MONTHS })
      : null,
  );
}

/**
 * Validate an economics config (or a scenario that overrides parts of one).
 * `null`/`undefined` mean "use the defaults" and are accepted.
 */
export function validateTokenomicsConfig(config, label = "config") {
  if (config === undefined || config === null) return null;
  if (!isPlainObject(config)) return `${label} must be an object`;

  const error = firstError(
    checkKeys(config, CONFIG_KEYS, label),
    config.tokenSymbol !== undefined
      ? checkString(config.tokenSymbol, `${label}.tokenSymbol`, MAX_SYMBOL_LENGTH)
      : null,
    config.totalSupply !== undefined
      ? checkNumber(config.totalSupply, `${label}.totalSupply`, { min: 0, exclusiveMin: true })
      : null,
    config.tgeDate !== undefined ? checkDate(config.tgeDate, `${label}.tgeDate`) : null,
  );
  if (error) return error;

  if (config.allocations !== undefined) {
    if (!Array.isArray(config.allocations)) return `${label}.allocations must be an array`;
    if (config.allocations.length > MAX_ALLOCATIONS) {
      return `${label}.allocations must contain at most ${MAX_ALLOCATIONS} items`;
    }
    for (let i = 0; i < config.allocations.length; i++) {
      const err = validateAllocation(config.allocations[i], `${label}.allocations[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

/**
 * Validate one vesting schedule. With `partial` (used for `overrides`) every
 * field is optional; otherwise `beneficiary` and `totalAmount` are required.
 */
export function validateVestingSchedule(schedule, label = "schedule", { partial = false } = {}) {
  if (schedule === undefined || schedule === null) {
    return partial ? null : `${label} is required`;
  }
  if (!isPlainObject(schedule)) return `${label} must be an object`;

  return firstError(
    checkKeys(schedule, SCHEDULE_KEYS, label),
    schedule.beneficiary !== undefined
      ? checkString(schedule.beneficiary, `${label}.beneficiary`, MAX_BENEFICIARY_LENGTH)
      : partial
        ? null
        : `${label}.beneficiary is required`,
    schedule.totalAmount !== undefined
      ? checkNumber(schedule.totalAmount, `${label}.totalAmount`, { min: 0, exclusiveMin: true })
      : partial
        ? null
        : `${label}.totalAmount is required`,
    schedule.releasedAmount !== undefined
      ? checkNumber(schedule.releasedAmount, `${label}.releasedAmount`, { min: 0 })
      : null,
    schedule.startDate !== undefined ? checkDate(schedule.startDate, `${label}.startDate`) : null,
    schedule.cliffMonths !== undefined
      ? checkNumber(schedule.cliffMonths, `${label}.cliffMonths`, { min: 0, max: MAX_MONTHS })
      : null,
    schedule.vestingMonths !== undefined
      ? checkNumber(schedule.vestingMonths, `${label}.vestingMonths`, { min: 0, max: MAX_MONTHS })
      : null,
    schedule.label !== undefined ? checkString(schedule.label, `${label}.label`, MAX_NAME_LENGTH) : null,
  );
}

/** Validate the `schedules` array: a bounded list of valid schedules. */
export function validateVestingSchedules(schedules) {
  if (!Array.isArray(schedules)) return "schedules must be an array";
  if (schedules.length > MAX_SCHEDULES) {
    return `schedules must contain at most ${MAX_SCHEDULES} items`;
  }
  for (let i = 0; i < schedules.length; i++) {
    const err = validateVestingSchedule(schedules[i], `schedules[${i}]`);
    if (err) return err;
  }
  return null;
}

/**
 * Validate the `options` object. Unknown option keys are tolerated (clients
 * send extras); only the keys the routes read are checked.
 */
export function validateTokenomicsOptions(options) {
  if (options === undefined || options === null) return null;
  if (!isPlainObject(options)) return "options must be an object";

  const error = firstError(
    options.horizonMonths !== undefined
      ? checkNumber(options.horizonMonths, "options.horizonMonths", {
          min: 1,
          max: MAX_HORIZON_MONTHS,
          integer: true,
        })
      : null,
    options.intervalDays !== undefined
      ? checkNumber(options.intervalDays, "options.intervalDays", {
          min: 1,
          max: MAX_INTERVAL_DAYS,
          integer: true,
        })
      : null,
    options.asOf !== undefined ? checkDate(options.asOf, "options.asOf") : null,
  );
  if (error) return error;

  if (options.horizonMonths !== undefined && options.intervalDays !== undefined) {
    const points = (Number(options.horizonMonths) * 30) / Number(options.intervalDays);
    if (points > MAX_PROJECTION_POINTS) {
      return `options.horizonMonths and options.intervalDays would produce more than ${MAX_PROJECTION_POINTS} projection points`;
    }
  }
  return null;
}
