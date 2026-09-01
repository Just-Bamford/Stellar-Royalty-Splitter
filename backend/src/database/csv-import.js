import { db, countWrite } from "./core.js";

export function createCsvImport(contractId, fileName, rowCount, importedBy) {
  const stmt = db.prepare(`
    INSERT INTO csv_imports (contractId, fileName, rowCount, importedBy)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(contractId, fileName, rowCount, importedBy);
  countWrite();
  return { id: result.lastInsertRowid, contractId, fileName, rowCount, importedBy };
}

export function markImportSuccess(importId) {
  db.prepare("UPDATE csv_imports SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(importId);
  countWrite();
}

export function markImportFailed(importId, errorMessage) {
  db.prepare("UPDATE csv_imports SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(errorMessage, importId);
  countWrite();
}

export function getCsvImport(importId) {
  return db.prepare("SELECT * FROM csv_imports WHERE id = ?").get(importId) ?? null;
}

export function getCsvImportsByContract(contractId) {
  return db.prepare("SELECT * FROM csv_imports WHERE contractId = ? ORDER BY created_at DESC").all(contractId);
}

export function addImportResult(importId, rowIndex, address, share, status, errorMessage) {
  db.prepare(`
    INSERT INTO csv_import_results (importId, rowIndex, address, share, status, errorMessage)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(importId, rowIndex, address, share, status, errorMessage ?? null);
  countWrite();
}

export function getImportResults(importId) {
  return db.prepare("SELECT * FROM csv_import_results WHERE importId = ? ORDER BY rowIndex ASC").all(importId);
}

export function getImportSummary(importId) {
  return db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errorCount
    FROM csv_import_results WHERE importId = ?
  `).get(importId);
}
