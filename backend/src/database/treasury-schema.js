/**
 * DAO Treasury Management Database Schema and Operations (#1076)
 *
 * Persists the structured treasury state used by the treasury-manager service:
 *   - budget categories (development, marketing, operations, reserves)
 *   - funding allocations per category/period
 *   - expenses with an approval workflow
 *   - approval/rejection decisions
 *   - expense receipts (IPFS / URL storage)
 *
 * Every operation keeps an in-memory mirror so unit tests that run against the
 * mocked `better-sqlite3` (where `db.open` is falsy) still exercise the full
 * business logic without touching disk. This mirrors backend/src/database/rights-schema.js.
 */

import { db, countWrite } from "./core.js";

// In-memory store fallback for mocked SQLite environments in unit testing
const _memoryCategories = new Map();
const _memoryAllocations = new Map();
const _memoryExpenses = new Map();
const _memoryApprovals = new Map();
const _memoryReceipts = new Map();
let _nextCategoryId = 1;
let _nextAllocationId = 1;
let _nextExpenseId = 1;
let _nextApprovalId = 1;
let _nextReceiptId = 1;

export const EXPENSE_STATUSES = ["pending", "approved", "rejected", "paid"];

/**
 * Initialize all database tables for the treasury management system.
 */
export function initializeTreasuryTables() {
  if (!db.open) return;

  try {
    db.exec(`
      -- Budget categories: target allocation percentages per category
      CREATE TABLE IF NOT EXISTS treasury_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        percentage REAL NOT NULL DEFAULT 0.0 CHECK(percentage >= 0.0 AND percentage <= 100.0),
        isActive INTEGER NOT NULL DEFAULT 1,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_treasury_categories_name ON treasury_categories(name);

      -- Funding allocations: how much has been allocated to a category
      CREATE TABLE IF NOT EXISTS treasury_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        categoryId INTEGER,
        amount REAL NOT NULL CHECK(amount >= 0.0),
        period TEXT NOT NULL DEFAULT 'all-time',
        note TEXT,
        allocatedBy TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(categoryId) REFERENCES treasury_categories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_treasury_allocations_categoryId ON treasury_allocations(categoryId);
      CREATE INDEX IF NOT EXISTS idx_treasury_allocations_period ON treasury_allocations(period);

      -- Expenses: recorded spending against a budget category
      CREATE TABLE IF NOT EXISTS treasury_expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        categoryId INTEGER NOT NULL,
        amount REAL NOT NULL CHECK(amount >= 0.0),
        description TEXT NOT NULL,
        date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'approved', 'rejected', 'paid')),
        requestedBy TEXT,
        requiresApproval INTEGER NOT NULL DEFAULT 0,
        approver TEXT,
        approvalNotes TEXT,
        approvedAt DATETIME,
        receiptCid TEXT,
        receiptUrl TEXT,
        receiptName TEXT,
        receiptHash TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(categoryId) REFERENCES treasury_categories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_treasury_expenses_categoryId ON treasury_expenses(categoryId);
      CREATE INDEX IF NOT EXISTS idx_treasury_expenses_status ON treasury_expenses(status);
      CREATE INDEX IF NOT EXISTS idx_treasury_expenses_date ON treasury_expenses(date);

      -- Approval workflow decisions
      CREATE TABLE IF NOT EXISTS treasury_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        expenseId INTEGER NOT NULL,
        approver TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
        notes TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(expenseId) REFERENCES treasury_expenses(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_treasury_approvals_expenseId ON treasury_approvals(expenseId);

      -- Receipts (IPFS CID or hosted URL)
      CREATE TABLE IF NOT EXISTS treasury_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        expenseId INTEGER NOT NULL,
        ipfsCid TEXT,
        url TEXT,
        fileName TEXT,
        documentHash TEXT,
        uploadedBy TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(expenseId) REFERENCES treasury_expenses(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_treasury_receipts_expenseId ON treasury_receipts(expenseId);
    `);
  } catch (_e) {
    // Ignore in mocked environment
  }
}

// Ensure tables are initialized when this module is loaded
initializeTreasuryTables();

/**
 * Clear all treasury tables and memory state (for testing).
 */
