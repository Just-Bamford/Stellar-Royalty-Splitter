/**
 * Request validation for the tokenomics routes (#1370).
 */

import { describe, it, expect } from "@jest/globals";
import request from "supertest";
import app from "./app.js";
import {
  MAX_ALLOCATIONS,
  MAX_SCHEDULES,
  validateTokenomicsConfig,
  validateTokenomicsOptions,
  validateVestingSchedule,
  validateVestingSchedules,
} from "../src/tokenomics-validation.js";

const TGE = "2025-01-01T00:00:00.000Z";

const CONFIG = {
  tokenSymbol: "SRS",
  totalSupply: 1000,
  tgeDate: TGE,
  allocations: [
    { name: "Team", amount: 1000, tgePercent: 10, cliffMonths: 6, vestingMonths: 12 },
  ],
};

const SCHEDULE = {
  label: "Team",
  beneficiary: "GABC",
  totalAmount: 1200,
  releasedAmount: 0,
  startDate: TGE,
  cliffMonths: 6,
  vestingMonths: 12,
};

const many = (n, item) => Array.from({ length: n }, () => ({ ...item }));

describe("validateVestingSchedules", () => {
  it("accepts up to the maximum number of valid schedules", () => {
    expect(validateVestingSchedules(many(MAX_SCHEDULES, SCHEDULE))).toBeNull();
  });

  it("rejects more than the maximum number of schedules", () => {
    expect(validateVestingSchedules(many(MAX_SCHEDULES + 1, SCHEDULE))).toMatch(/at most 100/);
  });

  it("rejects a non-array", () => {
    expect(validateVestingSchedules("nope")).toBe("schedules must be an array");
  });

  it("names the index of the offending schedule", () => {
    const schedules = [SCHEDULE, { ...SCHEDULE, totalAmount: -5 }];
    expect(validateVestingSchedules(schedules)).toMatch(/^schedules\[1\]\.totalAmount/);
  });
});

describe("validateVestingSchedule", () => {
  it("accepts a complete schedule", () => {
    expect(validateVestingSchedule(SCHEDULE)).toBeNull();
  });

  it.each([
    ["beneficiary", { ...SCHEDULE, beneficiary: undefined }, /beneficiary is required/],
    ["totalAmount", { ...SCHEDULE, totalAmount: undefined }, /totalAmount is required/],
    ["a non-positive totalAmount", { ...SCHEDULE, totalAmount: 0 }, /totalAmount must be greater than 0/],
    ["a non-numeric totalAmount", { ...SCHEDULE, totalAmount: "lots" }, /totalAmount must be a number/],
    ["a negative cliffMonths", { ...SCHEDULE, cliffMonths: -1 }, /cliffMonths must be at least 0/],
    ["an absurd vestingMonths", { ...SCHEDULE, vestingMonths: 999999 }, /vestingMonths must be at most/],
    ["a bad startDate", { ...SCHEDULE, startDate: "not a date" }, /startDate must be a valid date/],
    ["an unexpected key", { ...SCHEDULE, nested: { deep: true } }, /unexpected keys: nested/],
    ["a non-object", "schedule", /must be an object/],
  ])("rejects %s", (_name, schedule, message) => {
    expect(validateVestingSchedule(schedule)).toMatch(message);
  });

  it("treats overrides as partial: every field optional, types still checked", () => {
    expect(validateVestingSchedule({}, "overrides", { partial: true })).toBeNull();
    expect(validateVestingSchedule(undefined, "overrides", { partial: true })).toBeNull();
    expect(validateVestingSchedule({ cliffMonths: 0 }, "overrides", { partial: true })).toBeNull();
    expect(validateVestingSchedule({ cliffMonths: -3 }, "overrides", { partial: true })).toMatch(
      /overrides\.cliffMonths/,
    );
  });
});

describe("validateTokenomicsConfig", () => {
  it("accepts a valid config and treats missing/null as defaults", () => {
    expect(validateTokenomicsConfig(CONFIG)).toBeNull();
    expect(validateTokenomicsConfig(undefined)).toBeNull();
    expect(validateTokenomicsConfig(null)).toBeNull();
    expect(validateTokenomicsConfig({})).toBeNull();
  });

  it("rejects keys that are not part of the config", () => {
    expect(validateTokenomicsConfig({ ...CONFIG, admin: true })).toMatch(/unexpected keys: admin/);
  });

  it("rejects a JSON-supplied __proto__ key", () => {
    const polluted = JSON.parse('{"__proto__": {"polluted": true}, "totalSupply": 10}');
    expect(validateTokenomicsConfig(polluted)).toMatch(/unexpected keys: __proto__/);
  });

  it("rejects unexpected keys inside an allocation", () => {
    const config = { ...CONFIG, allocations: [{ ...CONFIG.allocations[0], extra: 1 }] };
    expect(validateTokenomicsConfig(config)).toMatch(/allocations\[0\] contains unexpected keys: extra/);
  });

  it.each([
    ["a non-object config", [], /config must be an object/],
    ["a non-positive totalSupply", { totalSupply: 0 }, /totalSupply must be greater than 0/],
    ["an overlong tokenSymbol", { tokenSymbol: "X".repeat(40) }, /tokenSymbol must be at most/],
    ["a bad tgeDate", { tgeDate: "yesterday-ish" }, /tgeDate must be a valid date/],
    ["non-array allocations", { allocations: {} }, /allocations must be an array/],
    ["a non-object allocation", { allocations: ["x"] }, /allocations\[0\] must be an object/],
    ["a missing allocation amount", { allocations: [{ name: "A" }] }, /amount is required/],
    ["a tgePercent over 100", { allocations: [{ amount: 1, tgePercent: 150 }] }, /tgePercent must be at most 100/],
  ])("rejects %s", (_name, config, message) => {
    expect(validateTokenomicsConfig(config)).toMatch(message);
  });

  it("caps the number of allocations", () => {
    const allocations = many(MAX_ALLOCATIONS + 1, { name: "A", amount: 1 });
    expect(validateTokenomicsConfig({ allocations })).toMatch(/at most 50/);
  });
});

