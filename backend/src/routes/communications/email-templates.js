/**
 * Email template management routes — /api/v1/communications/email-templates
 *
 * Provides CRUD for application-level email templates stored in SQLite.
 * Templates define the subject, HTML body, text body, and optional
 * SendGrid dynamic template ID for each notification type.
 *
 * Supported template types:
 *   payout_confirmation | dispute_notification | weekly_digest | alert
 *
 * Routes:
 *   GET    /                         list all templates
 *   GET    /:type                    get template by type
 *   POST   /                         create or update a template (upsert)
 *   DELETE /:type                    delete a template
 *   POST   /:type/preview            render a preview of a template
 */

import { Router } from "express";
import { z } from "zod";
import logger from "../../logger.js";
import { validate } from "../../validation.js";
import { sendError } from "../../error-response.js";
import { requireAdminBearerOrRole } from "../../middleware/rbac.js";
import { db, countWrite } from "../../database/core.js";

export const emailTemplatesRouter = Router();

// ─── Template types ───────────────────────────────────────────────────────────

export const EMAIL_TEMPLATE_TYPES = [
  "payout_confirmation",
  "dispute_notification",
  "weekly_digest",
  "alert",
];

// ─── Database helpers (uses existing SQLite instance) ─────────────────────────

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT    NOT NULL UNIQUE,
      subject     TEXT    NOT NULL,
      html_body   TEXT    NOT NULL,
      text_body   TEXT    NOT NULL,
      sendgrid_template_id TEXT,
      version     INTEGER NOT NULL DEFAULT 1,
      active      INTEGER NOT NULL DEFAULT 1,
      created_by  TEXT,
      createdAt   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updatedAt   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
}

// Ensure the table exists when the module is first imported
try {
  ensureTable();
} catch (_) {
  // In test environments the db may not be available on import; ensureTable
  // is called again before any DB operation that needs it.
}