export function clearTreasuryTables() {
  _memoryCategories.clear();
  _memoryAllocations.clear();
  _memoryExpenses.clear();
  _memoryApprovals.clear();
  _memoryReceipts.clear();
  _nextCategoryId = 1;
  _nextAllocationId = 1;
  _nextExpenseId = 1;
  _nextApprovalId = 1;
  _nextReceiptId = 1;

  if (db.open) {
    try {
      db.prepare(`DELETE FROM treasury_receipts`).run();
      db.prepare(`DELETE FROM treasury_approvals`).run();
      db.prepare(`DELETE FROM treasury_expenses`).run();
      db.prepare(`DELETE FROM treasury_allocations`).run();
      db.prepare(`DELETE FROM treasury_categories`).run();
    } catch (_e) {
      // Mocked DB fallback
    }
  }
}

// ── Budget Categories ────────────────────────────────────────────────────────

export function createCategoryRecord({
  name,
  description = null,
  percentage = 0,
  isActive = true,
}) {
  const now = new Date().toISOString();
  let insertId;

  if (db.open) {
    try {
      const result = db
        .prepare(
          `INSERT INTO treasury_categories (name, description, percentage, isActive, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(name, description, percentage, isActive ? 1 : 0, now, now);
      countWrite();
      insertId = result?.lastInsertRowid;
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  if (!insertId) insertId = _nextCategoryId++;

  const record = {
    id: insertId,
    name,
    description,
    percentage,
    isActive: Boolean(isActive),
    createdAt: now,
    updatedAt: now,
  };

  _memoryCategories.set(insertId, record);
  return record;
}

export function getCategoryById(id) {
  if (db.open) {
    try {
      const row = db.prepare(`SELECT * FROM treasury_categories WHERE id = ?`).get(id);
      if (row) return { ...row, isActive: Boolean(row.isActive) };
    } catch (_e) {
      // Mocked DB fallback
    }
  }
  return _memoryCategories.get(id) || null;
}

export function getCategoryByName(name) {
  if (db.open) {
    try {
      const row = db.prepare(`SELECT * FROM treasury_categories WHERE name = ?`).get(name);
      if (row) return { ...row, isActive: Boolean(row.isActive) };
    } catch (_e) {
      // Mocked DB fallback
    }
  }
  for (const record of _memoryCategories.values()) {
    if (record.name === name) return record;
  }
  return null;
}

export function listCategories() {
  if (db.open) {
    try {
      const rows = db.prepare(`SELECT * FROM treasury_categories ORDER BY name ASC`).all();
      if (rows && rows.length > 0) {
        return rows.map((row) => ({ ...row, isActive: Boolean(row.isActive) }));
      }
    } catch (_e) {
      // Mocked DB fallback
    }
  }
  return [..._memoryCategories.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function updateCategoryRecord(id, updates) {
  const existing = getCategoryById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const next = {
    ...existing,
    description: updates.description !== undefined ? updates.description : existing.description,
    percentage: updates.percentage !== undefined ? updates.percentage : existing.percentage,
    isActive: updates.isActive !== undefined ? Boolean(updates.isActive) : existing.isActive,
    updatedAt: now,
  };

  if (db.open) {
    try {
      db.prepare(
        `UPDATE treasury_categories
         SET description = ?, percentage = ?, isActive = ?, updatedAt = ?
         WHERE id = ?`
      ).run(next.description, next.percentage, next.isActive ? 1 : 0, now, id);
      countWrite();
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  _memoryCategories.set(id, next);
  return next;
}

export function deleteCategoryRecord(id) {
  const existing = getCategoryById(id);
  if (!existing) return false;

  if (db.open) {
    try {
      db.prepare(`DELETE FROM treasury_categories WHERE id = ?`).run(id);
      countWrite();
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  _memoryCategories.delete(id);
  return true;
}

// ── Allocations ──────────────────────────────────────────────────────────────

export function createAllocationRecord({
  categoryId = null,
  amount,
  period = "all-time",
  note = null,
  allocatedBy = null,
}) {
  const now = new Date().toISOString();
  let insertId;

  if (db.open) {
    try {
      const result = db
        .prepare(
          `INSERT INTO treasury_allocations (categoryId, amount, period, note, allocatedBy, createdAt)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(categoryId, amount, period, note, allocatedBy, now);
      countWrite();
      insertId = result?.lastInsertRowid;
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  if (!insertId) insertId = _nextAllocationId++;

  const record = {
    id: insertId,
    categoryId,
    amount,
    period,
    note,
    allocatedBy,
    createdAt: now,
  };

  _memoryAllocations.set(insertId, record);
  return record;
}

export function getAllocationById(id) {
  if (db.open) {
    try {
      const row = db.prepare(`SELECT * FROM treasury_allocations WHERE id = ?`).get(id);
      if (row) return row;
    } catch (_e) {
      // Mocked DB fallback
    }
  }
  return _memoryAllocations.get(id) || null;
}

export function listAllocations({ categoryId = null, period = null } = {}) {
  if (db.open) {
    try {
      const clauses = [];
      const params = [];
      if (categoryId != null) {
        clauses.push("categoryId = ?");
        params.push(categoryId);
      }
      if (period != null) {
        clauses.push("period = ?");
        params.push(period);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT * FROM treasury_allocations ${where} ORDER BY createdAt DESC`)
        .all(...params);
      if (rows && rows.length > 0) return rows;
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  let results = [..._memoryAllocations.values()];
  if (categoryId != null) results = results.filter((r) => r.categoryId === categoryId);
  if (period != null) results = results.filter((r) => r.period === period);
  return results.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ── Expenses ─────────────────────────────────────────────────────────────────

export function createExpenseRecord({
  categoryId,
  amount,
  description,
  date,
  status = "pending",
  requestedBy = null,
  requiresApproval = false,
  approver = null,
  approvalNotes = null,
  approvedAt = null,
  receiptCid = null,
  receiptUrl = null,
  receiptName = null,
  receiptHash = null,
}) {
  const now = new Date().toISOString();
  let insertId;

  if (db.open) {
    try {
      const result = db
        .prepare(
          `INSERT INTO treasury_expenses (
             categoryId, amount, description, date, status, requestedBy, requiresApproval,
             approver, approvalNotes, approvedAt, receiptCid, receiptUrl, receiptName,
             receiptHash, createdAt, updatedAt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          categoryId,
          amount,
          description,
          date,
          status,
          requestedBy,
          requiresApproval ? 1 : 0,
          approver,
          approvalNotes,
          approvedAt,
          receiptCid,
          receiptUrl,
          receiptName,
          receiptHash,
          now,
          now
        );
      countWrite();
      insertId = result?.lastInsertRowid;
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  if (!insertId) insertId = _nextExpenseId++;

  const record = {
    id: insertId,
    categoryId,
    amount,
    description,
    date,
    status,
    requestedBy,
    requiresApproval: Boolean(requiresApproval),
    approver,
    approvalNotes,
    approvedAt,
    receiptCid,
    receiptUrl,
    receiptName,
    receiptHash,
    createdAt: now,
    updatedAt: now,
  };

  _memoryExpenses.set(insertId, record);
  return record;
}

export function getExpenseById(id) {
  if (db.open) {
    try {
      const row = db.prepare(`SELECT * FROM treasury_expenses WHERE id = ?`).get(id);
      if (row) return { ...row, requiresApproval: Boolean(row.requiresApproval) };
    } catch (_e) {
      // Mocked DB fallback
    }
  }
  return _memoryExpenses.get(id) || null;
}

export function listExpenses({ categoryId = null, status = null, from = null, to = null } = {}) {
  const applyFilters = (rows) => {
    let filtered = rows;
    if (categoryId != null) filtered = filtered.filter((r) => r.categoryId === categoryId);
    if (status != null) filtered = filtered.filter((r) => r.status === status);
    if (from != null) filtered = filtered.filter((r) => String(r.date) >= from);
    if (to != null) filtered = filtered.filter((r) => String(r.date) <= to);
    return filtered.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  };

  if (db.open) {
    try {
      const clauses = [];
      const params = [];
      if (categoryId != null) {
        clauses.push("categoryId = ?");
        params.push(categoryId);
      }
      if (status != null) {
        clauses.push("status = ?");
        params.push(status);
      }
      if (from != null) {
        clauses.push("date >= ?");
        params.push(from);
      }
      if (to != null) {
        clauses.push("date <= ?");
        params.push(to);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT * FROM treasury_expenses ${where} ORDER BY date DESC`)
        .all(...params);
      if (rows && rows.length > 0) {
        return rows.map((row) => ({ ...row, requiresApproval: Boolean(row.requiresApproval) }));
      }
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  return applyFilters([..._memoryExpenses.values()]).map((row) => ({
    ...row,
    requiresApproval: Boolean(row.requiresApproval),
  }));
}

export function updateExpenseRecord(id, updates) {
  const existing = getExpenseById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const allowedKeys = [
    "categoryId",
    "amount",
    "description",
    "date",
    "status",
    "requestedBy",
    "requiresApproval",
    "approver",
    "approvalNotes",
    "approvedAt",
    "receiptCid",
    "receiptUrl",
    "receiptName",
    "receiptHash",
  ];

  const next = { ...existing, updatedAt: now };
  for (const key of allowedKeys) {
    if (updates[key] !== undefined) {
      next[key] = key === "requiresApproval" ? Boolean(updates[key]) : updates[key];
    }
  }

  if (db.open) {
    try {
      db.prepare(
        `UPDATE treasury_expenses
         SET categoryId = ?, amount = ?, description = ?, date = ?, status = ?, requestedBy = ?,
             requiresApproval = ?, approver = ?, approvalNotes = ?, approvedAt = ?,
             receiptCid = ?, receiptUrl = ?, receiptName = ?, receiptHash = ?, updatedAt = ?
         WHERE id = ?`
      ).run(
        next.categoryId,
        next.amount,
        next.description,
        next.date,
        next.status,
        next.requestedBy,
        next.requiresApproval ? 1 : 0,
        next.approver,
        next.approvalNotes,
        next.approvedAt,
        next.receiptCid,
        next.receiptUrl,
        next.receiptName,
        next.receiptHash,
        now,
        id
      );
      countWrite();
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  _memoryExpenses.set(id, next);
  return next;
}

export function deleteExpenseRecord(id) {
  const existing = getExpenseById(id);
  if (!existing) return false;

  if (db.open) {
    try {
      db.prepare(`DELETE FROM treasury_expenses WHERE id = ?`).run(id);
      countWrite();
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  _memoryExpenses.delete(id);
  return true;
}

// ── Approvals ────────────────────────────────────────────────────────────────

export function createApprovalRecord({ expenseId, approver, decision, notes = null }) {
  const now = new Date().toISOString();
  let insertId;

  if (db.open) {
    try {
      const result = db
        .prepare(
          `INSERT INTO treasury_approvals (expenseId, approver, decision, notes, createdAt)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(expenseId, approver, decision, notes, now);
      countWrite();
      insertId = result?.lastInsertRowid;
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  if (!insertId) insertId = _nextApprovalId++;

  const record = { id: insertId, expenseId, approver, decision, notes, createdAt: now };
  _memoryApprovals.set(insertId, record);
  return record;
}

export function listApprovalsByExpense(expenseId) {
  if (db.open) {
    try {
      const rows = db
        .prepare(`SELECT * FROM treasury_approvals WHERE expenseId = ? ORDER BY createdAt ASC`)
        .all(expenseId);
      if (rows && rows.length > 0) return rows;
    } catch (_e) {
      // Mocked DB fallback
    }
  }
  return [..._memoryApprovals.values()]
    .filter((r) => r.expenseId === expenseId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// ── Receipts ─────────────────────────────────────────────────────────────────

export function createReceiptRecord({
  expenseId,
  ipfsCid = null,
  url = null,
  fileName = null,
  documentHash = null,
  uploadedBy = null,
}) {
  const now = new Date().toISOString();
  let insertId;

  if (db.open) {
    try {
      const result = db
        .prepare(
          `INSERT INTO treasury_receipts (expenseId, ipfsCid, url, fileName, documentHash, uploadedBy, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(expenseId, ipfsCid, url, fileName, documentHash, uploadedBy, now);
      countWrite();
      insertId = result?.lastInsertRowid;
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  if (!insertId) insertId = _nextReceiptId++;

  const record = { id: insertId, expenseId, ipfsCid, url, fileName, documentHash, uploadedBy, createdAt: now };
  _memoryReceipts.set(insertId, record);
  return record;
}

export function listReceiptsByExpense(expenseId) {
  if (db.open) {
    try {
      const rows = db
        .prepare(`SELECT * FROM treasury_receipts WHERE expenseId = ? ORDER BY createdAt ASC`)
        .all(expenseId);
      if (rows && rows.length > 0) return rows;
    } catch (_e) {
      // Mocked DB fallback
    }
  }
  return [..._memoryReceipts.values()].filter((r) => r.expenseId === expenseId);
}
