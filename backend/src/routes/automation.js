import { Router } from "express";
import {
  createSchedule,
  deleteSchedule,
  executeSchedule,
  getExecutionHistory,
  getScheduleById,
  listSchedules,
  setScheduleEnabled,
  updateSchedule,
  validateSchedule,
} from "../services/scheduler.js";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflowById,
  listWorkflows,
  runWorkflow,
  updateWorkflow,
  validateWorkflowDefinition,
} from "../services/workflow-engine.js";
import { sendError } from "../error-response.js";
import { requireAdminBearerOrRole, requireRole } from "../middleware/rbac.js";

export const automationRouter = Router();

const requireViewer = requireRole("viewer");
const requireOperator = requireAdminBearerOrRole("operator");

automationRouter.get("/status", requireViewer, (req, res) => {
  res.json({
    success: true,
    data: {
      schedules: listSchedules(),
      workflows: listWorkflows(),
    },
  });
});

automationRouter.get("/schedules", requireViewer, (req, res) => {
  res.json({ success: true, data: listSchedules() });
});

automationRouter.post("/schedules", requireOperator, (req, res) => {
  try {
    const schedule = createSchedule(req.body);
    res.status(201).json({ success: true, data: schedule });
  } catch (err) {
    sendError(res, 400, "schedule_validation_error", err instanceof Error ? err.message : "Invalid schedule");
  }
});

automationRouter.patch("/schedules/:id", requireOperator, (req, res) => {
  try {
    const id = String(req.params.id);
    const existing = getScheduleById(id);
    if (!existing) {
      return sendError(res, 404, "schedule_not_found", `Schedule ${id} not found`);
    }
    const merged = { ...existing, ...req.body };
    validateSchedule(merged);
    const updated = updateSchedule(id, req.body);
    res.json({ success: true, data: updated });
  } catch (err) {
    sendError(res, 400, "schedule_update_error", err instanceof Error ? err.message : "Invalid schedule update");
  }
});

automationRouter.patch("/schedules/:id/enable", requireOperator, (req, res) => {
  try {
    const id = String(req.params.id);
    const schedule = setScheduleEnabled(id, true);
    res.json({ success: true, data: schedule });
  } catch (err) {
    sendError(res, 400, "schedule_enable_error", err instanceof Error ? err.message : "Unable to enable schedule");
  }
});

automationRouter.patch("/schedules/:id/disable", requireOperator, (req, res) => {
  try {
    const id = String(req.params.id);
    const schedule = setScheduleEnabled(id, false);
    res.json({ success: true, data: schedule });
  } catch (err) {
    sendError(res, 400, "schedule_disable_error", err instanceof Error ? err.message : "Unable to disable schedule");
  }
});

automationRouter.delete("/schedules/:id", requireOperator, (req, res) => {
  try {
    const id = String(req.params.id);
    const removed = deleteSchedule(id);
    res.json({ success: true, removed });
  } catch (err) {
    sendError(res, 400, "schedule_delete_error", err instanceof Error ? err.message : "Unable to delete schedule");
  }
});

automationRouter.get("/schedules/:id/history", requireViewer, (req, res) => {
  try {
    const history = getExecutionHistory(String(req.params.id));
    res.json({ success: true, data: history });
  } catch (err) {
    sendError(res, 404, "schedule_history_error", err instanceof Error ? err.message : "Unable to fetch history");
  }
});

automationRouter.post("/schedules/:id/execute", requireOperator, async (req, res) => {
  try {
    const now = req.body?.now ? new Date(req.body.now) : new Date();
    const result = await executeSchedule(String(req.params.id), now, { metadata: req.body?.metadata ?? {} });
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, 500, "schedule_execution_error", err instanceof Error ? err.message : "Unable to execute schedule");
  }
});

automationRouter.get("/workflows", requireViewer, (req, res) => {
  res.json({ success: true, data: listWorkflows() });
});

automationRouter.post("/workflows", requireOperator, async (req, res) => {
  try {
    const workflow = createWorkflow(req.body);
    res.status(201).json({ success: true, data: workflow });
  } catch (err) {
    sendError(res, 400, "workflow_validation_error", err instanceof Error ? err.message : "Invalid workflow");
  }
});

automationRouter.patch("/workflows/:id", requireOperator, (req, res) => {
  try {
    const existing = getWorkflowById(String(req.params.id));
    if (!existing) {
      return sendError(res, 404, "workflow_not_found", `Workflow ${req.params.id} not found`);
    }
    validateWorkflowDefinition({ ...existing, ...req.body, trigger: { ...existing.trigger, ...(req.body.trigger ?? {}) } });
    const updated = updateWorkflow(String(req.params.id), req.body);
    res.json({ success: true, data: updated });
  } catch (err) {
    sendError(res, 400, "workflow_update_error", err instanceof Error ? err.message : "Invalid workflow update");
  }
});

automationRouter.delete("/workflows/:id", requireOperator, (req, res) => {
  try {
    const removed = deleteWorkflow(String(req.params.id));
    res.json({ success: true, removed });
  } catch (err) {
    sendError(res, 400, "workflow_delete_error", err instanceof Error ? err.message : "Unable to delete workflow");
  }
});

automationRouter.get("/workflows/:id", requireViewer, (req, res) => {
  const workflow = getWorkflowById(String(req.params.id));
  if (!workflow) {
    return sendError(res, 404, "workflow_not_found", `Workflow ${req.params.id} not found`);
  }
  res.json({ success: true, data: workflow });
});

automationRouter.post("/workflows/:id/run", requireOperator, async (req, res) => {
  try {
    const workflow = getWorkflowById(String(req.params.id));
    if (!workflow) {
      return sendError(res, 404, "workflow_not_found", `Workflow ${req.params.id} not found`);
    }
    const result = await runWorkflow(workflow, req.body ?? {});
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, 500, "workflow_execution_error", err instanceof Error ? err.message : "Unable to execute workflow");
  }
});

automationRouter.get("/workflows/:id/history", requireViewer, (req, res) => {
  const workflow = getWorkflowById(String(req.params.id));
  if (!workflow) {
    return sendError(res, 404, "workflow_not_found", `Workflow ${req.params.id} not found`);
  }
  res.json({ success: true, data: workflow.executionHistory ?? [] });
});
