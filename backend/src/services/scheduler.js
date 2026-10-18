const schedulerStore = globalThis.__automationSchedulerStore ??= {
  schedules: new Map(),
  sequence: 1,
};

export const SCHEDULE_TYPES = ["one-time", "weekly", "monthly", "custom", "cron"];

function normalizedId(prefix = "schedule") {
  return `${prefix}_${schedulerStore.sequence++}_${Date.now().toString(36)}`;
}

function parseTime(value, fallbackHour = 0, fallbackMinute = 0) {
  if (typeof value === "string") {
    const match = value.trim().match(/^([01]?\d|2[0-3]):([0-5]?\d)$/);
    if (!match) {
      throw new Error(`Invalid time value: "${value}". Use HH:MM in UTC.`);
    }
    return {
      hour: Number(match[1]),
      minute: Number(match[2]),
    };
  }

  if (typeof value === "number") {
    return { hour: Math.max(0, Math.min(23, Math.floor(value))), minute: fallbackMinute };
  }

  if (value && typeof value === "object") {
    return {
      hour: Number(value.hour ?? fallbackHour),
      minute: Number(value.minute ?? fallbackMinute),
    };
  }

  return { hour: fallbackHour, minute: fallbackMinute };
}

function safeIso(value, fallback = new Date()) {
  const date = new Date(value ?? fallback);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid timestamp value");
  }
  return date.toISOString();
}

