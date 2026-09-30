import { Router } from "express";
import { z } from "zod";
import { stellarAddress, contractAddress, initializeSchema } from "../validation.js";
import { sendError, sendValidationError } from "../error-response.js";
import { addContractTemplateReview, createContractTemplate, getContractTemplate, listContractTemplates, listContractTemplateVersions, recordContractTemplateClone, updateContractTemplate } from "../database/index.js";

export const contractTemplatesRouter = Router();
const types = ["equal_split", "tiered", "progressive", "custom"];
const config = initializeSchema.pick({ collaborators: true, shares: true });
const body = z.object({ walletAddress: stellarAddress, name: z.string().trim().min(1).max(100), description: z.string().trim().max(2000).optional(), type: z.enum(types).optional(), visibility: z.enum(["private", "public"]).optional(), configuration: config });
const updateBody = body.omit({ walletAddress: true }).partial();
const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
function invalid(res, result) { return sendValidationError(res, result.error.issues.map(issue => ({ field: issue.path.join("."), message: issue.message }))); }

// Public catalogue. `mine` intentionally remains a separate endpoint so a
// private template can never leak through marketplace filtering.
contractTemplatesRouter.get("/marketplace", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({ success: true, data: listContractTemplates({ publicOnly: true, type: types.includes(req.query.type) ? req.query.type : undefined, search: typeof req.query.search === "string" ? req.query.search.slice(0, 100) : undefined, limit, offset }) });
});
contractTemplatesRouter.get("/mine", (req, res) => {
  const walletAddress = req.query.walletAddress;
  if (typeof walletAddress !== "string" || !stellarAddress.safeParse(walletAddress).success) return sendError(res, 400, "invalid_stellar_address", "A valid walletAddress is required");
  res.json({ success: true, data: listContractTemplates({ walletAddress }) });
});
contractTemplatesRouter.post("/", (req, res) => {
  const parsed = body.safeParse(req.body); if (!parsed.success) return invalid(res, parsed);
  res.status(201).json({ success: true, data: createContractTemplate(parsed.data) });
});
contractTemplatesRouter.get("/:id/versions", (req, res) => {
  const templateId = id(req.params.id); const template = templateId && getContractTemplate(templateId);
  if (!template || (template.visibility !== "public" && req.query.walletAddress !== template.walletAddress)) return sendError(res, 404, "not_found", "Template not found");
  res.json({ success: true, data: listContractTemplateVersions(templateId) });
});
contractTemplatesRouter.post("/:id/fork", (req, res) => {
  const templateId = id(req.params.id); const source = templateId && getContractTemplate(templateId);
  const parsed = body.safeParse({ ...req.body, configuration: req.body?.configuration ?? source?.configuration });
  if (!source || source.visibility !== "public") return sendError(res, 404, "not_found", "Public template not found");
  if (!parsed.success) return invalid(res, parsed);
  res.status(201).json({ success: true, data: createContractTemplate({ ...parsed.data, sourceTemplateId: source.id, sourceVersion: source.version }) });
});
contractTemplatesRouter.post("/:id/reviews", (req, res) => {
  const templateId = id(req.params.id); const source = templateId && getContractTemplate(templateId);
  const parsed = z.object({ walletAddress: stellarAddress, rating: z.number().int().min(1).max(5), content: z.string().trim().max(2000).optional() }).safeParse(req.body);
  if (!source || source.visibility !== "public") return sendError(res, 404, "not_found", "Public template not found");
  if (!parsed.success) return invalid(res, parsed);
  res.json({ success: true, data: addContractTemplateReview(templateId, parsed.data.walletAddress, parsed.data.rating, parsed.data.content) });
});
contractTemplatesRouter.post("/:id/clone", (req, res) => {
  const templateId = id(req.params.id); const source = templateId && getContractTemplate(templateId);
  const parsed = z.object({ walletAddress: stellarAddress, targetContractId: contractAddress, configuration: config.optional() }).safeParse(req.body);
  if (!source || (source.visibility !== "public" && parsed.success && source.walletAddress !== parsed.data.walletAddress)) return sendError(res, 404, "not_found", "Template not found");
  if (!parsed.success) return invalid(res, parsed);
  const cloneId = recordContractTemplateClone({ sourceTemplateId: source.id, sourceTemplateVersion: source.version, targetContractId: parsed.data.targetContractId, walletAddress: parsed.data.walletAddress, configuration: parsed.data.configuration ?? source.configuration });
  res.status(201).json({ success: true, data: { cloneId, configuration: parsed.data.configuration ?? source.configuration } });
});
contractTemplatesRouter.get("/:id", (req, res) => {
  const template = getContractTemplate(id(req.params.id));
  if (!template || (template.visibility !== "public" && req.query.walletAddress !== template.walletAddress)) return sendError(res, 404, "not_found", "Template not found");
  res.json({ success: true, data: template });
});
contractTemplatesRouter.patch("/:id", (req, res) => {
  const walletAddress = req.body?.walletAddress; const parsed = updateBody.safeParse(req.body);
  if (!stellarAddress.safeParse(walletAddress).success) return sendError(res, 400, "invalid_stellar_address", "A valid walletAddress is required");
  if (!parsed.success || Object.keys(parsed.data).length === 0) return parsed.success ? sendError(res, 400, "validation_failed", "At least one update is required") : invalid(res, parsed);
  const template = updateContractTemplate(id(req.params.id), walletAddress, parsed.data);
  if (!template) return sendError(res, 404, "not_found", "Template not found");
  res.json({ success: true, data: template });
});
