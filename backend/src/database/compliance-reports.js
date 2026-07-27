/**
 * Compliance report database functions (#601).
 */

import { db, countWrite } from "./core.js";

/**
 * Store a generated compliance report.
 */
export function saveComplianceReport(data) {
  const existing = db.prepare(`
    SELECT id FROM compliance_reports
    WHERE report_type = ? AND period_start = ? AND period_end = ?
  `).get(data.report_type, data.period_start, data.period_end);

  if (existing) {
    db.prepare(`
      UPDATE compliance_reports SET
        generated_at = CURRENT_TIMESTAMP,
        generated_by = ?,
        file_path = ?,
        emailed_to = ?,
        status = ?,
        summary = ?
      WHERE id = ?
    `).run(
      data.generated_by ?? "system",
      data.file_path ?? null,
      data.emailed_to ?? null,
      data.status ?? "generated",
      data.summary ? JSON.stringify(data.summary) : null,
      existing.id
    );
    countWrite();
    return getComplianceReport(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO compliance_reports
      (report_type, period_start, period_end, generated_by, file_path, emailed_to, status, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.report_type,
    data.period_start,
    data.period_end,
    data.generated_by ?? "system",
    data.file_path ?? null,
    data.emailed_to ?? null,
    data.status ?? "generated",
    data.summary ? JSON.stringify(data.summary) : null
  );
  countWrite();
  return getComplianceReport(result.lastInsertRowid);
}

export function getComplianceReport(id) {
  const row = db.prepare("SELECT * FROM compliance_reports WHERE id = ?").get(id);
  if (!row) return null;
  try { row.summary = JSON.parse(row.summary ?? "null"); } catch (_) {}
  return row;
}

export function listComplianceReports(reportType = null, limit = 50, offset = 0) {
  let query = "SELECT * FROM compliance_reports";
  const params = [];
  if (reportType) { query += " WHERE report_type = ?"; params.push(reportType); }
  query += " ORDER BY generated_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  return db.prepare(query).all(...params).map((row) => {
    try { row.summary = JSON.parse(row.summary ?? "null"); } catch (_) {}
    return row;
  });
}

export function getComplianceScheduleConfig() {
  return db.prepare("SELECT * FROM compliance_report_schedules WHERE id = 1").get() ?? null;
}

export function updateComplianceScheduleConfig(updates) {
  const current = getComplianceScheduleConfig();
  db.prepare(`
    UPDATE compliance_report_schedules SET
      monthly_enabled = ?,
      quarterly_enabled = ?,
      annual_enabled = ?,
      email_recipients = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(
    updates.monthly_enabled ?? current?.monthly_enabled ?? 1,
    updates.quarterly_enabled ?? current?.quarterly_enabled ?? 1,
    updates.annual_enabled ?? current?.annual_enabled ?? 1,
    JSON.stringify(updates.email_recipients ?? JSON.parse(current?.email_recipients ?? "[]")),
  );
  countWrite();
  return getComplianceScheduleConfig();
}
