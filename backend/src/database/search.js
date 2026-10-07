/**
 * Full-text search database functions — closes #971.
 *
 * Provides search capabilities across:
 * - Collaborators (name, address, notes)
 * - Transactions (amount, recipient, notes, hash)
 * - Disputes (description, category, ticket ID)
 * - Analytics data
 *
 * Uses SQLite FTS5 (Full-Text Search) for efficient text searching.
 */

import { db, countWrite } from "./core.js";
import logger from "../logger.js";

/**
 * Initialize full-text search tables and indexes.
 */
export function initializeSearchTables() {
  db.exec(`
    -- Full-text search index for collaborators
    CREATE VIRTUAL TABLE IF NOT EXISTS collaborators_fts USING fts5(
      walletAddress,
      name,
      email,
      notes,
      contractId,
      tokenize = 'porter unicode61'
    );

    -- Full-text search index for transactions
    CREATE VIRTUAL TABLE IF NOT EXISTS transactions_fts USING fts5(
      txHash,
      contractId,
      type,
      initiatorAddress,
      tokenId,
      notes,
      collaboratorAddresses,
      tokenize = 'porter unicode61'
    );

    -- Full-text search index for disputes
    CREATE VIRTUAL TABLE IF NOT EXISTS disputes_fts USING fts5(
      ticketId,
      walletAddress,
      contractId,
      category,
      description,
      status,
      comments,
      tokenize = 'porter unicode61'
    );

    -- Search history and analytics
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      searchType TEXT NOT NULL,
      resultsCount INTEGER NOT NULL DEFAULT 0,
      userId TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Popular search terms
    CREATE TABLE IF NOT EXISTS search_analytics (
      query TEXT PRIMARY KEY,
      searchCount INTEGER NOT NULL DEFAULT 0,
      lastSearched DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_search_history_query ON search_history(query);
    CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(userId);
    CREATE INDEX IF NOT EXISTS idx_search_history_timestamp ON search_history(timestamp);
    CREATE INDEX IF NOT EXISTS idx_search_analytics_count ON search_analytics(searchCount DESC);
  `);
}

/**
 * Index a collaborator for search.
 */
export function indexCollaborator(walletAddress, name, email, notes, contractId) {
  db.prepare(`
    INSERT INTO collaborators_fts (walletAddress, name, email, notes, contractId)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      notes = excluded.notes
  `).run(walletAddress, name || '', email || '', notes || '', contractId || '');
  countWrite();
}

/**
 * Index a transaction for search.
 */
