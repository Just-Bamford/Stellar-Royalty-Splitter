/**
 * Advanced search routes — closes #971.
 *
 * Public endpoints:
 *   GET    /api/v1/search                     — universal search across all content
 *   GET    /api/v1/search/collaborators       — search collaborators
 *   GET    /api/v1/search/transactions        — search transactions
 *   GET    /api/v1/search/disputes            — search disputes
 *   GET    /api/v1/search/suggestions         — get search suggestions
 *   GET    /api/v1/search/trending            — get trending searches
 *   GET    /api/v1/search/statistics          — search analytics
 *
 * Admin endpoints:
 *   POST   /api/v1/search/admin/rebuild       — rebuild search indexes
 */

import { Router } from "express";
import logger from "../logger.js";
import { sendError } from "../error-response.js";
import { cacheGet, cacheSet, cacheKey } from "../cache.js";
import {
  searchAll,
  searchCollaborators,
  searchTransactions,
  searchDisputes,
  semanticSearch,
  advancedSearch,
  getSearchSuggestions,
  getTrendingSearches,
  getSearchStatistics,
  rebuildSearchIndexes,
  recordSearch,
} from "../database/search.js";

export const searchRouter = Router();

// Helper to record search analytics in the background without blocking the HTTP response
function recordSearchAsync(query, type, count) {
  setImmediate(() => {
    try {
      recordSearch(query, type, count);
    } catch (err) {
      logger.warn("Asynchronous search recording failed", { error: err.message });
    }
  });
}

// ─── Admin auth middleware ────────────────────────────────────────────────────

