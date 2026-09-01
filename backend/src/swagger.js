/**
 * OpenAPI 3.0 specification for the Stellar Royalty Splitter API (#587).
 *
 * Served at GET /api/docs (Swagger UI) and GET /api/docs/json (raw spec).
 */

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Stellar Royalty Splitter API",
    version: "1.0.0",
    description:
      "HTTP API for managing royalty distribution smart contracts on the Stellar/Soroban network.",
    contact: { url: "https://github.com/Just-Bamford/Stellar-Royalty-Splitter" },
  },
  servers: [
    { url: "/api/v1", description: "Current version (v1)" },
    { url: "/api", description: "Legacy (deprecated) — redirects to /api/v1 with HTTP 308" },
    { url: "/admin", description: "Admin operations — unversioned, mounted outside /api/v1" },
  ],
  tags: [
    { name: "Version", description: "API version discovery" },
    { name: "Health", description: "Operational health probes" },
    { name: "Contract", description: "Contract initialization and state" },
    { name: "Distribution", description: "Royalty distribution transactions" },
    { name: "Collaborators", description: "On-chain collaborator shares" },
    { name: "Analytics", description: "Earnings analytics and trends" },
    { name: "Ranking", description: "Contributor performance rankings (#586)" },
    { name: "History", description: "Transaction history and audit log" },
    { name: "Webhooks", description: "Distribution completion webhooks" },
    { name: "Admin", description: "Admin operations (requires auth)" },
    { name: "Communications", description: "Contributor communication history (#612)" },
    { name: "CSV Import", description: "Bulk collaborator import from CSV" },
    { name: "Disputes", description: "Contributor dispute tickets (#607)" },
    { name: "Earnings History", description: "Per-contributor earnings history across contracts" },
    { name: "Email Digest", description: "Weekly email digest subscriptions" },
    { name: "Metrics", description: "Prometheus metrics endpoint" },
    { name: "Notifications", description: "In-app and system notifications" },
    { name: "Onboarding", description: "Contributor onboarding checklist" },
    { name: "Payment Holds", description: "Admin holds on pending payment transactions" },
    { name: "Preferences", description: "Contributor payment preferences (#584)" },
    { name: "Referrals", description: "Contributor referral tracking (#603)" },
    { name: "Secondary Royalties", description: "Secondary-sale (resale) royalty tracking" },
    { name: "Simulation", description: "Dry-run simulation of distribute transactions" },
    { name: "Snapshots", description: "Point-in-time contract state snapshots (#613)" },
    { name: "Tiers", description: "Contributor tier assignments (#589)" },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "RBAC API key. Grants elevated rate limits and role-based access.",
      },
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Admin bearer token (ADMIN_ROTATE_TOKEN) for key-rotation and user management.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string", example: "not_found" },
          message: { type: "string", example: "Contract not found" },
        },
      },
      StellarAddress: {
        type: "string",
        pattern: "^G[A-Z2-7]{55}$",
        example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      },
      ContractId: {
        type: "string",
        pattern: "^C[A-Z2-7]{55}$",
        example: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      },
      TransactionResponse: {
        type: "object",
        properties: {
          xdr: { type: "string", description: "Base64-encoded unsigned transaction XDR" },
          transactionId: { type: "integer" },
        },
      },
      RankingEntry: {
        type: "object",
        properties: {
          rank: { type: "integer" },
          address: { $ref: "#/components/schemas/StellarAddress" },
          totalEarned: { type: "number" },
          payoutCount: { type: "integer" },
          avgPayout: { type: "number" },
        },
      },
      ContractState: {
        type: "object",
        properties: {
          contractId: { $ref: "#/components/schemas/ContractId" },
          adminAddress: { $ref: "#/components/schemas/StellarAddress" },
          royaltyRate: { type: "integer", description: "Basis points" },
          recipients: {
            type: "array",
            items: {
              type: "object",
              properties: {
                address: { $ref: "#/components/schemas/StellarAddress" },
                basisPoints: { type: "integer" },
              },
            },
          },
          balance: { type: "string", description: "i128 token balance as a decimal string" },
          tokenId: { $ref: "#/components/schemas/ContractId" },
          network: { type: "string", example: "Testnet" },
        },
      },
      Dispute: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          walletAddress: { $ref: "#/components/schemas/StellarAddress" },
          contractId: { $ref: "#/components/schemas/ContractId" },
          category: { type: "string", enum: ["wrong_amount", "missing_payment", "other"] },
          description: { type: "string" },
          status: { type: "string", enum: ["open", "under_review", "resolved", "closed"] },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      DisputeComment: {
        type: "object",
        properties: {
          id: { type: "integer" },
          author: { type: "string", enum: ["contributor", "admin"] },
          message: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Referral: {
        type: "object",
        properties: {
          referralCode: { type: "string", example: "REF-3A9F21B04C7E" },
          referrerAddress: { $ref: "#/components/schemas/StellarAddress" },
          referredAddress: { $ref: "#/components/schemas/StellarAddress" },
          status: { type: "string", enum: ["pending", "active", "bonus_paid"] },
          referralUrl: { type: "string" },
        },
      },
      Snapshot: {
        type: "object",
        properties: {
          id: { type: "integer" },
          contractId: { $ref: "#/components/schemas/ContractId" },
          label: { type: "string" },
          collaborators: { type: "string", description: "JSON-encoded collaborator list" },
          shares: { type: "string", description: "JSON-encoded share map" },
          balances: { type: "string", description: "JSON-encoded balances" },
          transactionCount: { type: "integer" },
          createdBy: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      OnboardingItem: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          completed: { type: "boolean" },
          required: { type: "boolean" },
          category: { type: "string" },
        },
      },
      OnboardingSummary: {
        type: "object",
        properties: {
          walletAddress: { $ref: "#/components/schemas/StellarAddress" },
          email: { type: "string" },
          kycStatus: { type: "string", enum: ["unverified", "pending", "verified"] },
          payoutToken: { type: "string" },
          paymentPreferencesSet: { type: "boolean" },
          taxInfoSubmitted: { type: "boolean" },
          items: { type: "array", items: { $ref: "#/components/schemas/OnboardingItem" } },
          completedCount: { type: "integer" },
          totalCount: { type: "integer" },
          completionPercentage: { type: "integer" },
          requiredComplete: { type: "boolean" },
          actionsLocked: { type: "boolean" },
          nextStep: {
            type: "object",
            nullable: true,
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
            },
          },
        },
      },
      NotificationPreference: {
        type: "object",
        properties: {
          walletAddress: { $ref: "#/components/schemas/StellarAddress" },
          email_enabled: { type: "boolean" },
          in_app_enabled: { type: "boolean" },
          sms_enabled: { type: "boolean" },
          notify_distribution: { type: "boolean" },
          notify_payment: { type: "boolean" },
          notify_failure: { type: "boolean" },
          notify_hold: { type: "boolean" },
        },
      },
      PaymentHold: {
        type: "object",
        properties: {
          transactionId: { type: "integer" },
          contractId: { $ref: "#/components/schemas/ContractId" },
          holdReason: { type: "string" },
          holdUntil: { type: "string", format: "date-time", nullable: true },
          status: { type: "string", enum: ["active", "released"] },
          placedBy: { type: "string" },
        },
      },
    },
  },
  paths: {
    "/version": {
      get: {
        tags: ["Version"],
        summary: "API version discovery",
        description:
          "Returns the current API version, list of supported versions, deprecated versions, and a link to documentation. " +
          "Legacy routes under `/api/*` (without the version prefix) redirect permanently (HTTP 308) to `/api/v1/*` " +
          "and include `Deprecation: true` and `Link` headers pointing to the canonical versioned URL. " +
          "All `/api/v1/*` responses include an `X-API-Version: v1` header.",
        responses: {
          200: {
            description: "Version information",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    data: {
                      type: "object",
                      properties: {
                        current: { type: "string", example: "v1" },
                        supported: { type: "array", items: { type: "string" }, example: ["v1"] },
                        deprecated: { type: "array", items: { type: "string" }, example: [] },
                        sunset: { type: "string", nullable: true, example: null },
                        documentation: { type: "string", example: "/api/docs" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        description: "Returns backend and Stellar connectivity status. Cached for 30 s.",
        responses: {
          200: {
            description: "Service healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    dbVersion: { type: "integer" },
                    network: { type: "string", example: "Testnet" },
                    horizon: {
                      type: "object",
                      properties: {
                        connected: { type: "boolean" },
                        url: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/initialize": {
      post: {
        tags: ["Contract"],
        summary: "Build initialize transaction XDR",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["contractId", "walletAddress", "collaborators", "shares"],
                properties: {
                  contractId: { $ref: "#/components/schemas/ContractId" },
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  collaborators: {
                    type: "array",
                    items: { $ref: "#/components/schemas/StellarAddress" },
                    minItems: 1,
                    maxItems: 20,
                  },
                  shares: {
                    type: "array",
                    items: { type: "integer", minimum: 0, maximum: 10000 },
                    description: "Basis points per collaborator (must sum to 10000)",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "XDR built", content: { "application/json": { schema: { $ref: "#/components/schemas/TransactionResponse" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          413: { description: "Payload too large" },
        },
      },
    },
    "/distribute": {
      post: {
        tags: ["Distribution"],
        summary: "Build distribute transaction XDR",
        parameters: [
          {
            in: "header",
            name: "Idempotency-Key",
            schema: { type: "string", maxLength: 255 },
            description: "Prevent duplicate submissions within 24 h",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["contractId", "walletAddress", "tokenId"],
                properties: {
                  contractId: { $ref: "#/components/schemas/ContractId" },
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  tokenId: { $ref: "#/components/schemas/ContractId" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "XDR built", content: { "application/json": { schema: { $ref: "#/components/schemas/TransactionResponse" } } } },
          400: { description: "Validation error" },
          409: { description: "Idempotency key conflict" },
        },
      },
    },
    "/collaborators/{contractId}": {
      get: {
        tags: ["Collaborators"],
        summary: "Get on-chain collaborator shares",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        responses: {
          200: {
            description: "Collaborator list",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      address: { $ref: "#/components/schemas/StellarAddress" },
                      basisPoints: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/analytics/{contractId}": {
      get: {
        tags: ["Analytics"],
        summary: "Get earnings analytics for a contract",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "start", schema: { type: "string", format: "date" }, description: "Start date (YYYY-MM-DD, default: 90 days ago)" },
          { in: "query", name: "end", schema: { type: "string", format: "date" }, description: "End date (YYYY-MM-DD, default: today)" },
        ],
        responses: {
          200: {
            description: "Analytics data",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    summary: {
                      type: "object",
                      properties: {
                        totalTransactions: { type: "integer" },
                        totalDistributed: { type: "number" },
                        averagePayout: { type: "number" },
                      },
                    },
                    trends: { type: "array", items: { type: "object" } },
                    topEarners: { type: "array", items: { $ref: "#/components/schemas/RankingEntry" } },
                    collaboratorStats: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/ranking": {
      get: {
        tags: ["Ranking"],
        summary: "Global contributor performance ranking",
        description: "Ranks contributors by earnings across all contracts.",
        parameters: [
          { in: "query", name: "metric", schema: { type: "string", enum: ["totalEarned", "payoutCount", "avgPayout"] }, description: "Ranking metric (default: totalEarned)" },
          { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 }, description: "Number of results (default: 10)" },
          { in: "query", name: "start", schema: { type: "string", format: "date" } },
          { in: "query", name: "end", schema: { type: "string", format: "date" } },
        ],
        responses: {
          200: {
            description: "Global rankings",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    scope: { type: "string", example: "global" },
                    metric: { type: "string" },
                    period: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } } },
                    rankings: { type: "array", items: { $ref: "#/components/schemas/RankingEntry" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/ranking/{contractId}": {
      get: {
        tags: ["Ranking"],
        summary: "Contract-scoped contributor performance ranking",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "metric", schema: { type: "string", enum: ["totalEarned", "payoutCount", "avgPayout"] } },
          { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { in: "query", name: "start", schema: { type: "string", format: "date" } },
          { in: "query", name: "end", schema: { type: "string", format: "date" } },
        ],
        responses: {
          200: {
            description: "Contract rankings",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    contractId: { $ref: "#/components/schemas/ContractId" },
                    metric: { type: "string" },
                    period: { type: "object" },
                    rankings: { type: "array", items: { $ref: "#/components/schemas/RankingEntry" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/history/{contractId}": {
      get: {
        tags: ["History"],
        summary: "Transaction history for a contract",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "page", schema: { type: "integer", minimum: 1 } },
          { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
        ],
        responses: { 200: { description: "Transaction list" } },
      },
    },
    "/webhooks": {
      post: {
        tags: ["Webhooks"],
        summary: "Register a webhook",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["contractId", "url"],
                properties: {
                  contractId: { $ref: "#/components/schemas/ContractId" },
                  url: { type: "string", format: "uri" },
                },
              },
            },
          },
        },
        responses: { 201: { description: "Webhook registered" } },
      },
    },

    // ── Contract state (added for #695) ─────────────────────────────────────

    "/contract/state": {
      get: {
        tags: ["Contract"],
        summary: "Read live contract state via simulation",
        description: "Reads admin, royalty rate, recipients, and token balance directly from the chain. Cached for 30 s per (contractId, tokenId) pair.",
        parameters: [
          { in: "query", name: "contractId", schema: { $ref: "#/components/schemas/ContractId" }, description: "Defaults to the server-configured contract if omitted" },
          { in: "query", name: "tokenId", schema: { $ref: "#/components/schemas/ContractId" }, description: "Defaults to the server-configured token if omitted" },
        ],
        responses: {
          200: { description: "Contract state", content: { "application/json": { schema: { $ref: "#/components/schemas/ContractState" } } } },
          400: { description: "Missing contractId/tokenId with no default configured, or simulation failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/contract/info": {
      get: {
        tags: ["Contract"],
        summary: "Read live contract state (without network passphrase)",
        parameters: [
          { in: "query", name: "contractId", schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "tokenId", schema: { $ref: "#/components/schemas/ContractId" } },
        ],
        responses: {
          200: { description: "Contract info", content: { "application/json": { schema: { $ref: "#/components/schemas/ContractState" } } } },
          400: { description: "Missing required params or simulation failed" },
        },
      },
    },
    "/contract/status/{contractId}": {
      get: {
        tags: ["Contract"],
        summary: "Check whether a contract has been initialized",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        responses: {
          200: {
            description: "Initialization status",
            content: { "application/json": { schema: { type: "object", properties: { initialized: { type: "boolean" } } } } },
          },
        },
      },
    },
    "/contract/balance/{contractId}": {
      get: {
        tags: ["Contract"],
        summary: "Get the contract's token balance via simulation",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "tokenId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
        ],
        responses: {
          200: { description: "Balance", content: { "application/json": { schema: { type: "object", properties: { balance: { type: "string" } } } } } },
          400: { description: "Missing tokenId or simulation failed" },
        },
      },
    },
    "/contract/collaborator-count/{contractId}": {
      get: {
        tags: ["Contract"],
        summary: "Get the number of collaborators via simulation",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        responses: {
          200: {
            description: "Collaborator count",
            content: { "application/json": { schema: { type: "object", properties: { contractId: { $ref: "#/components/schemas/ContractId" }, count: { type: "integer" } } } } },
          },
        },
      },
    },
    "/contract/shares-total/{contractId}": {
      get: {
        tags: ["Contract"],
        summary: "Get the sum of all collaborator shares via simulation",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        responses: {
          200: {
            description: "Total shares",
            content: { "application/json": { schema: { type: "object", properties: { contractId: { $ref: "#/components/schemas/ContractId" }, totalShares: { type: "integer" } } } } },
          },
        },
      },
    },
    "/contract/version/{contractId}": {
      get: {
        tags: ["Contract"],
        summary: "Get the on-chain contract version via simulation",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        responses: {
          200: {
            description: "Contract version",
            content: { "application/json": { schema: { type: "object", properties: { contractId: { $ref: "#/components/schemas/ContractId" }, version: { type: "string" } } } } },
          },
          404: { description: "Contract not initialized, or version unavailable", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Simulation (added for #695) ─────────────────────────────────────────

    "/simulate": {
      post: {
        tags: ["Simulation"],
        summary: "Dry-run a distribute transaction",
        description: "Simulates the on-chain `distribute` call without submitting it. Returns the estimated fee, recipient amounts (parsed from simulated `dist` events), and any contract error — without ever throwing on a simulation failure.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["contractId", "walletAddress", "tokenId"],
                properties: {
                  contractId: { $ref: "#/components/schemas/ContractId" },
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  tokenId: { $ref: "#/components/schemas/ContractId" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Simulation result (200 even when the simulated call itself would fail on-chain — check contractError)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    fee: { oneOf: [{ type: "integer" }, { type: "string" }], description: "Estimated resource fee" },
                    recipientAmounts: {
                      type: "array",
                      items: { type: "object", properties: { address: { $ref: "#/components/schemas/StellarAddress" }, amount: { type: "string" } } },
                    },
                    contractError: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          400: { description: "Validation error" },
        },
      },
    },

    // ── Secondary royalties (added for #695) ────────────────────────────────

    "/secondary-royalty/pool/{contractId}": {
      get: {
        tags: ["Secondary Royalties"],
        summary: "Get the current secondary royalty pool balance",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        responses: { 200: { description: "Pool balance" } },
      },
    },
    "/secondary-royalty": {
      post: {
        tags: ["Secondary Royalties"],
        summary: "Record a secondary (resale) sale and build the on-chain record transaction",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["contractId", "walletAddress", "nftId", "previousOwner", "newOwner", "salePrice", "saleToken", "royaltyRate"],
                properties: {
                  contractId: { $ref: "#/components/schemas/ContractId" },
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  nftId: { type: "string", minLength: 1 },
                  previousOwner: { $ref: "#/components/schemas/StellarAddress" },
                  newOwner: { $ref: "#/components/schemas/StellarAddress" },
                  salePrice: { type: "integer", minimum: 1 },
                  saleToken: { $ref: "#/components/schemas/ContractId" },
                  royaltyRate: { type: "integer", minimum: 0, maximum: 10000, description: "Basis points" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Sale recorded and transaction built",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    xdr: { type: "string" },
                    transactionId: { type: "integer" },
                    royaltyAmount: { type: "integer" },
                    royaltyRateUsed: { type: "integer" },
                  },
                },
              },
            },
          },
          400: { description: "Validation error, non-positive sale price, or out-of-range royalty rate" },
          409: { description: "This sale has already been recorded" },
        },
      },
    },
    "/secondary-royalty/set-rate": {
      post: {
        tags: ["Secondary Royalties"],
        summary: "Build a transaction to set the on-chain secondary royalty rate",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["contractId", "walletAddress", "royaltyRate"],
                properties: {
                  contractId: { $ref: "#/components/schemas/ContractId" },
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  royaltyRate: { type: "integer", minimum: 0, maximum: 10000 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "XDR built", content: { "application/json": { schema: { $ref: "#/components/schemas/TransactionResponse" } } } },
          400: { description: "Validation error or out-of-range royalty rate" },
        },
      },
    },
    "/secondary-royalty/rate/{contractId}": {
      get: {
        tags: ["Secondary Royalties"],
        summary: "Get the current on-chain secondary royalty rate",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        responses: {
          200: { description: "Royalty rate", content: { "application/json": { schema: { type: "object", properties: { contractId: { $ref: "#/components/schemas/ContractId" }, royaltyRate: { type: "integer" } } } } } },
        },
      },
    },
    "/secondary-royalty/distribute": {
      post: {
        tags: ["Secondary Royalties"],
        summary: "Build a transaction to distribute accumulated secondary royalties",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["contractId", "walletAddress", "tokenId"],
                properties: {
                  contractId: { $ref: "#/components/schemas/ContractId" },
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  tokenId: { $ref: "#/components/schemas/ContractId" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "XDR built for the pending sales, which are marked distributed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { xdr: { type: "string" }, transactionId: { type: "integer" }, numberOfSales: { type: "integer" }, totalRoyalties: { type: "string" } },
                },
              },
            },
          },
          400: { description: "No pending secondary royalties to distribute" },
        },
      },
    },
    "/secondary-royalty/stats/{contractId}": {
      get: {
        tags: ["Secondary Royalties"],
        summary: "Get secondary royalty statistics for a contract",
        description: "Cached in-memory for 60 s.",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        responses: { 200: { description: "Royalty statistics" } },
      },
    },
    "/secondary-royalty/sales/{contractId}": {
      get: {
        tags: ["Secondary Royalties"],
        summary: "List secondary sales for a contract",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "limit", schema: { type: "integer" } },
          { in: "query", name: "offset", schema: { type: "integer" } },
          { in: "query", name: "nftId", schema: { type: "string" } },
          { in: "query", name: "startDate", schema: { type: "string", format: "date-time" } },
          { in: "query", name: "endDate", schema: { type: "string", format: "date-time" } },
        ],
        responses: {
          200: { description: "Sales list", content: { "application/json": { schema: { type: "object", properties: { sales: { type: "array", items: { type: "object" } }, total: { type: "integer" } } } } } },
          400: { description: "Invalid date range" },
        },
      },
    },
    "/secondary-royalty/distributions/{contractId}": {
      get: {
        tags: ["Secondary Royalties"],
        summary: "List secondary royalty distributions for a contract",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "limit", schema: { type: "integer" } },
          { in: "query", name: "offset", schema: { type: "integer" } },
        ],
        responses: { 200: { description: "Distributions list" } },
      },
    },

    // ── Disputes (added for #695) ───────────────────────────────────────────

    "/disputes": {
      post: {
        tags: ["Disputes"],
        summary: "Submit a new dispute",
        description: "No auth required — the wallet address is the contributor's identity.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["walletAddress", "category", "description"],
                properties: {
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  contractId: { $ref: "#/components/schemas/ContractId" },
                  category: { type: "string", enum: ["wrong_amount", "missing_payment", "other"] },
                  description: { type: "string", minLength: 10, maxLength: 2000 },
                  email: { type: "string", format: "email", description: "Optional — used only to send a confirmation email" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Dispute created", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/Dispute" } } } } } },
          400: { description: "Validation error" },
        },
      },
      get: {
        tags: ["Disputes"],
        summary: "List disputes for a wallet",
        parameters: [
          { in: "query", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } },
          { in: "query", name: "limit", schema: { type: "integer" } },
          { in: "query", name: "offset", schema: { type: "integer" } },
        ],
        responses: {
          200: { description: "Disputes list", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "array", items: { $ref: "#/components/schemas/Dispute" } }, pagination: { type: "object" } } } } } },
          400: { description: "Missing or invalid walletAddress" },
        },
      },
    },
    "/disputes/{ticketId}": {
      get: {
        tags: ["Disputes"],
        summary: "Get a single dispute with comments",
        parameters: [{ in: "path", name: "ticketId", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Dispute detail", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/Dispute" } } } } } },
          404: { description: "Dispute not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/disputes/{ticketId}/comments": {
      post: {
        tags: ["Disputes"],
        summary: "Add a contributor comment to a dispute",
        parameters: [{ in: "path", name: "ticketId", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["walletAddress", "message"],
                properties: {
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  message: { type: "string", minLength: 1, maxLength: 2000 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Comment added", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/DisputeComment" } } } } } },
          403: { description: "Not the dispute's owning wallet" },
          404: { description: "Dispute not found" },
          409: { description: "Dispute is resolved or closed — no further comments accepted" },
        },
      },
    },
    "/disputes/admin/all": {
      get: {
        tags: ["Disputes"],
        summary: "List all disputes (admin)",
        security: [{ BearerAuth: [] }],
        parameters: [
          { in: "query", name: "status", schema: { type: "string", enum: ["open", "under_review", "resolved", "closed"] } },
          { in: "query", name: "limit", schema: { type: "integer" } },
          { in: "query", name: "offset", schema: { type: "integer" } },
        ],
        responses: {
          200: { description: "All disputes" },
          401: { description: "Unauthorized" },
        },
      },
    },
    "/disputes/admin/{ticketId}/status": {
      patch: {
        tags: ["Disputes"],
        summary: "Update a dispute's status (admin)",
        security: [{ BearerAuth: [] }],
        parameters: [{ in: "path", name: "ticketId", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["status"],
                properties: {
                  status: { type: "string", enum: ["open", "under_review", "resolved", "closed"] },
                  adminNote: { type: "string", maxLength: 2000 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Status updated" },
          401: { description: "Unauthorized" },
          404: { description: "Dispute not found" },
        },
      },
    },
    "/disputes/admin/{ticketId}/comments": {
      post: {
        tags: ["Disputes"],
        summary: "Post an admin comment on a dispute",
        security: [{ BearerAuth: [] }],
        parameters: [{ in: "path", name: "ticketId", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["message"], properties: { message: { type: "string", minLength: 1, maxLength: 2000 } } } } },
        },
        responses: {
          201: { description: "Comment added", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/DisputeComment" } } } } } },
          401: { description: "Unauthorized" },
          404: { description: "Dispute not found" },
        },
      },
    },

    // ── Referrals (added for #695) ──────────────────────────────────────────

    "/referrals/link": {
      post: {
        tags: ["Referrals"],
        summary: "Generate (or retrieve) a referral link for a wallet",
        description: "Idempotent — returns the existing code if the wallet already has one.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["walletAddress"], properties: { walletAddress: { $ref: "#/components/schemas/StellarAddress" } } } } },
        },
        responses: {
          201: { description: "Referral link", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/Referral" } } } } } },
        },
      },
    },
    "/referrals/link/{walletAddress}": {
      get: {
        tags: ["Referrals"],
        summary: "Get the existing referral link for a wallet",
        parameters: [{ in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } }],
        responses: {
          200: { description: "Referral link", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/Referral" } } } } } },
          404: { description: "No referral link found for this wallet yet" },
        },
      },
    },
    "/referrals/register": {
      post: {
        tags: ["Referrals"],
        summary: "Register a new contributor via a referral code",
        description: "Records the referral in `pending` status.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["referralCode", "referredAddress"],
                properties: {
                  referralCode: { type: "string", example: "REF-3A9F21B04C7E" },
                  referredAddress: { $ref: "#/components/schemas/StellarAddress" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Referral registered", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/Referral" } } } } } },
        },
      },
    },
    "/referrals/dashboard/{walletAddress}": {
      get: {
        tags: ["Referrals"],
        summary: "Get referral dashboard stats for a referrer",
        parameters: [
          { in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } },
          { in: "query", name: "limit", schema: { type: "integer" } },
          { in: "query", name: "offset", schema: { type: "integer" } },
        ],
        responses: { 200: { description: "Dashboard stats, referral counts by status, referral link, and bonus totals" } },
      },
    },
    "/referrals/mine/{walletAddress}": {
      get: {
        tags: ["Referrals"],
        summary: "List referrals made by a wallet",
        parameters: [
          { in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } },
          { in: "query", name: "limit", schema: { type: "integer" } },
          { in: "query", name: "offset", schema: { type: "integer" } },
        ],
        responses: { 200: { description: "Referrals list" } },
      },
    },
    "/referrals/status/{walletAddress}": {
      get: {
        tags: ["Referrals"],
        summary: "Check whether a wallet was referred, and by whom",
        parameters: [{ in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } }],
        responses: {
          200: {
            description: "Referral status",
            content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "object", properties: { wasReferred: { type: "boolean" }, referral: { $ref: "#/components/schemas/Referral" } } } } } } },
          },
        },
      },
    },
    "/referrals/admin/activate": {
      post: {
        tags: ["Referrals"],
        summary: "Activate a referral and award the default (or custom) bonus",
        security: [{ BearerAuth: [] }],
        description: "Idempotent — no duplicate bonus is awarded if already active.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["referredAddress"],
                properties: {
                  referredAddress: { $ref: "#/components/schemas/StellarAddress" },
                  bonusAmountStroops: { type: "integer", minimum: 1 },
                  reason: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Referral activated" },
          401: { description: "Unauthorized" },
        },
      },
    },
    "/referrals/admin/bonus": {
      post: {
        tags: ["Referrals"],
        summary: "Manually award an extra referral bonus",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["referralId", "referrerAddress", "bonusAmountStroops", "reason"],
                properties: {
                  referralId: { type: "integer", minimum: 1 },
                  referrerAddress: { $ref: "#/components/schemas/StellarAddress" },
                  bonusAmountStroops: { type: "integer", minimum: 1 },
                  reason: { type: "string", minLength: 1, maxLength: 500 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Bonus awarded" },
          401: { description: "Unauthorized" },
        },
      },
    },
    "/referrals/admin/all": {
      get: {
        tags: ["Referrals"],
        summary: "List all referrals (admin)",
        security: [{ BearerAuth: [] }],
        parameters: [
          { in: "query", name: "status", schema: { type: "string", enum: ["pending", "active", "bonus_paid"] } },
          { in: "query", name: "limit", schema: { type: "integer" } },
          { in: "query", name: "offset", schema: { type: "integer" } },
        ],
        responses: {
          200: { description: "Referrals list" },
          401: { description: "Unauthorized" },
        },
      },
    },

    // ── Onboarding (added for #695) ─────────────────────────────────────────

    "/onboarding/{walletAddress}": {
      get: {
        tags: ["Onboarding"],
        summary: "Get the onboarding checklist summary for a wallet",
        parameters: [{ in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } }],
        responses: {
          200: { description: "Onboarding summary", content: { "application/json": { schema: { $ref: "#/components/schemas/OnboardingSummary" } } } },
          400: { description: "Invalid Stellar wallet address" },
        },
      },
      patch: {
        tags: ["Onboarding"],
        summary: "Update onboarding checklist fields for a wallet",
        parameters: [{ in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string" },
                  kycStatus: { type: "string", enum: ["unverified", "pending", "verified"] },
                  paymentPreferencesSet: { type: "boolean" },
                  payoutToken: { type: "string", maxLength: 12 },
                  taxInfoSubmitted: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Updated summary", content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" }, summary: { $ref: "#/components/schemas/OnboardingSummary" } } } } } },
          400: { description: "Validation error" },
        },
      },
    },
    "/onboarding/{walletAddress}/remind": {
      post: {
        tags: ["Onboarding"],
        summary: "Send an onboarding reminder email",
        parameters: [{ in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } } } },
        },
        responses: {
          200: { description: "Reminder sent" },
          400: { description: "Invalid or missing email" },
        },
      },
    },

    // ── Payment holds (added for #695) ──────────────────────────────────────

    "/payment-holds/place": {
      post: {
        tags: ["Payment Holds"],
        summary: "Place a hold on a pending payment transaction",
        security: [{ ApiKeyAuth: [] }],
        description: "Requires the `admin` role.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["transactionId", "holdReason"],
                properties: {
                  transactionId: { type: "integer" },
                  holdReason: { type: "string" },
                  holdUntil: { type: "string", format: "date-time" },
                  placedBy: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Hold placed", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/PaymentHold" } } } } } },
          400: { description: "Missing transactionId or holdReason" },
          404: { description: "Transaction not found" },
        },
      },
    },
    "/payment-holds/release": {
      post: {
        tags: ["Payment Holds"],
        summary: "Release a hold on a transaction",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["transactionId"], properties: { transactionId: { type: "integer" }, releasedBy: { type: "string" }, approvalNote: { type: "string" } } },
            },
          },
        },
        responses: {
          200: { description: "Hold released" },
          404: { description: "Transaction not found or not on hold" },
        },
      },
    },
    "/payment-holds/approve-release": {
      post: {
        tags: ["Payment Holds"],
        summary: "Approve the release of a held transaction",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["transactionId"], properties: { transactionId: { type: "integer" }, approvedBy: { type: "string" }, approvalNote: { type: "string" } } },
            },
          },
        },
        responses: {
          200: { description: "Release approved" },
          404: { description: "Transaction not found or not on hold" },
        },
      },
    },
    "/payment-holds/transaction/{transactionId}": {
      get: {
        tags: ["Payment Holds"],
        summary: "Get a transaction's hold status and audit trail",
        parameters: [{ in: "path", name: "transactionId", required: true, schema: { type: "integer" } }],
        responses: {
          200: { description: "Transaction with hold + audit trail" },
          404: { description: "Transaction not found" },
        },
      },
    },
    "/payment-holds/contract/{contractId}": {
      get: {
        tags: ["Payment Holds"],
        summary: "List held transactions for a contract",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "status", schema: { type: "string", default: "active" } },
        ],
        responses: { 200: { description: "Held transactions" } },
      },
    },
    "/payment-holds/all": {
      get: {
        tags: ["Payment Holds"],
        summary: "List all held transactions across contracts (admin)",
        security: [{ ApiKeyAuth: [] }],
        parameters: [{ in: "query", name: "status", schema: { type: "string", default: "active" } }],
        responses: { 200: { description: "Held transactions" } },
      },
    },
    "/payment-holds/pending-release": {
      get: {
        tags: ["Payment Holds"],
        summary: "List transactions pending hold release (admin)",
        security: [{ ApiKeyAuth: [] }],
        responses: { 200: { description: "Pending-release transactions" } },
      },
    },
    "/payment-holds/audit/{transactionId}": {
      get: {
        tags: ["Payment Holds"],
        summary: "Get the audit trail for a held transaction",
        parameters: [{ in: "path", name: "transactionId", required: true, schema: { type: "integer" } }],
        responses: { 200: { description: "Audit trail" } },
      },
    },

    // ── Preferences (added for #695) ────────────────────────────────────────

    "/preferences/payment": {
      get: {
        tags: ["Preferences"],
        summary: "Get a wallet's payment preference",
        parameters: [{ in: "query", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } }],
        responses: {
          200: { description: "Payment preference", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "object", properties: { walletAddress: { $ref: "#/components/schemas/StellarAddress" }, paymentMethod: { type: "string", enum: ["direct_transfer", "usdc", "xlm"] } } } } } } } },
          400: { description: "Missing or invalid walletAddress" },
          404: { description: "No payment preference found for this wallet" },
        },
      },
      post: {
        tags: ["Preferences"],
        summary: "Set (upsert) a wallet's payment preference",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["walletAddress", "paymentMethod"],
                properties: {
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  paymentMethod: { type: "string", enum: ["direct_transfer", "usdc", "xlm"] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Preference saved" },
          400: { description: "Validation error" },
        },
      },
    },

    // ── Email digest (added for #695) ───────────────────────────────────────

    "/email-digest/subscribe": {
      post: {
        tags: ["Email Digest"],
        summary: "Subscribe a wallet to the weekly email digest",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["walletAddress", "email"],
                properties: {
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  email: { type: "string", format: "email" },
                  timezone: { type: "string", default: "UTC" },
                  dayOfWeek: { type: "integer", minimum: 0, maximum: 6, default: 0 },
                  hourOfDay: { type: "integer", minimum: 0, maximum: 23, default: 9 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Subscribed" },
          400: { description: "Validation error" },
          503: { description: "Email service not configured" },
        },
      },
    },
    "/email-digest/preferences/{walletAddress}": {
      get: {
        tags: ["Email Digest"],
        summary: "Get a wallet's email digest preferences",
        parameters: [{ in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } }],
        responses: {
          200: { description: "Subscriber preferences" },
          404: { description: "No subscription found for this wallet" },
        },
      },
    },
    "/email-digest/preferences": {
      put: {
        tags: ["Email Digest"],
        summary: "Update email digest preferences",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["walletAddress"],
                properties: {
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  email: { type: "string", format: "email" },
                  timezone: { type: "string" },
                  dayOfWeek: { type: "integer", minimum: 0, maximum: 6 },
                  hourOfDay: { type: "integer", minimum: 0, maximum: 23 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Preferences updated" },
          404: { description: "No active subscription found for this wallet" },
        },
      },
    },
    "/email-digest/unsubscribe": {
      post: {
        tags: ["Email Digest"],
        summary: "Unsubscribe from the weekly email digest via token",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } } } },
        },
        responses: {
          200: { description: "Unsubscribed (or already unsubscribed)" },
          400: { description: "Token is required" },
          404: { description: "Invalid unsubscribe token" },
        },
      },
    },
    "/email-digest/history/{walletAddress}": {
      get: {
        tags: ["Email Digest"],
        summary: "Get sent digest history for a wallet",
        parameters: [
          { in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } },
          { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
        ],
        responses: {
          200: { description: "Digest history" },
          404: { description: "No subscription found for this wallet" },
        },
      },
    },

    // ── Earnings history (added for #695) ───────────────────────────────────

    "/earnings-history/{walletAddress}": {
      get: {
        tags: ["Earnings History"],
        summary: "Get a contributor's earnings history across contracts",
        parameters: [
          { in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } },
          { in: "query", name: "start", schema: { type: "string", format: "date" }, description: "Default: 90 days ago" },
          { in: "query", name: "end", schema: { type: "string", format: "date" }, description: "Default: today" },
          { in: "query", name: "contracts", schema: { type: "string" }, description: "Comma-separated contract IDs to filter by" },
        ],
        responses: {
          200: {
            description: "Earnings history: snapshots, raw events, and the set of contracts this wallet has earned from",
            content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "object", properties: { walletAddress: { $ref: "#/components/schemas/StellarAddress" }, snapshots: { type: "array", items: { type: "object" } }, events: { type: "array", items: { type: "object" } }, contracts: { type: "array", items: { type: "object" } } } } } } } },
          },
          400: { description: "Invalid date range" },
        },
      },
    },

    // ── Notifications (added for #695) ──────────────────────────────────────

    "/notifications/{walletAddress}": {
      get: {
        tags: ["Notifications"],
        summary: "Get notifications for a wallet",
        parameters: [
          { in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } },
          { in: "query", name: "limit", schema: { type: "integer", default: 50 } },
          { in: "query", name: "offset", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          200: { description: "Notifications + unread count", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "array", items: { type: "object" } }, unreadCount: { type: "integer" } } } } } },
        },
      },
    },
    "/notifications/{walletAddress}/unread-count": {
      get: {
        tags: ["Notifications"],
        summary: "Get the unread notification count for a wallet",
        parameters: [{ in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } }],
        responses: { 200: { description: "Unread count" } },
      },
    },
    "/notifications/{id}/read": {
      post: {
        tags: ["Notifications"],
        summary: "Mark a notification as read",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        responses: { 200: { description: "Marked read" } },
      },
    },
    "/notifications/read-all/{walletAddress}": {
      post: {
        tags: ["Notifications"],
        summary: "Mark all notifications read for a wallet",
        parameters: [{ in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } }],
        responses: { 200: { description: "All marked read" } },
      },
    },
    "/notifications/{id}": {
      delete: {
        tags: ["Notifications"],
        summary: "Delete a notification",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        responses: { 200: { description: "Deleted" } },
      },
    },
    "/notifications/send": {
      post: {
        tags: ["Notifications"],
        summary: "Create and push a system notification",
        description: "Delivers over WebSocket in addition to persisting the notification.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["walletAddress", "type", "title"],
                properties: {
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  type: { type: "string" },
                  title: { type: "string" },
                  message: { type: "string" },
                  data: { type: "object" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Notification created" },
          400: { description: "walletAddress, type, and title are required" },
        },
      },
    },
    "/notifications/preferences/{walletAddress}": {
      get: {
        tags: ["Notifications"],
        summary: "Get notification preferences for a wallet",
        parameters: [{ in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } }],
        responses: { 200: { description: "Preferences", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/NotificationPreference" } } } } } } },
      },
    },
    "/notifications/preferences": {
      post: {
        tags: ["Notifications"],
        summary: "Set (upsert) notification preferences",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["walletAddress"],
                properties: {
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  email_enabled: { type: "boolean", default: true },
                  in_app_enabled: { type: "boolean", default: true },
                  sms_enabled: { type: "boolean", default: false },
                  notify_distribution: { type: "boolean", default: true },
                  notify_payment: { type: "boolean", default: true },
                  notify_failure: { type: "boolean", default: true },
                  notify_hold: { type: "boolean", default: true },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Preferences saved" },
          400: { description: "walletAddress is required" },
        },
      },
    },

    // ── Communications (added for #695) ─────────────────────────────────────

    "/communications": {
      post: {
        tags: ["Communications"],
        summary: "Record a contributor communication",
        security: [{ ApiKeyAuth: [] }],
        description: "Requires the `operator` role (or higher).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["walletAddress", "type", "body", "direction"],
                properties: {
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  contractId: { type: "string", nullable: true },
                  type: { type: "string", enum: ["email", "support_ticket", "message", "internal_note", "system_notification"] },
                  subject: { type: "string", maxLength: 500 },
                  body: { type: "string", minLength: 1, maxLength: 10000 },
                  direction: { type: "string", enum: ["inbound", "outbound", "internal"] },
                  status: { type: "string", enum: ["sent", "received", "draft", "archived"] },
                  isInternal: { type: "boolean" },
                  metadata: { type: "object" },
                  referenceId: { type: "string", maxLength: 200 },
                  createdBy: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Communication recorded" },
          401: { description: "Unauthorized" },
          500: { description: "Failed to record communication" },
        },
      },
    },
    "/communications/wallet/{walletAddress}": {
      get: {
        tags: ["Communications"],
        summary: "Get all communications for a wallet",
        parameters: [
          { in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } },
          { in: "query", name: "limit", schema: { type: "integer", default: 50 } },
          { in: "query", name: "offset", schema: { type: "integer", default: 0 } },
          { in: "query", name: "includeInternal", schema: { type: "boolean", default: false } },
        ],
        responses: { 200: { description: "Communications list" } },
      },
    },
    "/communications/contract/{contractId}": {
      get: {
        tags: ["Communications"],
        summary: "Get all communications for a contract",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "limit", schema: { type: "integer", default: 50 } },
          { in: "query", name: "offset", schema: { type: "integer", default: 0 } },
          { in: "query", name: "includeInternal", schema: { type: "boolean", default: false } },
        ],
        responses: { 200: { description: "Communications list" } },
      },
    },
    "/communications/search": {
      post: {
        tags: ["Communications"],
        summary: "Search across all communications",
        security: [{ ApiKeyAuth: [] }],
        description: "Requires the `operator` role (or higher).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["query"],
                properties: {
                  query: { type: "string", minLength: 1, maxLength: 200 },
                  includeInternal: { type: "boolean" },
                  limit: { type: "integer", minimum: 1, maximum: 500 },
                  offset: { type: "integer", minimum: 0 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Search results" },
          401: { description: "Unauthorized" },
        },
      },
    },
    "/communications/timeline/{walletAddress}": {
      get: {
        tags: ["Communications"],
        summary: "Get a chronological communications timeline for a wallet",
        parameters: [
          { in: "path", name: "walletAddress", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } },
          { in: "query", name: "limit", schema: { type: "integer", default: 100 } },
          { in: "query", name: "offset", schema: { type: "integer", default: 0 } },
          { in: "query", name: "includeInternal", schema: { type: "boolean", default: false } },
        ],
        responses: { 200: { description: "Timeline" } },
      },
    },
    "/communications/internal-note": {
      post: {
        tags: ["Communications"],
        summary: "Add an admin-only internal note to a contributor's history",
        security: [{ ApiKeyAuth: [] }],
        description: "Requires the `admin` role.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["walletAddress", "body"],
                properties: {
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  contractId: { type: "string", nullable: true },
                  body: { type: "string", minLength: 1, maxLength: 10000 },
                  createdBy: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Note added" },
          401: { description: "Unauthorized" },
        },
      },
    },

    // ── CSV import (added for #695) ─────────────────────────────────────────

    "/csv-import/template": {
      get: {
        tags: ["CSV Import"],
        summary: "Download a sample collaborator CSV template",
        responses: { 200: { description: "CSV file", content: { "text/csv": { schema: { type: "string" } } } } },
      },
    },
    "/csv-import/validate": {
      post: {
        tags: ["CSV Import"],
        summary: "Validate a collaborator CSV file without importing it",
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary", description: "CSV with address,share_percentage columns" } } } } },
        },
        responses: {
          200: { description: "Validation result (valid + errors rows)" },
          400: { description: "No CSV file uploaded" },
        },
      },
    },
    "/csv-import/preview": {
      post: {
        tags: ["CSV Import"],
        summary: "Preview a collaborator CSV import (validate + summarize, no persistence)",
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" }, contractId: { $ref: "#/components/schemas/ContractId" } } } } },
        },
        responses: {
          200: { description: "Preview with row-level validation and summary counts" },
          400: { description: "No CSV file uploaded" },
        },
      },
    },
    "/csv-import/import": {
      post: {
        tags: ["CSV Import"],
        summary: "Import collaborators from a CSV file",
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object", required: ["file", "contractId"], properties: { file: { type: "string", format: "binary" }, contractId: { $ref: "#/components/schemas/ContractId" }, importedBy: { type: "string" } } } } },
        },
        responses: {
          200: { description: "Import summary (successCount, errorCount)" },
          400: { description: "No CSV file uploaded, or contractId missing" },
        },
      },
    },
    "/csv-import/history/{contractId}": {
      get: {
        tags: ["CSV Import"],
        summary: "Get CSV import history for a contract",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        responses: { 200: { description: "Import history" } },
      },
    },
    "/csv-import/results/{importId}": {
      get: {
        tags: ["CSV Import"],
        summary: "Get detailed results for a specific import",
        parameters: [{ in: "path", name: "importId", required: true, schema: { type: "integer" } }],
        responses: {
          200: { description: "Import record, per-row results, and summary" },
          404: { description: "Import record not found" },
        },
      },
    },

    // ── Snapshots (added for #695) ──────────────────────────────────────────

    "/snapshots/all": {
      get: {
        tags: ["Snapshots"],
        summary: "Get all snapshots across all contracts (admin)",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { in: "query", name: "limit", schema: { type: "integer", default: 100 } },
          { in: "query", name: "offset", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          200: { description: "All snapshots" },
          401: { description: "Unauthorized" },
        },
      },
    },
    "/snapshots/{contractId}": {
      get: {
        tags: ["Snapshots"],
        summary: "List snapshots for a contract",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "limit", schema: { type: "integer", default: 50 } },
          { in: "query", name: "offset", schema: { type: "integer", default: 0 } },
        ],
        responses: { 200: { description: "Snapshots list", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "array", items: { $ref: "#/components/schemas/Snapshot" } } } } } } } },
      },
      post: {
        tags: ["Snapshots"],
        summary: "Create a snapshot for a contract",
        security: [{ ApiKeyAuth: [] }],
        description: "Requires the `operator` role (or higher).",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  label: { type: "string", maxLength: 200 },
                  collaborators: { type: "string", description: "JSON-encoded collaborator list" },
                  shares: { type: "string", description: "JSON-encoded share map" },
                  balances: { type: "string", description: "JSON-encoded balances" },
                  transactionCount: { type: "integer", minimum: 0 },
                  createdBy: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Snapshot created", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/Snapshot" } } } } } },
          401: { description: "Unauthorized" },
        },
      },
    },
    "/snapshots/{contractId}/{id}": {
      get: {
        tags: ["Snapshots"],
        summary: "Get a specific snapshot by ID",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "path", name: "id", required: true, schema: { type: "integer" } },
        ],
        responses: {
          200: { description: "Snapshot", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/Snapshot" } } } } } },
          400: { description: "Snapshot ID must be a number" },
          404: { description: "Snapshot not found" },
        },
      },
    },
    "/snapshots/{contractId}/verify/{id}": {
      post: {
        tags: ["Snapshots"],
        summary: "Verify a snapshot's data integrity by recomputing its hash",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "path", name: "id", required: true, schema: { type: "integer" } },
        ],
        responses: { 200: { description: "Verification result" } },
      },
    },
    "/snapshots/{contractId}/prune": {
      delete: {
        tags: ["Snapshots"],
        summary: "Prune old snapshots, keeping the most recent N",
        security: [{ ApiKeyAuth: [] }],
        description: "Requires the `admin` role.",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "keep", schema: { type: "integer", default: 90 } },
        ],
        responses: {
          200: { description: "Pruned", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "object", properties: { deleted: { type: "integer" }, keepCount: { type: "integer" } } } } } } } },
          401: { description: "Unauthorized" },
        },
      },
    },

    // ── Tiers (added for #695) ──────────────────────────────────────────────

    "/tiers/{contractId}": {
      get: {
        tags: ["Tiers"],
        summary: "List all tier assignments for a contract",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        responses: { 200: { description: "Tier assignments", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "array", items: { type: "object" } }, validTiers: { type: "array", items: { type: "string" } } } } } } } },
      },
    },
    "/tiers/{contractId}/{address}": {
      get: {
        tags: ["Tiers"],
        summary: "Get a single contributor's tier",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "path", name: "address", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } },
        ],
        responses: {
          200: { description: "Contributor tier" },
          400: { description: "Invalid Stellar address" },
        },
      },
      put: {
        tags: ["Tiers"],
        summary: "Set a contributor's tier",
        security: [{ ApiKeyAuth: [] }],
        description: "Requires the `operator` role (or higher).",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "path", name: "address", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tier"],
                properties: {
                  tier: { type: "string", enum: ["vip", "regular", "trial"] },
                  notes: { type: "string", maxLength: 256, nullable: true },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Tier updated" },
          400: { description: "Invalid Stellar address" },
          401: { description: "Unauthorized" },
        },
      },
      delete: {
        tags: ["Tiers"],
        summary: "Reset a contributor's tier to regular",
        security: [{ ApiKeyAuth: [] }],
        description: "Requires the `operator` role (or higher).",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "path", name: "address", required: true, schema: { $ref: "#/components/schemas/StellarAddress" } },
        ],
        responses: {
          200: { description: "Tier reset" },
          400: { description: "Invalid Stellar address" },
          401: { description: "Unauthorized" },
        },
      },
    },

    // ── Metrics (added for #695) ────────────────────────────────────────────

    "/metrics": {
      get: {
        tags: ["Metrics"],
        summary: "Prometheus metrics",
        description: "Also exposed unversioned at bare `/metrics`.",
        responses: {
          200: { description: "Prometheus text exposition format", content: { "text/plain": { schema: { type: "string" } } } },
        },
      },
    },

    // ── Admin (added for #695) — mounted at bare /admin, not /api/v1 ────────

    "/key-status": {
      servers: [{ url: "/admin", description: "Admin routes (unversioned)" }],
      get: {
        tags: ["Admin"],
        summary: "Get the current signing key status",
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: "Signing key status (public key, last rotation, provider)" },
          401: { description: "Unauthorized" },
        },
      },
    },
    "/rotate-key": {
      servers: [{ url: "/admin", description: "Admin routes (unversioned)" }],
      post: {
        tags: ["Admin"],
        summary: "Rotate (or reload) the transaction-signing key",
        security: [{ BearerAuth: [] }],
        description: "Legacy bearer-token guard (ADMIN_ROTATE_TOKEN) — distinct from the RBAC-based x-api-key auth used elsewhere.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "Exactly one of secretKey, reloadFromFile, or reloadFromProvider must be provided",
                properties: {
                  secretKey: { type: "string", pattern: "^S[A-Z2-7]{55}$" },
                  reloadFromFile: { type: "boolean" },
                  reloadFromProvider: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Key rotated/reloaded", content: { "application/json": { schema: { type: "object", properties: { publicKey: { type: "string" }, rotatedAt: { type: "string", format: "date-time" }, source: { type: "string" } } } } } },
          401: { description: "Unauthorized" },
          503: { description: "Key rotation not configured on this server" },
        },
      },
    },
    "/users": {
      servers: [{ url: "/admin", description: "Admin routes (unversioned)" }],
      post: {
        tags: ["Admin"],
        summary: "Create a user with an RBAC role",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["walletAddress", "role"],
                properties: {
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  role: { type: "string", enum: ["viewer", "collaborator", "operator", "admin"] },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "User created", content: { "application/json": { schema: { type: "object", properties: { userId: { type: "string" } } } } } },
          401: { description: "Unauthorized" },
        },
      },
    },
  },
};