function parseCronPart(part, min, max) {
  const values = new Set();
  const groups = Part => Part.split(",").map((entry) => entry.trim()).filter(Boolean);

  for (const item of groups(part)) {
    if (item === "*") {
      for (let i = min; i <= max; i += 1) values.add(i);
      continue;
    }

    if (item.includes("/")) {
      const [base, stepStr] = item.split("/");
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`Invalid cron step value in "${item}"`);
      }
      const baseValues = base === "*" ? Array.from({ length: max - min + 1 }, (_, idx) => idx + min) : parseCronRange(base, min, max);
      for (const value of baseValues) {
        if ((value - min) % step === 0) values.add(value);
      }
      continue;
    }

    if (item.includes("-")) {
      for (const value of parseCronRange(item, min, max)) values.add(value);
      continue;
    }

    const value = Number(item);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Unsupported cron value: "${item}"`);
    }
    values.add(value);
  }

  return values;
}

function parseCronRange(item, min, max) {
  const [startText, endText] = item.split("-");
  const start = Number(startText);
  const end = Number(endText);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || end < start) {
    throw new Error(`Invalid cron range: "${item}"`);
  }
  const values = [];
  for (let value = start; value <= end; value += 1) values.push(value);
  return values;
}

function parseCronExpression(cron) {
  const expr = String(cron ?? "").trim();
  if (!expr) throw new Error("cron expression is required");
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron expressions must contain 5 fields: minute hour day-of-month month day-of-week");
  }

  const [minutePart, hourPart, dayOfMonthPart, monthPart, dayOfWeekPart] = parts;

  return {
    minute: parseCronPart(minutePart, 0, 59),
    hour: parseCronPart(hourPart, 0, 23),
    dayOfMonth: parseCronPart(dayOfMonthPart, 1, 31),
    month: parseCronPart(monthPart, 1, 12),
    dayOfWeek: parseCronPart(dayOfWeekPart, 0, 6),
  };
}

export function cronMatches(cron, date = new Date()) {
  const candidate = new Date(date);
  const parsed = parseCronExpression(cron);
  const minute = candidate.getUTCMinutes();
  const hour = candidate.getUTCHours();
  const dayOfMonth = candidate.getUTCDate();
  const month = candidate.getUTCMonth() + 1;
  const dayOfWeek = candidate.getUTCDay();

  return (
    parsed.minute.has(minute) &&
    parsed.hour.has(hour) &&
    parsed.dayOfMonth.has(dayOfMonth) &&
    parsed.month.has(month) &&
    parsed.dayOfWeek.has(dayOfWeek)
  );
}

export function nextCronOccurrence(from = new Date(), cron) {
  const start = new Date(from);
  const limit = new Date(start);
  limit.setUTCFullYear(start.getUTCFullYear() + 5);

  let candidate = new Date(start);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  while (candidate <= limit) {
    if (cronMatches(cron, candidate)) {
      return candidate.toISOString();
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error("Unable to determine next cron occurrence within 5 years");
}

function buildScheduleRecord(schedule) {
  const normalized = validateSchedule(schedule);
  const id = normalized.id ?? String(normalizedId("schedule"));

  const record = {
    id,
    name: normalized.name,
    type: normalized.type,
    enabled: normalized.enabled,
    cron: normalized.cron ?? null,
    dayOfWeek: normalized.dayOfWeek ?? null,
    dayOfMonth: normalized.dayOfMonth ?? null,
    time: normalized.time,
    runAt: normalized.runAt ?? null,
    nextRunAt: normalized.nextRunAt ?? null,
    createdAt: normalized.createdAt ?? new Date().toISOString(),
    updatedAt: normalized.updatedAt ?? new Date().toISOString(),
    /* Each history entry stores status, trigger metadata, and safe error details. */
    history: [],
    seenRuns: new Set(),
    metadata: normalized.metadata ?? {},
  };

  schedulerStore.schedules.set(id, record);
  return record;
}

function normalizeScheduleDefinition(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Schedule definition is required");
  }

  const type = String(input.type ?? "custom").trim().toLowerCase();
  if (!SCHEDULE_TYPES.includes(type)) {
    throw new Error(`Invalid schedule type: "${type}"`);
  }

  const name = String(input.name ?? "").trim();
  if (!name) {
    throw new Error("Schedule name is required");
  }

  const normalized = {
    ...input,
    id: input.id ?? null,
    name,
    type,
    enabled: input.enabled !== false,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };

  const timeValue = input.time ?? `${String(input.hour ?? 0).padStart(2, "0")}:${String(input.minute ?? 0).padStart(2, "0")}`;
  const { hour, minute } = parseTime(timeValue, input.hour ?? 0, input.minute ?? 0);
  normalized.time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  normalized.hour = hour;
  normalized.minute = minute;

  if (type === "one-time") {
    if (!input.runAt && !input.when) {
      throw new Error("runAt is required for one-time schedules");
    }
    normalized.runAt = safeIso(input.runAt ?? input.when);
    normalized.nextRunAt = normalized.runAt;
    return normalized;
  }

  if (type === "weekly") {
    const dayOfWeek = Number(input.dayOfWeek ?? input.day ?? 0);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw new Error("weekly schedules require a valid dayOfWeek from 0 to 6");
    }
    normalized.dayOfWeek = dayOfWeek;
    return normalized;
  }

  if (type === "monthly") {
    const dayOfMonth = Number(input.dayOfMonth ?? 1);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      throw new Error("monthly schedules require a valid dayOfMonth from 1 to 31");
    }
    normalized.dayOfMonth = dayOfMonth;
    return normalized;
  }

  if (type === "custom" || type === "cron") {
    const cron = input.cron ?? input.expression ?? input.schedule ?? input.rule;
    if (!cron) {
      throw new Error("A cron-like expression is required for custom schedules");
    }
    normalized.cron = String(cron).trim();
    parseCronExpression(normalized.cron);
    return normalized;
  }

  throw new Error(`Unsupported schedule type: ${type}`);
}

export function validateSchedule(input) {
  return normalizeScheduleDefinition(input);
}

export function getNextRun(schedule, now = new Date()) {
  const entry = normalizeScheduleDefinition(schedule);
  const reference = new Date(now);

  if (entry.type === "one-time") {
    return safeIso(entry.runAt || reference);
  }

  if (entry.type === "weekly") {
    const candidate = new Date(reference);
    candidate.setUTCSeconds(0, 0);
    candidate.setUTCHours(entry.hour, entry.minute, 0, 0);
    const targetDay = Number(entry.dayOfWeek || 0);
    const diffDays = (targetDay - candidate.getUTCDay() + 7) % 7;

    candidate.setUTCDate(candidate.getUTCDate() + diffDays);
    if (candidate <= reference) {
      candidate.setUTCDate(candidate.getUTCDate() + 7);
    }
    return candidate.toISOString();
  }

  if (entry.type === "monthly") {
    const candidate = new Date(reference);
    candidate.setUTCSeconds(0, 0);
    candidate.setUTCHours(entry.hour, entry.minute, 0, 0);
    const targetDay = Math.max(1, Math.min(31, Number(entry.dayOfMonth || 1)));
    candidate.setUTCDate(targetDay);
    if (candidate <= reference) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1);
      candidate.setUTCDate(targetDay);
    }
    return candidate.toISOString();
  }

  if (entry.type === "custom" || entry.type === "cron") {
    return nextCronOccurrence(reference, entry.cron);
  }

  throw new Error(`Unsupported schedule type: ${entry.type}`);
}

export function createSchedule(definition) {
  const record = buildScheduleRecord(definition);
  const nextRunAt = getNextRun(record, new Date());
  record.nextRunAt = nextRunAt;
  record.updatedAt = new Date().toISOString();
  schedulerStore.schedules.set(record.id, record);
  return { ...record, history: [...record.history], seenRuns: undefined };
}

export function listSchedules() {
  return [...schedulerStore.schedules.values()].map((schedule) => ({
    ...schedule,
    seenRuns: undefined,
    history: [...schedule.history],
  }));
}

export function getScheduleById(id) {
  const schedule = schedulerStore.schedules.get(String(id));
  if (!schedule) {
    return null;
  }
  return { ...schedule, history: [...schedule.history], seenRuns: undefined };
}

export function setScheduleEnabled(id, enabled) {
  const schedule = schedulerStore.schedules.get(String(id));
  if (!schedule) {
    throw new Error(`Schedule ${id} not found`);
  }

  schedule.enabled = !!enabled;
  schedule.updatedAt = new Date().toISOString();
  return { ...schedule, history: [...schedule.history], seenRuns: undefined };
}

export function updateSchedule(id, updates) {
  const schedule = schedulerStore.schedules.get(String(id));
  if (!schedule) {
    throw new Error(`Schedule ${id} not found`);
  }

  const merged = { ...schedule, ...updates };
  const normalized = validateSchedule(merged);
  const finalSchedule = {
    ...schedule,
    ...normalized,
    history: [...schedule.history],
    seenRuns: schedule.seenRuns,
    enabled: normalized.enabled,
    updatedAt: new Date().toISOString(),
  };

  finalSchedule.nextRunAt = getNextRun(finalSchedule, new Date());
  schedulerStore.schedules.set(String(id), finalSchedule);
  return { ...finalSchedule, history: [...finalSchedule.history], seenRuns: undefined };
}

export function deleteSchedule(id) {
  const removed = schedulerStore.schedules.get(String(id));
  schedulerStore.schedules.delete(String(id));
  return !!removed;
}

export function getExecutionHistory(id) {
  const schedule = schedulerStore.schedules.get(String(id));
  if (!schedule) {
    throw new Error(`Schedule ${id} not found`);
  }
  return [...schedule.history];
}

export function resetSchedulerState() {
  schedulerStore.schedules.clear();
  schedulerStore.sequence = 1;
}

async function defaultScheduleExecutor(context) {
  return {
    ok: true,
    message: "scheduled task completed",
    metadata: context.metadata ?? {},
  };
}

export async function executeSchedule(id, now = new Date(), options = {}) {
  const schedule = schedulerStore.schedules.get(String(id));
  if (!schedule) {
    throw new Error(`Schedule ${id} not found`);
  }

  if (!schedule.enabled) {
    return {
      id: schedule.id,
      status: "disabled",
      schedule: { ...schedule, history: [...schedule.history], seenRuns: undefined },
      history: [...schedule.history],
    };
  }

  const reference = new Date(now);
  const executionKey = options.executionKey ?? (schedule.nextRunAt ?? schedule.runAt ?? reference.toISOString());

  if (schedule.seenRuns.has(executionKey)) {
    return {
      id: schedule.id,
      status: "duplicate",
      schedule: { ...schedule, history: [...schedule.history], seenRuns: undefined },
      history: [...schedule.history],
      duplicate: true,
    };
  }

  const startedAt = new Date();
  let status = "success";
  let error = null;
  let result = null;

  try {
    const executor = options.execute ?? defaultScheduleExecutor;
    result = await executor({ schedule, now: reference, metadata: options.metadata ?? {}, executionKey });
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
  }

  schedule.seenRuns.add(executionKey);
  const completedAt = new Date();
  const historyEntry = {
    id: normalizedId("execution"),
    name: schedule.name,
    type: schedule.type,
    status,
    scheduledAt: schedule.nextRunAt ?? schedule.runAt ?? reference.toISOString(),
    triggeredAt: reference.toISOString(),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    success: status === "success",
    error,
    metadata: { ...options.metadata, ...(result && result.metadata ? result.metadata : {}) },
  };

  schedule.history.unshift(historyEntry);
  schedule.updatedAt = completedAt.toISOString();

  const nextRunAt = getNextRun(schedule, reference);
  schedule.nextRunAt = nextRunAt;

  return {
    id: schedule.id,
    status,
    schedule: { ...schedule, history: [...schedule.history], seenRuns: undefined },
    history: [...schedule.history],
    error,
    result,
  };
}

export function runDueSchedules(now = new Date(), options = {}) {
  return Promise.all(
    listSchedules()
      .filter((schedule) => schedule.enabled && schedule.nextRunAt && new Date(schedule.nextRunAt) <= new Date(now))
      .map((schedule) => executeSchedule(schedule.id, now, options)),
  );
}
