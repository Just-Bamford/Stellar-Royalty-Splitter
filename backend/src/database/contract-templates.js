import { db, countWrite } from "./core.js";

function parse(row) {
  if (!row) return null;
  return { ...row, configuration: JSON.parse(row.configuration), rating: Number(row.rating ?? 0), reviewCount: Number(row.reviewCount ?? 0) };
}

const select = `
  SELECT t.*, COALESCE(AVG(r.rating), 0) AS rating, COUNT(r.id) AS reviewCount
  FROM contract_templates t
  LEFT JOIN royalty_split_template_reviews r ON r.templateId = t.id`;

export function createContractTemplate({ walletAddress, name, description = "", type = "custom", visibility = "private", configuration, sourceTemplateId = null, sourceVersion = null }) {
  const create = db.transaction(() => {
    const result = db.prepare(`INSERT INTO contract_templates
      (walletAddress, name, description, type, visibility, configuration, rootTemplateId, sourceTemplateId, sourceVersion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(walletAddress, name, description, type, visibility, JSON.stringify(configuration), sourceTemplateId, sourceTemplateId, sourceVersion);
    const id = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO royalty_split_template_versions (templateId, version, snapshot) VALUES (?, 1, ?)")
      .run(id, JSON.stringify({ name, description, type, visibility, configuration }));
    if (sourceTemplateId) db.prepare("UPDATE contract_templates SET rootTemplateId = COALESCE((SELECT rootTemplateId FROM contract_templates WHERE id = ?), ?) WHERE id = ?").run(sourceTemplateId, sourceTemplateId, id);
    return id;
  });
  const id = create(); countWrite(); return getContractTemplate(id);
}

export function getContractTemplate(id) {
  return parse(db.prepare(`${select} WHERE t.id = ? GROUP BY t.id`).get(id));
}

export function listContractTemplates({ walletAddress, publicOnly = false, type, search, limit = 50, offset = 0 } = {}) {
  const where = []; const args = [];
  if (publicOnly) where.push("t.visibility = 'public'");
  if (walletAddress) { where.push("t.walletAddress = ?"); args.push(walletAddress); }
  if (type) { where.push("t.type = ?"); args.push(type); }
  if (search) { where.push("(t.name LIKE ? OR t.description LIKE ?)"); args.push(`%${search}%`, `%${search}%`); }
  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`${select}${clause} GROUP BY t.id ORDER BY t.updatedAt DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(parse);
}

export function updateContractTemplate(id, walletAddress, changes) {
  const current = getContractTemplate(id);
  if (!current || current.walletAddress !== walletAddress) return null;
  const next = { name: changes.name ?? current.name, description: changes.description ?? current.description, type: changes.type ?? current.type, visibility: changes.visibility ?? current.visibility, configuration: changes.configuration ?? current.configuration };
  db.transaction(() => {
    const version = current.version + 1;
    db.prepare("UPDATE contract_templates SET name=?, description=?, type=?, visibility=?, configuration=?, version=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?")
      .run(next.name, next.description, next.type, next.visibility, JSON.stringify(next.configuration), version, id);
    db.prepare("INSERT INTO royalty_split_template_versions (templateId, version, snapshot) VALUES (?, ?, ?)").run(id, version, JSON.stringify(next));
  })(); countWrite(); return getContractTemplate(id);
}

export function listContractTemplateVersions(id) {
  return db.prepare("SELECT version, snapshot, createdAt FROM royalty_split_template_versions WHERE templateId = ? ORDER BY version DESC").all(id).map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) }));
}

export function addContractTemplateReview(templateId, walletAddress, rating, content = "") {
  db.prepare(`INSERT INTO royalty_split_template_reviews (templateId, walletAddress, rating, content)
    VALUES (?, ?, ?, ?) ON CONFLICT(templateId, walletAddress) DO UPDATE SET rating=excluded.rating, content=excluded.content, updatedAt=CURRENT_TIMESTAMP`).run(templateId, walletAddress, rating, content);
  countWrite(); return getContractTemplate(templateId);
}

export function recordContractTemplateClone({ sourceContractId = null, sourceTemplateId = null, sourceTemplateVersion = null, targetContractId, walletAddress, configuration }) {
  const result = db.prepare("INSERT INTO contract_template_clones (sourceContractId, sourceTemplateId, sourceTemplateVersion, targetContractId, walletAddress, configuration) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sourceContractId, sourceTemplateId, sourceTemplateVersion, targetContractId, walletAddress, JSON.stringify(configuration));
  countWrite(); return Number(result.lastInsertRowid);
}
