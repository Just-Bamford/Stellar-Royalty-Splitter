/**
 * GraphQL API — queries, mutations, and real-time subscriptions (#809, #969).
 *
 * Subscriptions are implemented over the existing raw WebSocket server (/ws)
 * using a lightweight pub/sub bus so no extra transport dependency is needed.
 * Apollo Server handles queries/mutations over HTTP as before.
 *
 * Three subscriptions are exposed (#969):
 *   subscribeToDistributions       – live distribution events
 *   subscribeToDisputes            – dispute status changes
 *   subscribeToCollaboratorEarnings – earnings updates for a wallet
 *
 * Clients subscribe by sending a GraphQL-over-WS style message:
 *   { type: "gql_subscribe", operation: "subscribeToDistributions", contractId?: "...", walletAddress?: "..." }
 *
 * The server pushes data frames:
 *   { type: "gql_data", operation: "...", data: { ... } }
 *
 * Internal code publishes events via the exported `pubsub` helpers:
 *   publishDistribution(contractId, payload)
 *   publishDispute(disputeId, payload)
 *   publishCollaboratorEarnings(walletAddress, payload)
 */

import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { json as jsonParser } from "express";
import {
  getContributorContracts,
  getContributorEarningsHistory,
  getContributorEarningsEvents,
} from "./database/analytics.js";
import { isValidStellarAccountAddress } from "../../shared/stellar-address.js";
import logger from "./logger.js";

// ---------------------------------------------------------------------------
// Lightweight in-process pub/sub bus for GraphQL subscriptions (#969)
// ---------------------------------------------------------------------------

/**
 * Channel registry: channel key → Set of { ws, filter } subscriber descriptors.
 *
 * Channel key shapes:
 *   "distributions:{contractId}"   – or "distributions:*" for all contracts
 *   "disputes:{disputeId}"         – or "disputes:*"
 *   "earnings:{walletAddress}"
 */
const _channels = new Map(); // key → Set<{ws, filter}>

/**
 * Subscribe a WebSocket client to a channel.
 * @param {string} channel  - Channel key (e.g. "distributions:C123")
 * @param {object} ws       - WebSocket instance
 * @param {object} filter   - Arbitrary metadata stored alongside the subscription (for cleanup)
 */
function _subscribe(channel, ws, filter = {}) {
  if (!_channels.has(channel)) _channels.set(channel, new Set());
  _channels.get(channel).add({ ws, filter });
}

/**
 * Remove all subscriptions for a given WebSocket (called on disconnect).
 */
export function unsubscribeAll(ws) {
  for (const [key, subs] of _channels) {
    for (const sub of subs) {
      if (sub.ws === ws) subs.delete(sub);
    }
    if (subs.size === 0) _channels.delete(key);
  }
}

/**
 * Publish a payload to all subscribers of a channel.
 * Sends nothing to closed sockets and cleans up dead entries.
 */
function _publish(channel, operation, data) {
  const subs = _channels.get(channel);
  if (!subs || subs.size === 0) return 0;

  const message = JSON.stringify({ type: "gql_data", operation, data });
  let sent = 0;
  for (const sub of subs) {
    if (sub.ws.readyState === 1 /* OPEN */) {
      sub.ws.send(message);
      sent++;
    } else {
      subs.delete(sub);
    }
  }
  if (subs.size === 0) _channels.delete(channel);
  return sent;
}

// ---------------------------------------------------------------------------
// Public publish helpers — call these from route handlers / jobs
// ---------------------------------------------------------------------------

/**
 * Publish a distribution event.
 * @param {string} contractId
 * @param {object} payload  – { contractId, tokenId, amount, timestamp, txHash?, … }
 */
export function publishDistribution(contractId, payload) {
  // Notify contract-specific subscribers and wildcard subscribers
  _publish(`distributions:${contractId}`, "subscribeToDistributions", payload);
  _publish("distributions:*", "subscribeToDistributions", payload);
}

/**
 * Publish a dispute status update.
 * @param {string|number} disputeId
 * @param {object} payload  – { disputeId, status, updatedAt, … }
 */