function rowToTemplate(row) {
  return {
    id: row.id,
    type: row.type,
    subject: row.subject,
    htmlBody: row.html_body,
    textBody: row.text_body,
    sendgridTemplateId: row.sendgrid_template_id ?? null,
    version: row.version,
    active: row.active === 1,
    createdBy: row.created_by ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function listAllTemplates() {
  ensureTable();
  return db
    .prepare("SELECT * FROM email_templates ORDER BY type ASC")
    .all()
    .map(rowToTemplate);
}

function getTemplateByType(type) {
  ensureTable();
  const row = db
    .prepare("SELECT * FROM email_templates WHERE type = ?")
    .get(type);
  return row ? rowToTemplate(row) : null;
}

function upsertTemplate({ type, subject, htmlBody, textBody, sendgridTemplateId, createdBy }) {
  ensureTable();
  const existing = getTemplateByType(type);
  if (existing) {
    db.prepare(`
      UPDATE email_templates
      SET subject = ?,
          html_body = ?,
          text_body = ?,
          sendgrid_template_id = ?,
          version = version + 1,
          updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE type = ?
    `).run(subject, htmlBody, textBody, sendgridTemplateId ?? null, type);
    countWrite();
  } else {
    db.prepare(`
      INSERT INTO email_templates (type, subject, html_body, text_body, sendgrid_template_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(type, subject, htmlBody, textBody, sendgridTemplateId ?? null, createdBy ?? null);
    countWrite();
  }
  return getTemplateByType(type);
}

function deleteTemplateByType(type) {
  ensureTable();
  const result = db.prepare("DELETE FROM email_templates WHERE type = ?").run(type);
  countWrite();
  return result.changes > 0;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const upsertSchema = z.object({
  type: z.enum(EMAIL_TEMPLATE_TYPES),
  subject: z.string().min(1).max(500),
  htmlBody: z.string().min(1).max(100_000),
  textBody: z.string().min(1).max(100_000),
  sendgridTemplateId: z.string().max(200).optional().nullable(),
  createdBy: z.string().max(200).optional().nullable(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/communications/email-templates
 * List all email templates.
 */
emailTemplatesRouter.get("/", requireAdminBearerOrRole("operator"), (req, res) => {
  try {
    const templates = listAllTemplates();
    res.json({ success: true, data: templates, count: templates.length });
  } catch (err) {
    logger.error("Failed to list email templates", { error: err.message });
    sendError(res, 500, "template_list_failed", "Failed to list email templates");
  }
});

/**
 * GET /api/v1/communications/email-templates/:type
 * Get a specific template by type.
 */
emailTemplatesRouter.get("/:type", requireAdminBearerOrRole("operator"), (req, res) => {
  const { type } = req.params;

  if (!EMAIL_TEMPLATE_TYPES.includes(type)) {
    return sendError(
      res,
      400,
      "invalid_template_type",
      `Template type must be one of: ${EMAIL_TEMPLATE_TYPES.join(", ")}`
    );
  }

  try {
    const template = getTemplateByType(type);
    if (!template) {
      return sendError(res, 404, "template_not_found", `No template found for type '${type}'`);
    }
    res.json({ success: true, data: template });
  } catch (err) {
    logger.error("Failed to get email template", { type, error: err.message });
    sendError(res, 500, "template_fetch_failed", "Failed to fetch email template");
  }
});

/**
 * POST /api/v1/communications/email-templates
 * Create or update (upsert) an email template. Requires admin.
 */
emailTemplatesRouter.post(
  "/",
  requireAdminBearerOrRole("admin"),
  validate(upsertSchema),
  (req, res) => {
    try {
      const template = upsertTemplate(req.body);
      logger.info("Email template saved", {
        event: "email_template_saved",
        type: req.body.type,
        version: template.version,
      });
      res.status(201).json({ success: true, data: template });
    } catch (err) {
      logger.error("Failed to save email template", { error: err.message });
      sendError(res, 500, "template_save_failed", "Failed to save email template");
    }
  }
);

/**
 * DELETE /api/v1/communications/email-templates/:type
 * Delete a template. Requires admin.
 */
emailTemplatesRouter.delete("/:type", requireAdminBearerOrRole("admin"), (req, res) => {
  const { type } = req.params;

  if (!EMAIL_TEMPLATE_TYPES.includes(type)) {
    return sendError(
      res,
      400,
      "invalid_template_type",
      `Template type must be one of: ${EMAIL_TEMPLATE_TYPES.join(", ")}`
    );
  }

  try {
    const deleted = deleteTemplateByType(type);
    if (!deleted) {
      return sendError(res, 404, "template_not_found", `No template found for type '${type}'`);
    }
    logger.info("Email template deleted", { event: "email_template_deleted", type });
    res.json({ success: true, message: `Template '${type}' deleted` });
  } catch (err) {
    logger.error("Failed to delete email template", { type, error: err.message });
    sendError(res, 500, "template_delete_failed", "Failed to delete email template");
  }
});

/**
 * POST /api/v1/communications/email-templates/:type/preview
 * Render a preview by interpolating provided variables into the stored template.
 * Does NOT send an email. Requires admin.
 */
emailTemplatesRouter.post(
  "/:type/preview",
  requireAdminBearerOrRole("admin"),
  (req, res) => {
    const { type } = req.params;

    if (!EMAIL_TEMPLATE_TYPES.includes(type)) {
      return sendError(
        res,
        400,
        "invalid_template_type",
        `Template type must be one of: ${EMAIL_TEMPLATE_TYPES.join(", ")}`
      );
    }

    try {
      const template = getTemplateByType(type);
      if (!template) {
        return sendError(res, 404, "template_not_found", `No template found for type '${type}'`);
      }

      // Simple mustache-style variable interpolation: {{key}}
      const variables = req.body?.variables ?? {};
      const interpolate = (str) =>
        str.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);

      res.json({
        success: true,
        data: {
          type: template.type,
          subject: interpolate(template.subject),
          htmlBody: interpolate(template.htmlBody),
          textBody: interpolate(template.textBody),
          version: template.version,
        },
      });
    } catch (err) {
      logger.error("Failed to preview email template", { type, error: err.message });
      sendError(res, 500, "template_preview_failed", "Failed to preview email template");
    }
  }
);
