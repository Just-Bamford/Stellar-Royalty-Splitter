import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { body as bodyParser } from "express";
import {
  getContributorContracts,
  getContributorEarningsHistory,
  getContributorEarningsEvents,
} from "./database/analytics.js";
import { isValidStellarAccountAddress } from "../../shared/stellar-address.js";
import logger from "./logger.js";

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

  type Query {
    contracts(walletAddress: String!): [Contract!]!
    earnings(
      walletAddress: String!
      start: String
      end: String
      contractIds: [String]
    ): EarningsData!
  }

  type Mutation {
    initialize(contractId: String!, walletAddress: String!): MutationResponse!
    distribute(contractId: String!, walletAddress: String!, tokenId: String!): MutationResponse!
  }
`;

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
      
      const startDate = start ? new Date(start) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
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
  },
  Mutation: {
    initialize: async (_parent, { contractId, walletAddress }) => {
      logger.info("GraphQL initialize mutation", { contractId, walletAddress });
      return {
        success: false,
        error: "GraphQL mutations are read-only in this implementation. Use REST endpoints for mutations.",
      };
    },
    distribute: async (_parent, { contractId, walletAddress, tokenId }) => {
      logger.info("GraphQL distribute mutation", { contractId, walletAddress, tokenId });
      return {
        success: false,
        error: "GraphQL mutations are read-only in this implementation. Use REST endpoints for mutations.",
      };
    },
  },
};

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
  
  app.use(path, bodyParser.json(), expressMiddleware(server, {
    context: async ({ req }) => ({
      correlationId: req.correlationId,
    }),
  }));
  
  logger.info(`GraphQL server initialized at ${path}`);
}