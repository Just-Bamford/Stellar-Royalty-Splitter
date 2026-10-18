/**
 * Vesting analytics — closes #1062.
 *
 * Pure, database-free projections for cliff + linear vesting schedules:
 *   - build a vesting schedule and show its curve (cliff / linear)
 *   - project available (unlocked) tokens at any future date
 *   - list discrete unlock events
 *   - simulate "what-if" parameter changes (cliff, duration, amount)
 *
 * The DB-backed `database/vesting.js` module handles persistence and token
 * releases; this module is the read-only analytics layer that powers the
 * dashboard and simulator.
 */

import { addMonths } from "./token-economics.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDate(value) {
  if (value instanceof Date) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Validate + normalise a vesting schedule input.
 */
export function normalizeVestingSchedule(input = {}) {
  const totalAmount = num(input.totalAmount);
  if (totalAmount <= 0) {
    throw new Error("totalAmount must be a positive number");
  }
  const startDate = toDate(input.startDate ?? new Date()).toISOString();
  return {
    id: input.id ?? null,
    label: input.label ?? "Vesting",
    beneficiary: input.beneficiary ?? null,
    contractId: input.contractId ?? null,
    totalAmount,
    releasedAmount: Math.min(Math.max(0, num(input.releasedAmount)), totalAmount),
    startDate,
    cliffMonths: Math.max(0, num(input.cliffMonths)),
    vestingMonths: Math.max(0, num(input.vestingMonths)),
  };
}

/** Gross vested amount (ignores releases) at `date`. */
export function vestedAmountAt(schedule, date = new Date()) {
  const normalized = schedule.cliffMonths === undefined
    ? normalizeVestingSchedule(schedule)
    : schedule;

  const at = toDate(date).getTime();
  const start = toDate(normalized.startDate).getTime();
  if (at < start) return 0;

  const cliffEnd = addMonths(normalized.startDate, normalized.cliffMonths);
  if (at < cliffEnd.getTime()) return 0;

  const vestingMonths = normalized.vestingMonths;
  if (vestingMonths <= 0) return normalized.totalAmount;

  const vestingEnd = addMonths(cliffEnd, vestingMonths);
  if (at >= vestingEnd.getTime()) return normalized.totalAmount;

  const elapsed = at - cliffEnd.getTime();
  const duration = vestingEnd.getTime() - cliffEnd.getTime();
  return round(normalized.totalAmount * (elapsed / duration), 6);
}

/** Unlocked-but-not-yet-released tokens at `date`. */
export function availableTokensAt(schedule, date = new Date()) {
  const normalized = schedule.cliffMonths === undefined
    ? normalizeVestingSchedule(schedule)
    : schedule;
  const vested = vestedAmountAt(normalized, date);
  return round(Math.max(0, vested - num(normalized.releasedAmount)), 6);
}

/**
 * Build a schedule with its metadata, projection points and unlock events.
 */
export function buildVestingSchedule(input, options = {}) {
  const schedule = normalizeVestingSchedule(input);
  const cliffDate = addMonths(schedule.startDate, schedule.cliffMonths);
  const vestingEndDate = addMonths(cliffDate, schedule.vestingMonths);

  const intervalDays = Math.max(1, num(options.intervalDays, 30));
  const from = options.from ? toDate(options.from) : new Date(schedule.startDate);
  const to = options.to ? toDate(options.to) : vestingEndDate;

  const points = [];
  const totalSteps = Math.max(
    0,
    Math.ceil((to.getTime() - from.getTime()) / (intervalDays * MS_PER_DAY)),
  );
  for (let step = 0; step <= totalSteps; step++) {
    const date = new Date(from.getTime() + step * intervalDays * MS_PER_DAY);
    if (date.getTime() > to.getTime()) break;
    points.push({
      date: date.toISOString(),
      vestedAmount: vestedAmountAt(schedule, date),
      availableAmount: availableTokensAt(schedule, date),
      vestedPercent: round(
        (vestedAmountAt(schedule, date) / schedule.totalAmount) * 100,
        2,
      ),
    });
  }

  return {
    ...schedule,
    cliffDate: cliffDate.toISOString(),
    vestingEndDate: vestingEndDate.toISOString(),
    currentVestedAmount: vestedAmountAt(schedule, new Date()),
    currentAvailableAmount: availableTokensAt(schedule, new Date()),
    unlockEvents: getUnlockEvents(schedule, options),
    points,
  };
}