export function publishDispute(disputeId, payload) {
  _publish(`disputes:${disputeId}`, "subscribeToDisputes", payload);
  _publish("disputes:*", "subscribeToDisputes", payload);
}

/**
 * Publish a collaborator earnings change.
 * @param {string} walletAddress
 * @param {object} payload  – { walletAddress, contractId, amount, timestamp, … }
 */
export function publishCollaboratorEarnings(walletAddress, payload) {
  _publish(`earnings:${walletAddress}`, "subscribeToCollaboratorEarnings", payload);
}

// ---------------------------------------------------------------------------
// WebSocket subscription handler
// Attach this to the existing ws server's "message" processing pipeline.
// ---------------------------------------------------------------------------

/**
 * Handle a raw WebSocket message that may be a GraphQL subscription request.
 * Returns true if the message was handled as a subscription command, false otherwise.
 *
 * Expected message format:
 *   {
 *     type: "gql_subscribe",
 *     operation: "subscribeToDistributions" | "subscribeToDisputes" | "subscribeToCollaboratorEarnings",
 *     contractId?: string,     // for subscribeToDistributions
 *     disputeId?: string,      // for subscribeToDisputes
 *     walletAddress?: string,  // for subscribeToCollaboratorEarnings
 *   }
 */
export function handleSubscriptionMessage(ws, msg) {
  if (msg.type !== "gql_subscribe") return false;

  const { operation } = msg;

  if (operation === "subscribeToDistributions") {
    const contractId = msg.contractId ?? "*";
    const channel = `distributions:${contractId}`;
    _subscribe(channel, ws, { operation, contractId });
    ws.send(
      JSON.stringify({
        type: "gql_subscribed",
        operation,
        channel,
      })
    );
    logger.info("GraphQL subscription: subscribeToDistributions", { contractId });
    return true;
  }

  if (operation === "subscribeToDisputes") {
    const disputeId = msg.disputeId ?? "*";
    const channel = `disputes:${disputeId}`;
    _subscribe(channel, ws, { operation, disputeId });
    ws.send(
      JSON.stringify({
        type: "gql_subscribed",
        operation,
        channel,
      })
    );
    logger.info("GraphQL subscription: subscribeToDisputes", { disputeId });
    return true;
  }

  if (operation === "subscribeToCollaboratorEarnings") {
    const walletAddress = msg.walletAddress;
    if (!walletAddress || !isValidStellarAccountAddress(walletAddress)) {
      ws.send(
        JSON.stringify({
          type: "gql_error",
          operation,
          error: "walletAddress is required and must be a valid Stellar address",
        })
      );
      return true;
    }
    const channel = `earnings:${walletAddress}`;
    _subscribe(channel, ws, { operation, walletAddress });
    ws.send(
      JSON.stringify({
        type: "gql_subscribed",
        operation,
        channel,
      })
    );
    logger.info("GraphQL subscription: subscribeToCollaboratorEarnings", { walletAddress });
    return true;
  }

  // Unknown operation
  ws.send(
    JSON.stringify({
      type: "gql_error",
      error: `Unknown subscription operation: ${operation}`,
    })
  );
  return true;
}

// ---------------------------------------------------------------------------
// GraphQL schema and resolvers (HTTP — queries & mutations)
// ---------------------------------------------------------------------------

const typeDefs = `#graphql
  type Contract {
    contractId: String!
    name: String
  }

  type EarningEvent {
    timestamp: String!
    amount: String!
    tokenId: String
  }

  type EarningsSnapshot {
    date: String!
    totalEarnings: String!
  }

  type EarningsData {
    walletAddress: String!
    contracts: [Contract!]!
    events: [EarningEvent!]!
    snapshots: [EarningsSnapshot!]!
  }

  type MutationResponse {
    success: Boolean!
    xdr: String
    transactionId: String
    error: String
  }

  """
  Describes the three available real-time GraphQL subscriptions.
  Actual push delivery is over the /ws WebSocket channel — see API docs.
  """
  type SubscriptionInfo {
    operation: String!
    description: String!
    filters: [String!]!
    transport: String!
  }

  type Query {
    contracts(walletAddress: String!): [Contract!]!
    earnings(
      walletAddress: String!
      start: String
      end: String
      contractIds: [String]
    ): EarningsData!

    """
    Describes the available real-time subscriptions and how to connect.
    Returns metadata only; actual subscriptions run over WebSocket.
    """
    availableSubscriptions: [SubscriptionInfo!]!
  }

  type Mutation {
    initialize(contractId: String!, walletAddress: String!): MutationResponse!
    distribute(contractId: String!, walletAddress: String!, tokenId: String!): MutationResponse!
  }
`;