describe("validateTokenomicsOptions", () => {
  it("accepts missing options, valid values and unknown extras", () => {
    expect(validateTokenomicsOptions(undefined)).toBeNull();
    expect(validateTokenomicsOptions({ horizonMonths: 24, intervalDays: 30, asOf: TGE })).toBeNull();
    expect(validateTokenomicsOptions({ horizonMonths: "24", intervalDays: "30" })).toBeNull();
    expect(validateTokenomicsOptions({ months: 36, from: TGE })).toBeNull();
  });

  it.each([
    [{ horizonMonths: 0 }, /horizonMonths must be at least 1/],
    [{ horizonMonths: -6 }, /horizonMonths must be at least 1/],
    [{ horizonMonths: 1.5 }, /horizonMonths must be an integer/],
    [{ horizonMonths: "abc" }, /horizonMonths must be a number/],
    [{ horizonMonths: "" }, /horizonMonths must be a number/],
    [{ horizonMonths: null }, /horizonMonths must be a number/],
    [{ horizonMonths: 100000 }, /horizonMonths must be at most/],
    [{ intervalDays: 0 }, /intervalDays must be at least 1/],
    [{ intervalDays: 2.5 }, /intervalDays must be an integer/],
    [{ asOf: "not-a-date" }, /asOf must be a valid date/],
    [[], /options must be an object/],
  ])("rejects %j", (options, message) => {
    expect(validateTokenomicsOptions(options)).toMatch(message);
  });

  it("rejects a horizon/interval pair that would produce too many points", () => {
    expect(validateTokenomicsOptions({ horizonMonths: 600, intervalDays: 1 })).toMatch(
      /more than 5000 projection points/,
    );
  });
});

describe("tokenomics routes enforce validation (#1370)", () => {
  const post = (path, body) => request(app).post(`/api/v1/tokenomics${path}`).send(body);

  it("POST /vesting with more than 100 schedules returns 400", async () => {
    const res = await post("/vesting", { schedules: many(MAX_SCHEDULES + 1, SCHEDULE) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
    expect(res.body.message ?? JSON.stringify(res.body)).toMatch(/at most 100/);
  });

  it("POST /vesting with exactly 100 schedules still succeeds", async () => {
    const res = await post("/vesting", {
      schedules: many(MAX_SCHEDULES, SCHEDULE),
      options: { asOf: "2026-01-01T00:00:00.000Z" },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.scheduleCount).toBe(MAX_SCHEDULES);
  });

  it("POST /vesting rejects a schedule missing required fields", async () => {
    const res = await post("/vesting", { schedules: [{ label: "x" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
  });

  it("POST /vesting rejects a non-integer horizonMonths", async () => {
    const res = await post("/vesting", { schedules: [SCHEDULE], options: { horizonMonths: 1.5 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
  });

  it("POST /model rejects a config with unexpected keys", async () => {
    const res = await post("/model", { config: { ...CONFIG, constructor: { prototype: {} } } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
  });

  it("POST /model rejects a negative intervalDays", async () => {
    const res = await post("/model", { config: CONFIG, options: { intervalDays: -1 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
  });

  it("POST /simulate validates the scenario too", async () => {
    const res = await post("/simulate", { config: CONFIG, scenario: { totalSupply: "lots" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
  });

  it("POST /vesting/simulate validates the schedule and overrides", async () => {
    const badSchedule = await post("/vesting/simulate", { schedule: { ...SCHEDULE, totalAmount: -1 } });
    const badOverrides = await post("/vesting/simulate", {
      schedule: SCHEDULE,
      overrides: { cliffMonths: -2 },
    });

    expect(badSchedule.status).toBe(400);
    expect(badOverrides.status).toBe(400);
  });

  it("POST /export/supply validates the config", async () => {
    const res = await post("/export/supply", { config: { allocations: "x" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
  });

  it("valid requests are unaffected", async () => {
    const res = await post("/model", {
      config: CONFIG,
      options: { asOf: TGE, horizonMonths: 24, intervalDays: 30 },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
