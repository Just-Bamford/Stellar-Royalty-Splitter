const workflowStore = globalThis.__automationWorkflowStore ??= {
  workflows: new Map(),
  sequence: 1,
};

export const WORKFLOW_TRIGGER_TYPES = [
  "earningsThreshold",
  "unresolvedDispute",
  "inactiveCollaborator",
  "fieldComparison",
];

export const WORKFLOW_ACTION_TYPES = ["distribution", "escalation", "notification"];

function normalizedId(prefix = "workflow") {
  return `${prefix}_${workflowStore.sequence++}_${Date.now().toString(36)}`;
}

function parseDate(value, fallback = new Date()) {
  const date = new Date(value ?? fallback);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${value}`);
  }
  return date;
}

function safeNumber(value, fallback = 0) {
  const num = Number(value ?? fallback);
  return Number.isFinite(num) ? num : fallback;
}

function getFieldValue(source, field) {
  if (!source || !field) {
    return undefined;
  }
  const path = String(field).split(".");
  let value = source;
  for (const segment of path) {
    if (value == null || typeof value !== "object") {
      return undefined;
    }
    value = value[segment];
  }
  return value;
}

function compareValues(actual, operator, expected) {
  switch (operator) {
    case "gt":
    case ">":
      return safeNumber(actual) > safeNumber(expected);
    case "gte":
    case ">=":
      return safeNumber(actual) >= safeNumber(expected);
    case "lt":
    case "<":
      return safeNumber(actual) < safeNumber(expected);
    case "lte":
    case "<=":
      return safeNumber(actual) <= safeNumber(expected);
    case "eq":
    case "==":
      return actual == expected;
    case "ne":
    case "!=":
      return actual != expected;
    case "in":
      return Array.isArray(expected) ? expected.includes(actual) : false;
    default:
      return false;
  }
}

function evaluateGenericTrigger(trigger, context = {}) {
  const field = trigger.field ?? trigger.path ?? trigger.key;
  const actual = getFieldValue(context, field);
  const operator = trigger.operator ?? trigger.comparator ?? "gt";
  const expected = trigger.value ?? trigger.threshold ?? trigger.expected;
  return compareValues(actual, operator, expected);
}

export function evaluateTrigger(trigger, context = {}) {
  if (!trigger || typeof trigger !== "object") {
    throw new Error("Workflow trigger is required");
  }

  const triggerType = String(trigger.type ?? "fieldComparison").trim();

  if (triggerType === "earningsThreshold") {
    const threshold = safeNumber(trigger.threshold ?? trigger.value ?? 0);
    const earnings = safeNumber(context.earnings ?? context.totalEarnings ?? 0);
    return earnings > threshold;
  }

  if (triggerType === "unresolvedDispute") {
    const dispute = context.dispute ?? {};
    const days = safeNumber(trigger.days ?? 30, 30);
    const createdAt = parseDate(dispute.createdAt ?? context.createdAt ?? new Date(), context.now ?? new Date());
    const now = parseDate(context.now ?? new Date(), new Date());
    return dispute.resolved === false && (now.getTime() - createdAt.getTime()) / 86400000 >= days;
  }

  if (triggerType === "inactiveCollaborator") {
    const collaborator = context.collaborator ?? {};
    const days = safeNumber(trigger.days ?? 90, 90);
    const lastActiveAt = parseDate(collaborator.lastActiveAt ?? context.lastActiveAt ?? new Date(), context.now ?? new Date());
    const now = parseDate(context.now ?? new Date(), new Date());
    return (now.getTime() - lastActiveAt.getTime()) / 86400000 > days;
  }

  return evaluateGenericTrigger(trigger, context);
}

export function validateWorkflowDefinition(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Workflow definition is required");
  }

  const name = String(input.name ?? "").trim();
  if (!name) {
    throw new Error("Workflow name is required");
  }

  if (!input.trigger || typeof input.trigger !== "object") {
    throw new Error("Workflow trigger is required");
  }

  const actions = Array.isArray(input.actions) ? input.actions : [input.actions].filter(Boolean);
  if (actions.length === 0) {
    throw new Error("At least one action is required");
  }

  const normalized = {
    ...input,
    id: input.id ?? normalizedId("workflow"),
    name,
    enabled: input.enabled !== false,
    recurring: !!input.recurring,
    trigger: { ...input.trigger },
    actions: actions.map((action) => {
      if (!action || typeof action !== "object") {
        throw new Error("Each action must be an object");
      }
      const type = String(action.type ?? "notification").trim().toLowerCase();
      if (!WORKFLOW_ACTION_TYPES.includes(type)) {
        throw new Error(`Invalid workflow action type: ${type}`);
      }
      return { ...action, type };
    }),
    executionHistory: Array.isArray(input.executionHistory) ? input.executionHistory : [],
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };

  workflowStore.workflows.set(normalized.id, normalized);
  return normalized;
}

export function evaluateWorkflow(workflow, context = {}) {
  const normalized = validateWorkflowDefinition(workflow);
  const matched = evaluateTrigger(normalized.trigger, context);
  return {
    workflowId: normalized.id,
    workflowName: normalized.name,
    trigger: normalized.trigger,
    matched,
    reason: matched ? "condition_met" : "condition_not_met",
  };
}

async function executeWorkflowAction(action, context = {}) {
  const payload = { action: action.type, name: action.name ?? action.type, success: true, message: "action_completed" };

  try {
    if (action.type === "distribution") {
      if (context.distributionService) {
        const result = await context.distributionService({ ...context, action });
        payload.message = result?.message ?? payload.message;
        payload.output = result;
        return payload;
      }
      payload.message = "distribution action simulated";
      return payload;
    }

    if (action.type === "escalation") {
      if (context.escalationService) {
        const result = await context.escalationService({ ...context, action });
        payload.message = result?.message ?? payload.message;
        payload.output = result;
        return payload;
      }
      payload.message = "escalation queued";
      return payload;
    }

    if (context.notificationService) {
      const result = await context.notificationService({ ...context, action });
      payload.message = result?.message ?? payload.message;
      payload.output = result;
      return payload;
    }

    payload.message = "notification queued";
    return payload;
  } catch (error) {
    return {
      action: action.type,
      name: action.name ?? action.type,
      success: false,
      message: "action_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runWorkflow(workflow, context = {}) {
  const normalized = validateWorkflowDefinition(workflow);
  if (!normalized.enabled) {
    return {
      id: normalized.id,
      status: "skipped",
      skipped: true,
      reason: "disabled",
      history: [...normalized.executionHistory],
    };
  }

  const evaluation = evaluateWorkflow(normalized, context);
  if (!evaluation.matched) {
    return {
      id: normalized.id,
      status: "not_triggered",
      skipped: true,
      reason: "condition_not_met",
      history: [...normalized.executionHistory],
    };
  }

  const eventKey = context.eventKey ?? `${normalized.id}:${Date.now().toString(36)}`;
  const lastExecution = normalized.executionHistory.find((entry) => entry.eventKey === eventKey);
  if (!normalized.recurring && lastExecution) {
    return {
      id: normalized.id,
      status: "duplicate",
      duplicate: true,
      reason: "already_executed_for_event",
      history: [...normalized.executionHistory],
    };
  }

  const startedAt = new Date();
  const actionResults = [];
  let failure = null;

  for (const action of normalized.actions) {
    const outcome = await executeWorkflowAction(action, context);
    actionResults.push(outcome);
    if (!outcome.success) {
      failure = outcome.error ?? "Action failed";
    }
  }

  const completedAt = new Date();
  const status = failure ? "failed" : "success";
  const execution = {
    id: normalizedId("workflow-execution"),
    workflowId: normalized.id,
    name: normalized.name,
    type: normalized.trigger.type,
    status,
    scheduledAt: context.scheduledAt ?? context.now ?? startedAt.toISOString(),
    triggeredAt: (context.now ?? startedAt).toISOString ? (context.now ?? startedAt).toISOString() : startedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    success: status === "success",
    failure,
    eventKey,
    metadata: { ...context.metadata, actionResults },
    results: actionResults,
  };

  normalized.executionHistory.unshift(execution);
  normalized.updatedAt = completedAt.toISOString();
  workflowStore.workflows.set(normalized.id, normalized);

  return {
    id: normalized.id,
    status,
    matched: true,
    history: [...normalized.executionHistory],
    execution,
    actionResults,
  };
}

export function createWorkflow(definition) {
  const normalized = validateWorkflowDefinition(definition);
  return {
    ...normalized,
    engine: {
      runWorkflow: (...args) => {
        const first = args[0];
        const second = args[1] ?? {};
        const workflowArg = first && typeof first === "object" && ("trigger" in first || "actions" in first || "name" in first) ? first : normalized;
        const contextArg = workflowArg === first && typeof first === "object" && ("trigger" in first || "actions" in first || "name" in first) ? second : first ?? {};
        return runWorkflow(workflowArg, contextArg);
      },
      evaluate: (...args) => {
        const first = args[0];
        const second = args[1] ?? {};
        const workflowArg = first && typeof first === "object" && ("trigger" in first || "actions" in first || "name" in first) ? first : normalized;
        const contextArg = workflowArg === first && typeof first === "object" && ("trigger" in first || "actions" in first || "name" in first) ? second : first ?? {};
        return evaluateWorkflow(workflowArg, contextArg);
      },
    },
  };
}

export function listWorkflows() {
  return [...workflowStore.workflows.values()].map((workflow) => ({
    ...workflow,
    executionHistory: [...workflow.executionHistory],
  }));
}

export function getWorkflowById(id) {
  const workflow = workflowStore.workflows.get(String(id));
  if (!workflow) {
    return null;
  }
  return { ...workflow, executionHistory: [...workflow.executionHistory] };
}

export function updateWorkflow(id, updates) {
  const workflow = workflowStore.workflows.get(String(id));
  if (!workflow) {
    throw new Error(`Workflow ${id} not found`);
  }

  const merged = { ...workflow, ...updates, trigger: { ...workflow.trigger, ...(updates.trigger ?? {}) }, executionHistory: [...workflow.executionHistory] };
  const normalized = validateWorkflowDefinition(merged);
  normalized.updatedAt = new Date().toISOString();
  workflowStore.workflows.set(String(id), normalized);
  return { ...normalized, executionHistory: [...normalized.executionHistory] };
}

export function deleteWorkflow(id) {
  const removed = workflowStore.workflows.get(String(id));
  workflowStore.workflows.delete(String(id));
  return !!removed;
}

export function resetWorkflowState() {
  workflowStore.workflows.clear();
  workflowStore.sequence = 1;
}