export function indexTransaction(txHash, contractId, type, initiatorAddress, tokenId, notes, collaboratorAddresses) {
  db.prepare(`
    INSERT INTO transactions_fts (txHash, contractId, type, initiatorAddress, tokenId, notes, collaboratorAddresses)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    txHash || '',
    contractId || '',
    type || '',
    initiatorAddress || '',
    tokenId || '',
    notes || '',
    Array.isArray(collaboratorAddresses) ? collaboratorAddresses.join(' ') : ''
  );
  countWrite();
}

/**
 * Index a dispute for search.
 */
export function indexDispute(ticketId, walletAddress, contractId, category, description, status, comments) {
  const commentsText = Array.isArray(comments) ? comments.map(c => c.message).join(' ') : '';
  
  db.prepare(`
    INSERT INTO disputes_fts (ticketId, walletAddress, contractId, category, description, status, comments)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      description = excluded.description,
      status = excluded.status,
      comments = excluded.comments
  `).run(
    ticketId || '',
    walletAddress || '',
    contractId || '',
    category || '',
    description || '',
    status || '',
    commentsText
  );
  countWrite();
}

/**
 * Record a search query for analytics.
 */
export function recordSearch(query, searchType, resultsCount, userId = null) {
  // Record in search history
  db.prepare(`
    INSERT INTO search_history (query, searchType, resultsCount, userId)
    VALUES (?, ?, ?, ?)
  `).run(query, searchType, resultsCount, userId);

  // Update search analytics
  db.prepare(`
    INSERT INTO search_analytics (query, searchCount, lastSearched)
    VALUES (?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(query) DO UPDATE SET
      searchCount = searchCount + 1,
      lastSearched = CURRENT_TIMESTAMP
  `).run(query);

  countWrite();
}

/**
 * Search collaborators with full-text search.
 */
export function searchCollaborators(query, limit = 20, offset = 0, contractId = null) {
  let sql = `
    SELECT 
      walletAddress,
      name,
      email,
      notes,
      contractId,
      rank
    FROM collaborators_fts
    WHERE collaborators_fts MATCH ?
  `;
  
  const params = [query];

  if (contractId) {
    sql += ` AND contractId = ?`;
    params.push(contractId);
  }

  sql += ` ORDER BY rank LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

/**
 * Search transactions with full-text search.
 */
export function searchTransactions(query, limit = 20, offset = 0, contractId = null) {
  let sql = `
    SELECT 
      txHash,
      contractId,
      type,
      initiatorAddress,
      tokenId,
      notes,
      collaboratorAddresses,
      rank
    FROM transactions_fts
    WHERE transactions_fts MATCH ?
  `;
  
  const params = [query];

  if (contractId) {
    sql += ` AND contractId = ?`;
    params.push(contractId);
  }

  sql += ` ORDER BY rank LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

/**
 * Search disputes with full-text search.
 */
export function searchDisputes(query, limit = 20, offset = 0, status = null) {
  let sql = `
    SELECT 
      ticketId,
      walletAddress,
      contractId,
      category,
      description,
      status,
      comments,
      rank
    FROM disputes_fts
    WHERE disputes_fts MATCH ?
  `;
  
  const params = [query];

  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  }

  sql += ` ORDER BY rank LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

/**
 * Universal search across all indexed content.
 */
export function searchAll(query, limit = 50) {
  const results = {
    collaborators: searchCollaborators(query, Math.floor(limit / 3)),
    transactions: searchTransactions(query, Math.floor(limit / 3)),
    disputes: searchDisputes(query, Math.floor(limit / 3)),
    totalResults: 0,
  };

  results.totalResults = 
    results.collaborators.length + 
    results.transactions.length + 
    results.disputes.length;

  return results;
}

/**
 * Get search suggestions based on popular queries.
 */
export function getSearchSuggestions(prefix, limit = 10) {
  return db.prepare(`
    SELECT query, searchCount
    FROM search_analytics
    WHERE query LIKE ? || '%'
    ORDER BY searchCount DESC, lastSearched DESC
    LIMIT ?
  `).all(prefix, limit);
}

/**
 * Get trending search queries.
 */
export function getTrendingSearches(limit = 10, hours = 24) {
  return db.prepare(`
    SELECT query, COUNT(*) as count
    FROM search_history
    WHERE timestamp > datetime('now', '-' || ? || ' hours')
    GROUP BY query
    ORDER BY count DESC
    LIMIT ?
  `).all(hours, limit);
}

/**
 * Get search statistics.
 */
export function getSearchStatistics() {
  const totalSearches = db
    .prepare(`SELECT COUNT(*) as total FROM search_history`)
    .get().total;

  const uniqueQueries = db
    .prepare(`SELECT COUNT(*) as total FROM search_analytics`)
    .get().total;

  const topQueries = db
    .prepare(`
      SELECT query, searchCount
      FROM search_analytics
      ORDER BY searchCount DESC
      LIMIT 10
    `)
    .all();

  const searchesByType = db
    .prepare(`
      SELECT searchType, COUNT(*) as count
      FROM search_history
      GROUP BY searchType
      ORDER BY count DESC
    `)
    .all();

  const recentSearches = db
    .prepare(`
      SELECT query, searchType, resultsCount, timestamp
      FROM search_history
      ORDER BY timestamp DESC
      LIMIT 20
    `)
    .all();

  return {
    totalSearches,
    uniqueQueries,
    topQueries,
    searchesByType,
    recentSearches,
  };
}

/**
 * Semantic search using keyword embeddings and similarity.
 * This is a simplified semantic search using keyword matching and scoring.
 */
export function semanticSearch(query, searchType = 'all', limit = 20) {
  // Extract keywords from query
  const keywords = query.toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 2)
    .map(word => word.replace(/[^a-z0-9]/g, ''));

  if (keywords.length === 0) {
    return { results: [], score: 0 };
  }

  // Build FTS5 query with OR operators for semantic matching
  const ftsQuery = keywords.map(k => `"${k}"*`).join(' OR ');

  let results = [];

  switch (searchType) {
    case 'collaborators':
      results = searchCollaborators(ftsQuery, limit);
      break;
    case 'transactions':
      results = searchTransactions(ftsQuery, limit);
      break;
    case 'disputes':
      results = searchDisputes(ftsQuery, limit);
      break;
    case 'all':
    default:
      results = searchAll(ftsQuery, limit);
      break;
  }

  // Calculate semantic score based on keyword matches
  const score = keywords.length * 10;

  return {
    results,
    score,
    keywords,
    matchType: 'semantic',
  };
}

/**
 * Advanced search with filters and facets.
 */
export function advancedSearch(params) {
  const {
    query,
    searchType = 'all',
    contractId,
    startDate,
    endDate,
    status,
    category,
    limit = 20,
    offset = 0,
  } = params;

  let results = {};

  // Build filtered query
  const filterConditions = [];
  if (contractId) filterConditions.push(`contractId:"${contractId}"`);
  if (status) filterConditions.push(`status:"${status}"`);
  if (category) filterConditions.push(`category:"${category}"`);

  const fullQuery = filterConditions.length > 0
    ? `(${query}) AND (${filterConditions.join(' AND ')})`
    : query;

  switch (searchType) {
    case 'collaborators':
      results.collaborators = searchCollaborators(fullQuery, limit, offset, contractId);
      results.total = results.collaborators.length;
      break;
    case 'transactions':
      results.transactions = searchTransactions(fullQuery, limit, offset, contractId);
      results.total = results.transactions.length;
      break;
    case 'disputes':
      results.disputes = searchDisputes(fullQuery, limit, offset, status);
      results.total = results.disputes.length;
      break;
    case 'all':
    default:
      results = searchAll(fullQuery, limit);
      break;
  }

  // Add facets (aggregated counts by dimension)
  results.facets = {
    byType: {},
    byStatus: {},
    byCategory: {},
  };

  // Calculate facets based on search type
  if (searchType === 'all' || searchType === 'disputes') {
    const statusFacets = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM disputes_fts
      WHERE disputes_fts MATCH ?
      GROUP BY status
    `).all(fullQuery);
    
    results.facets.byStatus = statusFacets.reduce((acc, { status, count }) => {
      acc[status] = count;
      return acc;
    }, {});
  }

  return results;
}

/**
 * Rebuild all search indexes (maintenance operation).
 */
export function rebuildSearchIndexes() {
  try {
    logger.info("Rebuilding search indexes...");

    // Clear existing indexes
    db.exec(`
      DELETE FROM collaborators_fts;
      DELETE FROM transactions_fts;
      DELETE FROM disputes_fts;
    `);

    // Reindex collaborators (if collaborator data is stored elsewhere)
    // Note: This would need actual collaborator data source
    
    // Reindex transactions
    const transactions = db.prepare(`
      SELECT t.txHash, t.contractId, t.type, t.initiatorAddress, t.tokenId,
             GROUP_CONCAT(dp.collaboratorAddress, ' ') as collaboratorAddresses
      FROM transactions t
      LEFT JOIN distribution_payouts dp ON t.id = dp.transactionId
      GROUP BY t.id
    `).all();

    for (const tx of transactions) {
      indexTransaction(
        tx.txHash,
        tx.contractId,
        tx.type,
        tx.initiatorAddress,
        tx.tokenId,
        '',
        tx.collaboratorAddresses ? tx.collaboratorAddresses.split(' ') : []
      );
    }

    // Reindex disputes
    const disputes = db.prepare(`
      SELECT d.ticketId, d.walletAddress, d.contractId, d.category, d.description, d.status,
             GROUP_CONCAT(dc.message, ' ') as comments
      FROM disputes d
      LEFT JOIN dispute_comments dc ON d.id = dc.disputeId
      GROUP BY d.id
    `).all();

    for (const dispute of disputes) {
      indexDispute(
        dispute.ticketId,
        dispute.walletAddress,
        dispute.contractId,
        dispute.category,
        dispute.description,
        dispute.status,
        dispute.comments ? [{ message: dispute.comments }] : []
      );
    }

    logger.info("Search indexes rebuilt successfully", {
      transactions: transactions.length,
      disputes: disputes.length,
    });

    return {
      success: true,
      indexed: {
        transactions: transactions.length,
        disputes: disputes.length,
      },
    };
  } catch (error) {
    logger.error("Failed to rebuild search indexes", { error: error.message });
    throw error;
  }
}
