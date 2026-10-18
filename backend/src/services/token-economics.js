/**
 * Advanced token economics model — closes #1062.
 *
 * Pure, database-free maths for modelling a token's supply over time:
 *   - track token supply (total / circulating / locked) at any date
 *   - project future supply from an allocation + vesting schedule
 *   - calculate dilution impact for existing holders
 *   - simulate alternative distribution strategies ("what-if")
 *
 * Every function is deterministic and takes an explicit `date`/`now` so it can
 * be unit-tested without freezing the clock.  Allocations must sum to
 * `totalSupply`; each allocation unlocks a `tgePercent` at the token
 * generation event (TGE) and the remainder vests linearly after
 * `cliffMonths`, over `vestingMonths`.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_TGE_DATE = "2025-01-01T00:00:00.000Z";

export const DEFAULT_TOKEN_ECONOMICS = {
  tokenSymbol: "SRS",
  totalSupply: 1_000_000_000,
  tgeDate: DEFAULT_TGE_DATE,
  allocations: [
    { name: "Team", amount: 200_000_000, tgePercent: 0, cliffMonths: 12, vestingMonths: 36 },
    { name: "Investors", amount: 150_000_000, tgePercent: 10, cliffMonths: 6, vestingMonths: 24 },
    { name: "Community", amount: 400_000_000, tgePercent: 15, cliffMonths: 0, vestingMonths: 48 },
    { name: "Treasury", amount: 250_000_000, tgePercent: 5, cliffMonths: 3, vestingMonths: 36 },
  ],
};

function toDate(value) {
  if (value instanceof Date) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

/** Return a new date advanced by `months` calendar months (UTC). */
export function addMonths(date, months) {
  const result = new Date(toDate(date).getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  // Clamp to the last valid day of the target month.
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Percentage of an allocation unlocked at `date` (0–100). */
export function allocationUnlockPercent(allocation, tgeDate, date) {
  const start = toDate(tgeDate).getTime();
  const at = toDate(date).getTime();
  if (at < start) return 0;

  const tgeUnlock = clampPercent(allocation.tgePercent ?? 0);
  const cliffEnd = addMonths(tgeDate, allocation.cliffMonths ?? 0).getTime();
  const vestingMonths = Math.max(0, allocation.vestingMonths ?? 0);

  if (at < cliffEnd || vestingMonths === 0) {
    return tgeUnlock;
  }

  const vestingEnd = addMonths(new Date(cliffEnd), vestingMonths).getTime();
  if (at >= vestingEnd) return 100;

  const elapsed = at - cliffEnd;
  const duration = vestingEnd - cliffEnd;
  const linear = (elapsed / duration) * (100 - tgeUnlock);
  return round(tgeUnlock + linear);
}

function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(100, Math.max(0, num));
}

/**
 * Circulating supply at `date`, given a normalised config.
 * @returns {{ totalSupply: number, circulatingSupply: number, lockedSupply: number, circulatingPercent: number, allocations: Array }}
 */
export function circulatingSupplyAt(config, date = new Date()) {
  const tgeDate = config.tgeDate ?? DEFAULT_TGE_DATE;
  let circulating = 0;

  const breakdown = (config.allocations ?? []).map((allocation) => {
    const unlockedPercent = allocationUnlockPercent(allocation, tgeDate, date);
    const unlocked = (Number(allocation.amount) || 0) * (unlockedPercent / 100);
    circulating += unlocked;
    return {
      name: allocation.name,
      amount: Number(allocation.amount) || 0,
      unlockedPercent,
      unlockedAmount: round(unlocked, 2),
      lockedAmount: round((Number(allocation.amount) || 0) - unlocked, 2),
    };
  });

  const totalSupply = Number(config.totalSupply) || 0;
  const roundedCirculating = round(Math.min(circulating, totalSupply), 2);

  return {
    totalSupply,
    circulatingSupply: roundedCirculating,
    lockedSupply: round(Math.max(0, totalSupply - roundedCirculating), 2),
    circulatingPercent: totalSupply
      ? round((roundedCirculating / totalSupply) * 100, 2)
      : 0,
    allocations: breakdown,
  };
}

/**
 * Project the supply curve from now (or TGE) over `months`, sampling every
 * `intervalDays` days.  Returns an array of timeline points.
 */
export function projectSupply(config, options = {}) {
  const months = Math.max(1, Number(options.months) || 12);
  const intervalDays = Math.max(1, Number(options.intervalDays) || 30);
  const from = options.from ? toDate(options.from) : toDate(config.tgeDate ?? DEFAULT_TGE_DATE);
  const end = addMonths(from, months);
  const totalSteps = Math.ceil((end.getTime() - from.getTime()) / (intervalDays * MS_PER_DAY));

  const points = [];
  for (let step = 0; step <= totalSteps; step++) {
    const date = new Date(from.getTime() + step * intervalDays * MS_PER_DAY);
    if (date.getTime() > end.getTime()) break;
    const supply = circulatingSupplyAt(config, date);
    points.push({
      date: date.toISOString(),
      totalSupply: supply.totalSupply,
      circulatingSupply: supply.circulatingSupply,
      lockedSupply: supply.lockedSupply,
      circulatingPercent: supply.circulatingPercent,
    });
  }

  const final = points[points.length - 1] ?? circulatingSupplyAt(config, from);
  return {
    horizonMonths: months,
    intervalDays,
    from: from.toISOString(),
    to: end.toISOString(),
    startCirculating: points[0]?.circulatingSupply ?? 0,
    endCirculating: final.circulatingSupply ?? 0,
    totalSupply: Number(config.totalSupply) || 0,
    points,
  };
}

/**
 * Calculate the dilution impact between `asOf` and `asOf + horizonMonths`.
 *
 * `dilutionPercent` is the classic measure: how much the future circulating
 * supply has grown relative to the future total, i.e. the share that existing
 * holders are diluted by.  `supplyGrowthPercent` is the raw growth of
 * circulating supply over the horizon.
 */
export function calculateDilution(config, options = {}) {
  const horizonMonths = Math.max(0, Number(options.horizonMonths) || 12);
  const asOf = options.asOf ? toDate(options.asOf) : new Date();
  const futureDate = addMonths(asOf, horizonMonths);

  const now = circulatingSupplyAt(config, asOf);
  const future = circulatingSupplyAt(config, futureDate);

  const newlyUnlocked = round(
    Math.max(0, future.circulatingSupply - now.circulatingSupply),
    2,
  );
  const supplyGrowthPercent = now.circulatingSupply
    ? round((newlyUnlocked / now.circulatingSupply) * 100, 2)
    : 0;
  const dilutionPercent = future.circulatingSupply
    ? round((newlyUnlocked / future.circulatingSupply) * 100, 2)
    : 0;

  return {
    asOf: asOf.toISOString(),
    horizonMonths,
    futureDate: futureDate.toISOString(),
    currentCirculatingSupply: now.circulatingSupply,
    futureCirculatingSupply: future.circulatingSupply,
    newlyUnlocked,
    supplyGrowthPercent,
    dilutionPercent,
    currentCirculatingPercent: now.circulatingPercent,
    futureCirculatingPercent: future.circulatingPercent,
  };
}

/** Identify discrete unlock events (by month) where circulating supply jumps. */
export function getUnlockEvents(config, options = {}) {
  const horizonMonths = Math.max(1, Number(options.horizonMonths) || 48);
  const from = options.from ? toDate(options.from) : toDate(config.tgeDate ?? DEFAULT_TGE_DATE);

  const events = [];
  let previous = circulatingSupplyAt(config, from).circulatingSupply;

  for (let month = 1; month <= horizonMonths; month++) {
    const date = addMonths(from, month);
    const supply = circulatingSupplyAt(config, date);
    const delta = round(supply.circulatingSupply - previous, 2);
    if (delta > 0) {
      events.push({
        date: date.toISOString(),
        month,
        unlockedAmount: delta,
        circulatingSupply: supply.circulatingSupply,
        circulatingPercent: supply.circulatingPercent,
      });
    }
    previous = supply.circulatingSupply;
  }

  return events;
}

/**
 * Simulate a distribution strategy.
 *
 * `scenario` is a partial config (allocations / tgeDate / totalSupply) layered
 * over `baseConfig`.  Returns the projected supply and dilution for both the
 * base and the scenario plus a comparison so the UI can show "what-if"
 * outcomes side by side.
 */
export function simulateDistribution(baseConfig, scenario = {}, options = {}) {
  const base = normalizeConfig(baseConfig);
  const combined = {
    ...base,
    ...scenario,
    allocations: scenario.allocations ?? base.allocations,
  };
  const simulated = normalizeConfig(combined);

  const months = Math.max(1, Number(options.months) || 36);
  const intervalDays = Math.max(1, Number(options.intervalDays) || 30);
  const asOf = options.asOf ? toDate(options.asOf) : toDate(base.tgeDate);

  const baseProjection = projectSupply(base, { months, intervalDays, from: asOf });
  const scenarioProjection = projectSupply(simulated, {
    months,
    intervalDays,
    from: asOf,
  });
  const baseDilution = calculateDilution(base, { asOf, horizonMonths: months });
  const scenarioDilution = calculateDilution(simulated, {
    asOf,
    horizonMonths: months,
  });

  return {
    asOf: asOf.toISOString(),
    horizonMonths: months,
    intervalDays,
    base: {
      config: base,
      projection: baseProjection,
      dilution: baseDilution,
    },
    scenario: {
      config: simulated,
      projection: scenarioProjection,
      dilution: scenarioDilution,
    },
    comparison: {
      circulatingSupplyDelta: round(
        scenarioProjection.endCirculating - baseProjection.endCirculating,
        2,
      ),
      dilutionDelta: round(
        scenarioDilution.dilutionPercent - baseDilution.dilutionPercent,
        2,
      ),
      unlockDelta: round(
        scenarioDilution.newlyUnlocked - baseDilution.newlyUnlocked,
        2,
      ),
    },
  };
}

/**
 * Build the full token economics model used by the dashboard.
 */
export function buildTokenEconomicsModel(config = {}, options = {}) {
  const normalized = normalizeConfig(config);
  const asOf = options.asOf ? toDate(options.asOf) : new Date();
  const horizonMonths = Math.max(1, Number(options.horizonMonths) || 36);

  const current = circulatingSupplyAt(normalized, asOf);
  const projection = projectSupply(normalized, {
    months: horizonMonths,
    intervalDays: options.intervalDays,
    from: options.from ? toDate(options.from) : asOf,
  });
  const dilution = calculateDilution(normalized, { asOf, horizonMonths });
  const unlockEvents = getUnlockEvents(normalized, {
    horizonMonths,
    from: options.from ? toDate(options.from) : asOf,
  });

  return {
    tokenSymbol: normalized.tokenSymbol,
    totalSupply: normalized.totalSupply,
    tgeDate: normalized.tgeDate,
    asOf: asOf.toISOString(),
    current,
    projection,
    dilution,
    unlockEvents,
  };
}

/**
 * Validate and fill defaults for an economics config.
 * Throws when allocations are negative or exceed the total supply.
 */
export function normalizeConfig(input = {}) {
  const source = { ...DEFAULT_TOKEN_ECONOMICS, ...input };
  const totalSupply = Number(source.totalSupply);
  if (!Number.isFinite(totalSupply) || totalSupply <= 0) {
    throw new Error("totalSupply must be a positive number");
  }

  const allocations = (source.allocations ?? []).map((allocation, index) => {
    const amount = Number(allocation.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`allocation[${index}].amount must be a non-negative number`);
    }
    return {
      name: allocation.name ?? `Allocation ${index + 1}`,
      amount,
      tgePercent: clampPercent(allocation.tgePercent ?? 0),
      cliffMonths: Math.max(0, Number(allocation.cliffMonths) || 0),
      vestingMonths: Math.max(0, Number(allocation.vestingMonths) || 0),
    };
  });

  if (allocations.length === 0) {
    throw new Error("At least one allocation is required");
  }

  const allocated = allocations.reduce((sum, a) => sum + a.amount, 0);
  // Allow a tiny floating point tolerance.
  if (allocated - totalSupply > 1) {
    throw new Error(
      `Allocations (${allocated}) exceed total supply (${totalSupply})`,
    );
  }

  return {
    tokenSymbol: source.tokenSymbol ?? DEFAULT_TOKEN_ECONOMICS.tokenSymbol,
    totalSupply,
    tgeDate: toDate(source.tgeDate ?? DEFAULT_TGE_DATE).toISOString(),
    allocations,
  };
}

/** Build a CSV table for a supply projection timeline (RFC 4180). */
export function projectionToCsv(projection) {
  const header = "Date,Total Supply,Circulating Supply,Locked Supply,Circulating %";
  const rows = (projection.points ?? []).map((point) =>
    [
      point.date,
      point.totalSupply,
      point.circulatingSupply,
      point.lockedSupply,
      point.circulatingPercent,
    ].join(","),
  );
  return [header, ...rows].join("\r\n");
}

export default {
  DEFAULT_TOKEN_ECONOMICS,
  DEFAULT_TGE_DATE,
  addMonths,
  allocationUnlockPercent,
  circulatingSupplyAt,
  projectSupply,
  calculateDilution,
  getUnlockEvents,
  simulateDistribution,
  buildTokenEconomicsModel,
  normalizeConfig,
  projectionToCsv,
};