function extractBearerToken(req) {
  const header = req.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function requireAdminToken(req, res, next) {
  const envToken = process.env.ADMIN_ROTATE_TOKEN;
  if (!envToken) {
    return sendError(res, 503, "service_unavailable", "Admin operations are not configured on this server");
  }
  const token = extractBearerToken(req);
  if (!token || token !== envToken) {
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }
  next();
}

// ─── Universal search ─────────────────────────────────────────────────────────

searchRouter.get("/", (req, res, next) => {
  try {
    const { q, query, limit, semantic, advanced } = req.query;
    const searchQuery = q || query;

    if (!searchQuery || typeof searchQuery !== 'string') {
      return sendError(res, 400, "missing_query", "Query parameter 'q' or 'query' is required");
    }

    if (searchQuery.length < 2) {
      return sendError(res, 400, "query_too_short", "Query must be at least 2 characters");
    }

    const searchLimit = Math.min(parseInt(limit) || 50, 100);
    const cKey = cacheKey("search:universal", searchQuery, searchLimit, semantic, advanced, req.query.searchType, req.query.contractId);
    const cached = cacheGet(cKey);
    if (cached) {
      return res.json(cached);
    }

    let results;

    // Advanced search with filters
    if (advanced === 'true') {
      const params = {
        query: searchQuery,
        searchType: req.query.searchType || 'all',
        contractId: req.query.contractId,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        status: req.query.status,
        category: req.query.category,
        limit: searchLimit,
        offset: parseInt(req.query.offset) || 0,
      };
      results = advancedSearch(params);
    }
    // Semantic search
    else if (semantic === 'true') {
      results = semanticSearch(searchQuery, req.query.searchType || 'all', searchLimit);
    }
    // Standard full-text search
    else {
      results = searchAll(searchQuery, searchLimit);
    }

    // Record search asynchronously for analytics without blocking response
    recordSearchAsync(searchQuery, req.query.searchType || 'all', results.totalResults || 0);

    const responsePayload = {
      success: true,
      query: searchQuery,
      data: results,
      searchMode: advanced === 'true' ? 'advanced' : semantic === 'true' ? 'semantic' : 'standard',
    };

    cacheSet(cKey, responsePayload, 30_000); // 30s TTL
    return res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// ─── Search collaborators ─────────────────────────────────────────────────────

searchRouter.get("/collaborators", (req, res, next) => {
  try {
    const { q, query, contractId, limit, offset } = req.query;
    const searchQuery = q || query;

    if (!searchQuery || typeof searchQuery !== 'string') {
      return sendError(res, 400, "missing_query", "Query parameter 'q' or 'query' is required");
    }

    const searchLimit = Math.min(parseInt(limit) || 20, 100);
    const searchOffset = parseInt(offset) || 0;

    const cKey = cacheKey("search:collaborators", searchQuery, searchLimit, searchOffset, contractId);
    const cached = cacheGet(cKey);
    if (cached) {
      return res.json(cached);
    }

    const results = searchCollaborators(searchQuery, searchLimit, searchOffset, contractId);

    // Record search in background
    recordSearchAsync(searchQuery, 'collaborators', results.length);

    const responsePayload = {
      success: true,
      query: searchQuery,
      data: results,
      count: results.length,
    };

    cacheSet(cKey, responsePayload, 30_000);
    return res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// ─── Search transactions ──────────────────────────────────────────────────────

searchRouter.get("/transactions", (req, res, next) => {
  try {
    const { q, query, contractId, limit, offset } = req.query;
    const searchQuery = q || query;

    if (!searchQuery || typeof searchQuery !== 'string') {
      return sendError(res, 400, "missing_query", "Query parameter 'q' or 'query' is required");
    }

    const searchLimit = Math.min(parseInt(limit) || 20, 100);
    const searchOffset = parseInt(offset) || 0;

    const cKey = cacheKey("search:transactions", searchQuery, searchLimit, searchOffset, contractId);
    const cached = cacheGet(cKey);
    if (cached) {
      return res.json(cached);
    }

    const results = searchTransactions(searchQuery, searchLimit, searchOffset, contractId);

    // Record search in background
    recordSearchAsync(searchQuery, 'transactions', results.length);

    const responsePayload = {
      success: true,
      query: searchQuery,
      data: results,
      count: results.length,
    };

    cacheSet(cKey, responsePayload, 30_000);
    return res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// ─── Search disputes ──────────────────────────────────────────────────────────

searchRouter.get("/disputes", (req, res, next) => {
  try {
    const { q, query, status, limit, offset } = req.query;
    const searchQuery = q || query;

    if (!searchQuery || typeof searchQuery !== 'string') {
      return sendError(res, 400, "missing_query", "Query parameter 'q' or 'query' is required");
    }

    const searchLimit = Math.min(parseInt(limit) || 20, 100);
    const searchOffset = parseInt(offset) || 0;

    const cKey = cacheKey("search:disputes", searchQuery, searchLimit, searchOffset, status);
    const cached = cacheGet(cKey);
    if (cached) {
      return res.json(cached);
    }

    const results = searchDisputes(searchQuery, searchLimit, searchOffset, status);

    // Record search in background
    recordSearchAsync(searchQuery, 'disputes', results.length);

    const responsePayload = {
      success: true,
      query: searchQuery,
      data: results,
      count: results.length,
    };

    cacheSet(cKey, responsePayload, 30_000);
    return res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// ─── Get search suggestions ───────────────────────────────────────────────────

searchRouter.get("/suggestions", (req, res, next) => {
  try {
    const { q, query, limit } = req.query;
    const prefix = q || query || '';

    if (!prefix || prefix.length < 2) {
      return res.json({ success: true, data: [] });
    }

    const searchLimit = Math.min(parseInt(limit) || 10, 20);
    const cKey = cacheKey("search:suggestions", prefix, searchLimit);
    const cached = cacheGet(cKey);
    if (cached) {
      return res.json(cached);
    }

    const suggestions = getSearchSuggestions(prefix, searchLimit);

    const responsePayload = {
      success: true,
      prefix,
      data: suggestions,
    };

    cacheSet(cKey, responsePayload, 60_000);
    return res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// ─── Get trending searches ────────────────────────────────────────────────────

searchRouter.get("/trending", (req, res, next) => {
  try {
    const { limit, hours } = req.query;

    const searchLimit = Math.min(parseInt(limit) || 10, 20);
    const timeHours = Math.min(parseInt(hours) || 24, 168); // Max 7 days

    const cKey = cacheKey("search:trending", searchLimit, timeHours);
    const cached = cacheGet(cKey);
    if (cached) {
      return res.json(cached);
    }

    const trending = getTrendingSearches(searchLimit, timeHours);

    const responsePayload = {
      success: true,
      data: trending,
      timeframe: `${timeHours} hours`,
    };

    cacheSet(cKey, responsePayload, 60_000);
    return res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// ─── Get search statistics ────────────────────────────────────────────────────

searchRouter.get("/statistics", (req, res, next) => {
  try {
    const cKey = cacheKey("search:statistics");
    const cached = cacheGet(cKey);
    if (cached) {
      return res.json(cached);
    }

    const statistics = getSearchStatistics();

    const responsePayload = {
      success: true,
      data: statistics,
    };

    cacheSet(cKey, responsePayload, 60_000);
    return res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// ─── Admin: Rebuild search indexes ────────────────────────────────────────────

searchRouter.post("/admin/rebuild", requireAdminToken, async (req, res, next) => {
  try {
    logger.info("Starting search index rebuild", { admin: true });

    const result = rebuildSearchIndexes();

    logger.info("Search index rebuild completed", result);

    return res.json({
      success: true,
      data: result,
      message: "Search indexes rebuilt successfully",
    });
  } catch (err) {
    next(err);
  }
});