/**
 * Discrete monthly unlock events for a single schedule.
 */
export function getUnlockEvents(schedule, options = {}) {
  const normalized = schedule.cliffMonths === undefined
    ? normalizeVestingSchedule(schedule)
    : schedule;

  const maxMonths = Math.max(
    1,
    num(options.horizonMonths, normalized.cliffMonths + normalized.vestingMonths),
  );
  const from = options.from ? toDate(options.from) : toDate(normalized.startDate);

  const events = [];
  let previous = vestedAmountAt(normalized, from);
  for (let month = 1; month <= maxMonths; month++) {
    const date = addMonths(from, month);
    const vested = vestedAmountAt(normalized, date);
    const delta = round(vested - previous, 6);
    if (delta > 0) {
      events.push({
        date: date.toISOString(),
        month,
        unlockedAmount: delta,
        cumulativeVested: vested,
        vestedPercent: round((vested / normalized.totalAmount) * 100, 2),
      });
    }
    previous = vested;
  }
  return events;
}

/**
 * Aggregate projection across many schedules.
 */
export function projectVesting(schedules = [], options = {}) {
  const normalized = schedules.map((s) =>
    s.cliffMonths === undefined ? normalizeVestingSchedule(s) : s,
  );

  if (normalized.length === 0) {
    return {
      from: null,
      to: null,
      intervalDays: num(options.intervalDays, 30),
      totalAmount: 0,
      points: [],
    };
  }

  const intervalDays = Math.max(1, num(options.intervalDays, 30));
  const starts = normalized.map((s) => toDate(s.startDate).getTime());
  const ends = normalized.map((s) =>
    addMonths(addMonths(s.startDate, s.cliffMonths), s.vestingMonths).getTime(),
  );
  const from = options.from
    ? toDate(options.from)
    : new Date(Math.min(...starts));
  const to = options.to ? toDate(options.to) : new Date(Math.max(...ends));

  const points = [];
  const totalSteps = Math.max(
    0,
    Math.ceil((to.getTime() - from.getTime()) / (intervalDays * MS_PER_DAY)),
  );
  for (let step = 0; step <= totalSteps; step++) {
    const date = new Date(from.getTime() + step * intervalDays * MS_PER_DAY);
    if (date.getTime() > to.getTime()) break;
    const vested = normalized.reduce((sum, s) => sum + vestedAmountAt(s, date), 0);
    const released = normalized.reduce((sum, s) => sum + s.releasedAmount, 0);
    const totalAmount = normalized.reduce((sum, s) => sum + s.totalAmount, 0);
    points.push({
      date: date.toISOString(),
      vestedAmount: round(vested, 4),
      availableAmount: round(Math.max(0, vested - released), 4),
      vestedPercent: totalAmount ? round((vested / totalAmount) * 100, 2) : 0,
    });
  }

  const totalAmount = normalized.reduce((sum, s) => sum + s.totalAmount, 0);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    intervalDays,
    totalAmount,
    points,
  };
}

/**
 * Full vesting analytics for a set of schedules.
 */
