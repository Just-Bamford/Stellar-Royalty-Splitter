import { Router } from "express";
import { requireRole } from "../middleware/rbac.js";
import { sendError } from "../error-response.js";
import { addAuditLog } from "../database/audit.js";
import { applyOperationToDocument, listCollaborators, readDocument } from "../services/collaboration.js";
import { broadcastCollaborationUpdate } from "../websocket.js";

export const collaborationRouter = Router();

collaborationRouter.get("/:contractId", requireRole("viewer"), (req, res) => {
  res.json({ success: true, data: { ...readDocument(req.params.contractId), collaborators: listCollaborators(req.params.contractId) } });
});

collaborationRouter.post("/:contractId/operations", requireRole("collaborator"), (req, res) => {
  try {
    const { baseRevision, operation, actor } = req.body ?? {};
    const result = applyOperationToDocument(req.params.contractId, operation, actor ?? req.ip, baseRevision);
    addAuditLog(req.params.contractId, "collaboration_change_applied", actor ?? req.ip, {
      revision: result.revision,
      rebased: result.change.rebased,
      operation,
    });
    broadcastCollaborationUpdate(req.params.contractId, result);
    res.json({ success: true, data: result });
  } catch (error) {
    sendError(res, 409, "collaboration_conflict", error.message);
  }
});