const SUBSCRIPTION_DOCS = [
  {
    operation: "subscribeToDistributions",
    description:
      "Receive live distribution events. Optionally filter by contractId (omit for all contracts).",
    filters: ["contractId (optional)"],
    transport: "WebSocket /ws — send { type: 'gql_subscribe', operation: 'subscribeToDistributions', contractId? }",
  },
  {
    operation: "subscribeToDisputes",
    description:
      "Receive dispute status updates. Optionally filter by disputeId (omit for all disputes).",
    filters: ["disputeId (optional)"],
    transport: "WebSocket /ws — send { type: 'gql_subscribe', operation: 'subscribeToDisputes', disputeId? }",
  },
  {
    operation: "subscribeToCollaboratorEarnings",
    description: "Receive real-time earnings changes for a specific collaborator wallet.",
    filters: ["walletAddress (required)"],
    transport:
      "WebSocket /ws — send { type: 'gql_subscribe', operation: 'subscribeToCollaboratorEarnings', walletAddress }",
  },
];

const resolvers = {
  Query: {
    contracts: async (_parent, { walletAddress }) => {
      if (!isValidStellarAccountAddress(walletAddress)) {
        throw new Error("Invalid wallet address");
      }
      const contracts = getContributorContracts(walletAddress);
      return contracts.map((c) => ({ contractId: c.contractId, name: c.name }));
    },

    earnings: async (_parent, { walletAddress, start, end, contractIds }) => {
      if (!isValidStellarAccountAddress(walletAddress)) {
        throw new Error("Invalid wallet address");
      }

      const startDate = start
        ? new Date(start)
        : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const endDate = end ? new Date(end) : new Date();

      const snapshots = getContributorEarningsHistory(
        walletAddress,
        startDate.toISOString(),
        endDate.toISOString(),
        contractIds
      );
      const events = getContributorEarningsEvents(walletAddress);
      const contracts = getContributorContracts(walletAddress);

      return {
        walletAddress,
        contracts: contracts.map((c) => ({ contractId: c.contractId, name: c.name })),
        events: events.map((e) => ({
          timestamp: e.timestamp,
          amount: e.amount,
          tokenId: e.tokenId,
        })),
        snapshots: snapshots.map((s) => ({
          date: s.date,
          totalEarnings: s.totalEarnings,
        })),
      };
    },

    availableSubscriptions: () => SUBSCRIPTION_DOCS,
  },

  Mutation: {
    initialize: async (_parent, { contractId, walletAddress }) => {
      logger.info("GraphQL initialize mutation", { contractId, walletAddress });
      return {
        success: false,
        error:
          "GraphQL mutations are read-only in this implementation. Use REST endpoints for mutations.",
      };
    },
    distribute: async (_parent, { contractId, walletAddress, tokenId }) => {
      logger.info("GraphQL distribute mutation", { contractId, walletAddress, tokenId });
      return {
        success: false,
        error:
          "GraphQL mutations are read-only in this implementation. Use REST endpoints for mutations.",
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Server factory and Express integration
// ---------------------------------------------------------------------------

export function createGraphQLServer() {
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    introspection: true,
  });
  return server;
}

export async function setupGraphQL(app, path) {
  const server = createGraphQLServer();
  await server.start();

  app.use(
    path,
    jsonParser(),
    expressMiddleware(server, {
      context: async ({ req }) => ({
        correlationId: req.correlationId,
      }),
    })
  );

  logger.info(`GraphQL server initialized at ${path}`);
}
