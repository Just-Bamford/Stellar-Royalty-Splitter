import { db, countWrite } from "./core.js";

export function getContributorTax(walletAddress) {
  return db.prepare("SELECT * FROM contributor_tax WHERE walletAddress = ?").get(walletAddress) ?? null;
}

export function upsertContributorTax(data) {
  const existing = db.prepare("SELECT id FROM contributor_tax WHERE walletAddress = ?").get(data.walletAddress);
  if (existing) {
    db.prepare(`
      UPDATE contributor_tax
      SET tax_status = ?, tax_id = ?, w9_file_path = ?, w9_file_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE walletAddress = ?
    `).run(data.tax_status, data.tax_id ?? null, data.w9_file_path ?? null, data.w9_file_name ?? null, data.walletAddress);
  } else {
    db.prepare(`
      INSERT INTO contributor_tax (walletAddress, tax_status, tax_id, w9_file_path, w9_file_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.walletAddress, data.tax_status, data.tax_id ?? null, data.w9_file_path ?? null, data.w9_file_name ?? null);
  }
  countWrite();
  return getContributorTax(data.walletAddress);
}

export function getTaxComplianceReport() {
  return db.prepare(`
    SELECT ct.*, 
      CASE 
        WHEN ct.tax_status IS NULL THEN 'missing'
        WHEN ct.tax_status = 'completed' THEN 'compliant'
        WHEN ct.tax_status IN ('pending', 'not_collected') THEN 'non_compliant'
        ELSE 'non_compliant'
      END as compliance_status
    FROM contributor_tax ct
    ORDER BY ct.updated_at DESC
  `).all();
}

export function getContributorsMissingTaxInfo() {
  return db.prepare(`
    SELECT ct.* FROM contributor_tax ct
    WHERE ct.tax_status IS NULL OR ct.tax_status IN ('not_collected', 'pending')
    ORDER BY ct.updated_at ASC
  `).all();
}

export function getAllWalletAddresses() {
  return db.prepare("SELECT DISTINCT walletAddress FROM contributor_tax").all().map(r => r.walletAddress);
}