export function buildVestingAnalytics(schedules = [], options = {}) {
  const asOf = options.asOf ? toDate(options.asOf) : new Date();
  const normalized = schedules.map((s) => normalizeVestingSchedule(s));

  let totalAmount = 0;
  let totalVested = 0;
  let totalAvailable = 0;
  let totalReleased = 0;

  const perSchedule = normalized.map((schedule) => {
    const vested = vestedAmountAt(schedule, asOf);
    const available = availableTokensAt(schedule, asOf);
    totalAmount += schedule.totalAmount;
    totalVested += vested;
    totalAvailable += available;
    totalReleased += schedule.releasedAmount;

    const vestingEnd = addMonths(
      addMonths(schedule.startDate, schedule.cliffMonths),
      schedule.vestingMonths,
    );
    let status = "vesting";
    if (asOf.getTime() < toDate(addMonths(schedule.startDate, schedule.cliffMonths)).getTime()) {
      status = "cliff";
    } else if (asOf.getTime() >= vestingEnd.getTime()) {
      status = "fully_vested";
    }

    return {
      ...schedule,
      vestedAmount: round(vested, 4),
      availableAmount: round(available, 4),
      lockedAmount: round(Math.max(0, schedule.totalAmount - vested), 4),
      vestedPercent: round((vested / schedule.totalAmount) * 100, 2),
      status,
      cliffDate: addMonths(schedule.startDate, schedule.cliffMonths).toISOString(),
      vestingEndDate: vestingEnd.toISOString(),
    };
  });

  const mergedEvents = new Map();
  for (const schedule of normalized) {
    for (const event of getUnlockEvents(schedule, { from: asOf, ...options })) {
      const key = event.date;
      const existing = mergedEvents.get(key);
      if (existing) {
        existing.unlockedAmount = round(
          existing.unlockedAmount + event.unlockedAmount,
          4,
        );
      } else {
        mergedEvents.set(key, { ...event });
      }
    }
  }

  return {
    asOf: asOf.toISOString(),
    scheduleCount: normalized.length,
    totalAmount: round(totalAmount, 4),
    totalVested: round(totalVested, 4),
    totalAvailable: round(totalAvailable, 4),
    totalReleased: round(totalReleased, 4),
    totalLocked: round(Math.max(0, totalAmount - totalVested), 4),
    vestedPercent: totalAmount ? round((totalVested / totalAmount) * 100, 2) : 0,
    schedules: perSchedule,
    unlockEvents: [...mergedEvents.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
    projection: projectVesting(normalized, {
      from: asOf,
      intervalDays: options.intervalDays,
      ...options,
    }),
  };
}

/**
 * "What-if" simulation: apply `overrides` to a schedule and compare base vs
 * scenario metrics at the horizon.
 */
export function simulateVesting(scheduleInput, overrides = {}, options = {}) {
  const base = normalizeVestingSchedule(scheduleInput);
  const scenario = normalizeVestingSchedule({ ...base, ...overrides });
  const asOf = options.asOf ? toDate(options.asOf) : new Date();

  const horizonMonths = Math.max(1, num(options.horizonMonths, 12));
  const futureDate = addMonths(asOf, horizonMonths);

  const baseAt = vestedAmountAt(base, futureDate);
  const scenarioAt = vestedAmountAt(scenario, futureDate);

  return {
    asOf: asOf.toISOString(),
    horizonMonths,
    futureDate: futureDate.toISOString(),
    base: {
      schedule: base,
      vestedAtHorizon: round(baseAt, 4),
      availableAtHorizon: round(availableTokensAt(base, futureDate), 4),
      vestedPercent: round((baseAt / base.totalAmount) * 100, 2),
      vestingEndDate: addMonths(
        addMonths(base.startDate, base.cliffMonths),
        base.vestingMonths,
      ).toISOString(),
    },
    scenario: {
      schedule: scenario,
      vestedAtHorizon: round(scenarioAt, 4),
      availableAtHorizon: round(availableTokensAt(scenario, futureDate), 4),
      vestedPercent: round((scenarioAt / scenario.totalAmount) * 100, 2),
      vestingEndDate: addMonths(
        addMonths(scenario.startDate, scenario.cliffMonths),
        scenario.vestingMonths,
      ).toISOString(),
    },
    comparison: {
      vestedDelta: round(scenarioAt - baseAt, 4),
      availableDelta: round(
        availableTokensAt(scenario, futureDate) -
          availableTokensAt(base, futureDate),
        4,
      ),
    },
  };
}

/** Build a CSV table for a set of vesting schedules. */
export function vestingToCsv(analytics) {
  const header =
    "Label,Beneficiary,Total Amount,Vested Amount,Available Amount,Released Amount,Vested %,Status,Cliff Date,Vesting End";
  const rows = (analytics.schedules ?? []).map((s) =>
    [
      s.label,
      s.beneficiary ?? "",
      s.totalAmount,
      s.vestedAmount,
      s.availableAmount,
      s.releasedAmount,
      s.vestedPercent,
      s.status,
      s.cliffDate,
      s.vestingEndDate,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header, ...rows].join("\r\n");
}

function csvCell(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default {
  normalizeVestingSchedule,
  vestedAmountAt,
  availableTokensAt,
  buildVestingSchedule,
  getUnlockEvents,
  projectVesting,
  buildVestingAnalytics,
  simulateVesting,
  vestingToCsv,
};
