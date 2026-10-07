import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/lib/use/ws";
import { body as bodyParser } from "express";
import { PubSub } from "graphql-subscriptions";
import {
  getContributorContracts,
  getContributorEarningsHistory,
  getContributorEarningsEvents,
} from "./database/analytics.js";
import { isValidStellarAccountAddress } from "../../shared/stellar-address.js";
import logger from "./logger.js";

// PubSub instance for GraphQL subscriptions
const pubsub = new PubSub();

// Subscription event names
export const SUBSCRIPTION_EVENTS = {
  DISTRIBUTION_STARTED: "DISTRIBUTION_STARTED",
  DISTRIBUTION_COMPLETED: "DISTRIBUTION_COMPLETED",
  DISTRIBUTION_FAILED: "DISTRIBUTION_FAILED",
  SECONDARY_ROYALTY_RECEIVED: "SECONDARY_ROYALTY_RECEIVED",
  CONTRACT_INITIALIZED: "CONTRACT_INITIALIZED",
};

// Export pubsub so route handlers can publish events
export { pubsub };

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

  type DistributionEvent {
    contractId: String!
    status: String!
    timestamp: String!
    tokenId: String
    totalAmount: String
    recipients: [RecipientShare!]
    transactionId: String
    error: String
  }

  type RecipientShare {
    address: String!
    amount: String!
    share: Int!
  }

  type SecondaryRoyaltyEvent {
    contractId: String!
    salePrice: String!
    royaltyAmount: String!
    seller: String!
    buyer: String!
    timestamp: String!
    tokenId: String
  }

  type ContractInitializedEvent {
    contractId: String!
    owner: String!
    timestamp: String!
    recipients: [RecipientShare!]!
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

  type Subscription {
    distributionUpdates(contractId: String, walletAddress: String): DistributionEvent!
    secondaryRoyalties(contractId: String!): SecondaryRoyaltyEvent!
    contractInitialized(walletAddress: String!): ContractInitializedEvent!
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
  Subscription: {
    distributionUpdates: {
      subscribe: (_parent, { contractId, walletAddress }) => {
        logger.info("Client subscribed to distribution updates", { contractId, walletAddress });
        
        // Filter by contractId or walletAddress
        return pubsub.asyncIterator([
          SUBSCRIPTION_EVENTS.DISTRIBUTION_STARTED,
          SUBSCRIPTION_EVENTS.DISTRIBUTION_COMPLETED,
          SUBSCRIPTION_EVENTS.DISTRIBUTION_FAILED,
        ]);
      },
      resolve: (payload, { contractId, walletAddress }) => {
        // Filter events based on subscription parameters
        if (contractId && payload.contractId !== contractId) {
          return null;
        }
        if (walletAddress && !payload.recipients?.some(r => r.address === walletAddress)) {
          return null;
        }
        return payload;
      },
    },
    secondaryRoyalties: {
      subscribe: (_parent, { contractId }) => {
        logger.info("Client subscribed to secondary royalties", { contractId });
        return pubsub.asyncIterator([SUBSCRIPTION_EVENTS.SECONDARY_ROYALTY_RECEIVED]);
      },
      resolve: (payload, { contractId }) => {
        if (payload.contractId !== contractId) {
          return null;
        }
        return payload;
      },
    },
    contractInitialized: {
      subscribe: (_parent, { walletAddress }) => {
        logger.info("Client subscribed to contract initialization", { walletAddress });
        return pubsub.asyncIterator([SUBSCRIPTION_EVENTS.CONTRACT_INITIALIZED]);
      },
      resolve: (payload, { walletAddress }) => {
        if (payload.owner !== walletAddress) {
          return null;
        }
        return payload;
      },
    },
  },
};

export function createGraphQLServer(httpServer) {
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  
  // Create WebSocket server for subscriptions
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/graphql",
  });

  // Setup subscription handler
  const serverCleanup = useServer({ schema }, wsServer);

  const server = new ApolloServer({
    schema,
    introspection: true,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await serverCleanup.dispose();
            },
          };
        },
      },
    ],
  });
  
  return server;
}

export async function setupGraphQL(app, path, httpServer) {
  const server = createGraphQLServer(httpServer);
  await server.start();
  
  app.use(path, bodyParser.json(), expressMiddleware(server, {
    context: async ({ req }) => ({
      correlationId: req.correlationId,
    }),
  }));
  
  logger.info(`GraphQL server initialized at ${path} with WebSocket subscriptions`);
}