/**
 * Tests for universal search endpoint pagination — closes #1336.
 */

import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db } from "../src/database/core.js";
import {
  initializeSearchTables,
  indexCollaborator,
  indexTransaction,
  indexDispute,
} from "../src/database/search.js";

// Import the express app
let app;

beforeAll(async () => {
  // Initialize search tables
  initializeSearchTables();

  // Seed test data for pagination testing
  // Create 150 collaborators
  for (let i = 1; i <= 150; i++) {
    indexCollaborator(
      `WALLET_${i.toString().padStart(3, '0')}`,
      `Test Collaborator ${i}`,
      `collaborator${i}@example.com`,
      `Test notes for collaborator ${i}`,
      `CONTRACT_TEST`
    );
  }

  // Create 150 transactions
  for (let i = 1; i <= 150; i++) {
    indexTransaction(
      `TXHASH_${i.toString().padStart(3, '0')}`,
      `CONTRACT_TEST`,
      'distribution',
      `INITIATOR_${i}`,
      `TOKEN_${i}`,
      `Test transaction ${i}`,
      [`WALLET_${i}`]
    );
  }

  // Create 150 disputes
  for (let i = 1; i <= 150; i++) {
    indexDispute(
      `TICKET_${i.toString().padStart(3, '0')}`,
      `WALLET_${i}`,
      `CONTRACT_TEST`,
      'payment',
      `Test dispute ${i}`,
      'open',
      [{ message: `Test comment ${i}` }]
    );
  }

  // Import app after database is ready
  const appModule = await import("../tests/app.js");
  app = appModule.default;
});

afterAll(() => {
  // Clean up
  db.exec(`
    DELETE FROM collaborators_fts;
    DELETE FROM transactions_fts;
    DELETE FROM disputes_fts;
    DELETE FROM search_history;
    DELETE FROM search_analytics;
  `);
});

describe("GET /api/v1/search - Universal search pagination", () => {
  it("should return first page of results with default offset", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test", limit: 50 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.offset).toBe(0);
    expect(res.body.limit).toBe(50);
    expect(res.body).toHaveProperty('totalResults');
    expect(res.body.data).toHaveProperty('collaborators');
    expect(res.body.data).toHaveProperty('transactions');
    expect(res.body.data).toHaveProperty('disputes');
  });

  it("should return second page of results with offset=50", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test", limit: 50, offset: 50 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.offset).toBe(50);
    expect(res.body.limit).toBe(50);
    expect(res.body).toHaveProperty('totalResults');
  });

  it("should include pagination metadata in response", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Collaborator", limit: 30, offset: 20 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('offset', 20);
    expect(res.body).toHaveProperty('limit', 30);
    expect(res.body).toHaveProperty('totalResults');
    expect(typeof res.body.totalResults).toBe('number');
  });

  it("should respect limit cap of 100", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test", limit: 200, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
  });

  it("should handle offset beyond total results", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test", limit: 50, offset: 10000 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.offset).toBe(10000);
  });

  it("should default offset to 0 when not provided", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test", limit: 20 });

    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(0);
  });

  it("should handle non-numeric offset gracefully", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test", limit: 20, offset: "invalid" });

    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(0); // Should default to 0
  });

  it("should handle negative offset gracefully", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test", limit: 20, offset: -10 });

    expect(res.status).toBe(200);
    // Should either reject or convert to 0
    expect(res.body).toHaveProperty('offset');
  });
});

describe("GET /api/v1/search - Semantic search with offset", () => {
  it("should support offset in semantic search mode", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test", semantic: "true", limit: 30, offset: 15 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.searchMode).toBe('semantic');
    expect(res.body.offset).toBe(15);
    expect(res.body.limit).toBe(30);
    expect(res.body).toHaveProperty('totalResults');
  });

  it("should return semantic results with pagination metadata", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Collaborator transaction", semantic: "true", limit: 20, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.searchMode).toBe('semantic');
    expect(res.body).toHaveProperty('offset', 0);
    expect(res.body).toHaveProperty('limit', 20);
  });
});

describe("GET /api/v1/search - Advanced search with offset", () => {
  it("should support offset in advanced search mode", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({
        q: "Test",
        advanced: "true",
        searchType: "all",
        limit: 25,
        offset: 10,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.searchMode).toBe('advanced');
    expect(res.body.offset).toBe(10);
    expect(res.body.limit).toBe(25);
  });

  it("should support offset with advanced filters", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({
        q: "Test",
        advanced: "true",
        searchType: "disputes",
        status: "open",
        limit: 20,
        offset: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body.searchMode).toBe('advanced');
    expect(res.body.offset).toBe(5);
  });
});

describe("GET /api/v1/search - Cache behavior with offset", () => {
  it("should cache results separately for different offsets", async () => {
    // First request with offset=0
    const res1 = await request(app)
      .get("/api/v1/search")
      .query({ q: "UniqueQuery123", limit: 20, offset: 0 });

    expect(res1.status).toBe(200);
    expect(res1.body.offset).toBe(0);

    // Second request with offset=20 should not return cached results from offset=0
    const res2 = await request(app)
      .get("/api/v1/search")
      .query({ q: "UniqueQuery123", limit: 20, offset: 20 });

    expect(res2.status).toBe(200);
    expect(res2.body.offset).toBe(20);
    // The offset should be different, proving different cache keys
    expect(res2.body.offset).not.toBe(res1.body.offset);
  });
});

describe("GET /api/v1/search - Backward compatibility", () => {
  it("should work without offset parameter (backward compatibility)", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.offset).toBe(0);
    expect(res.body).toHaveProperty('totalResults');
  });

  it("should return consistent results structure with or without offset", async () => {
    const resWithoutOffset = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test", limit: 30 });

    const resWithOffset = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test", limit: 30, offset: 0 });

    expect(resWithoutOffset.status).toBe(200);
    expect(resWithOffset.status).toBe(200);
    
    // Both should have the same structure
    expect(resWithoutOffset.body).toHaveProperty('success');
    expect(resWithoutOffset.body).toHaveProperty('data');
    expect(resWithoutOffset.body).toHaveProperty('offset');
    expect(resWithoutOffset.body).toHaveProperty('limit');
    expect(resWithoutOffset.body).toHaveProperty('totalResults');
    
    expect(resWithOffset.body).toHaveProperty('success');
    expect(resWithOffset.body).toHaveProperty('data');
    expect(resWithOffset.body).toHaveProperty('offset');
    expect(resWithOffset.body).toHaveProperty('limit');
    expect(resWithOffset.body).toHaveProperty('totalResults');
  });
});

describe("GET /api/v1/search - Edge cases", () => {
  it("should handle offset=0 explicitly", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "Test", limit: 25, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(0);
  });

  it("should still require query parameter", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ limit: 50, offset: 10 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('missing_query');
  });

  it("should validate query length even with offset", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .query({ q: "a", limit: 20, offset: 10 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('query_too_short');
  });
});
