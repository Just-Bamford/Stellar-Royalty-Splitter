import { WebSocketServer } from "ws";
import logger from "./logger.js";

const clients = new Map();

export function initializeWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress;
    logger.info("WebSocket client connected", { ip });

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    // Set timeout for auto-disconnect (10 minutes)
    const timeout = setTimeout(() => {
      if (ws.readyState === 1) {
        logger.info("WebSocket auto-disconnect timeout", { ip });
        ws.terminate();
      }
    }, 10 * 60 * 1000); // 10 minutes
    ws._timeout = timeout;

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "subscribe" && msg.walletAddress) {
          ws.walletAddress = msg.walletAddress;
          if (!clients.has(msg.walletAddress)) {
            clients.set(msg.walletAddress, new Set());
          }
          clients.get(msg.walletAddress).add(ws);
          ws.send(JSON.stringify({ type: "subscribed", walletAddress: msg.walletAddress }));
          logger.info("Wallet subscribed to notifications", { walletAddress: msg.walletAddress });
        }
        if (msg.type === "subscribe" && msg.id) {
          // Transaction subscription by ID (supports string IDs like "txn-123")
          const key = `txn:${msg.id}`;
          if (!clients.has(key)) {
            clients.set(key, new Set());
          }
          clients.get(key).add(ws);
          // Track the transaction key on the socket for cleanup on close
          if (!ws.txnKeys) ws.txnKeys = new Set();
          ws.txnKeys.add(key);
          ws.send(JSON.stringify({ type: "subscribed", id: msg.id }));
          logger.info("Client subscribed to transaction updates", { id: msg.id });
        }
        if (msg.type === "subscribe_finality" && msg.transactionId) {
          const key = `finality:${msg.transactionId}`;
          if (!clients.has(key)) {
            clients.set(key, new Set());
          }
          clients.get(key).add(ws);
          // Track the finality key on the socket for cleanup on close
          if (!ws.finalityKeys) ws.finalityKeys = new Set();
          ws.finalityKeys.add(key);
          ws.send(JSON.stringify({ type: "subscribed_finality", transactionId: msg.transactionId }));
          logger.info("Client subscribed to finality updates", { transactionId: msg.transactionId });
        }
        // #959: Collaborative editor subscriptions
        if (msg.type === "subscribe_contract_edits" && msg.contractId) {
          const key = `contract:${msg.contractId}`;
          if (!clients.has(key)) {
            clients.set(key, new Set());
          }
          clients.get(key).add(ws);
          // Track the contract key on the socket for cleanup on close
          if (!ws.contractKeys) ws.contractKeys = new Set();
          ws.contractKeys.add(key);
          ws.send(JSON.stringify({ type: "subscribed_contract_edits", contractId: msg.contractId }));
          logger.info("Client subscribed to contract edits", { contractId: msg.contractId });
        }
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch (err) {
        logger.error("WebSocket message error", { error: err.message });
      }
    });

    ws.on("close", () => {
      // Clear timeout
      if (ws._timeout) {
        clearTimeout(ws._timeout);
      }

      if (ws.walletAddress && clients.has(ws.walletAddress)) {
        clients.get(ws.walletAddress).delete(ws);
        if (clients.get(ws.walletAddress).size === 0) {
          clients.delete(ws.walletAddress);
        }
      }
      // Clean up any transaction subscriptions
      if (ws.txnKeys) {
        ws.txnKeys.forEach((key) => {
          if (clients.has(key)) {
            clients.get(key).delete(ws);
            if (clients.get(key).size === 0) {
              clients.delete(key);
            }
          }
        });
      }
      // Clean up any finality subscriptions
      if (ws.finalityKeys) {
        ws.finalityKeys.forEach((key) => {
          if (clients.has(key)) {
            clients.get(key).delete(ws);
            if (clients.get(key).size === 0) {
              clients.delete(key);
            }
          }
        });
      }
      // Clean up any contract subscriptions (#959)
      if (ws.contractKeys) {
        ws.contractKeys.forEach((key) => {
          if (clients.has(key)) {
            clients.get(key).delete(ws);
            if (clients.get(key).size === 0) {
              clients.delete(key);
            }
          }
        });
      }
      logger.info("WebSocket client disconnected", { ip });
    });

    ws.on("error", (err) => {
      logger.error("WebSocket error", { error: err.message });
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(interval));

  logger.info("WebSocket server initialized on /ws");
  return wss;
}

export function sendNotification(walletAddress, notification) {
  if (!clients.has(walletAddress)) return false;
  const message = JSON.stringify({
    type: "notification",
    data: notification,
  });
  let sent = 0;
  clients.get(walletAddress).forEach((ws) => {
    if (ws.readyState === 1) {
      ws.send(message);
      sent++;
    }
  });
  return sent > 0;
}

export function broadcastToContract(contractId, notification) {
  const message = JSON.stringify({
    type: "notification",
    data: { ...notification, contractId },
  });
  let sent = 0;
  clients.forEach((sockets) => {
    sockets.forEach((ws) => {
      if (ws.readyState === 1 && ws.walletAddress) {
        ws.send(message);
        sent++;
      }
    });
  });
  return sent;
}

/**
 * Broadcast a transaction finality status change to all connected clients
 * that are subscribed to a specific transactionId.
 *
 * Clients subscribe by sending:
 *   { type: "subscribe_finality", transactionId: 42 }
 *
 * The server then adds the socket to a per-transactionId set so that only
 * interested subscribers receive the update rather than all connected clients.
 *
 * @param {number} transactionId
 * @param {object} update  - { transactionId, txHash, status, confirmations, feePaid, errorMessage, … }
 * @returns {number} number of sockets that received the message
 */
export function broadcastFinalityUpdate(transactionId, update) {
  const message = JSON.stringify({
    type: "finality_update",
    data: update,
  });
  let sent = 0;
  // Send to clients subscribed to this specific transactionId
  const key = `finality:${transactionId}`;
  if (clients.has(key)) {
    clients.get(key).forEach((ws) => {
      if (ws.readyState === 1) {
        ws.send(message);
        sent++;
      }
    });
  }
  // Also broadcast to all wallet-subscribed clients so the dashboard can
  // react without needing a separate finality subscription.
  clients.forEach((sockets, clientKey) => {
    if (clientKey.startsWith("finality:")) return; // already handled above
    sockets.forEach((ws) => {
      if (ws.readyState === 1 && ws.walletAddress) {
        ws.send(message);
        sent++;
      }
    });
  });
  return sent;
}

/**
 * Broadcast a transaction status change to clients subscribed to a specific transaction ID.
 *
 * Clients subscribe by sending:
 *   { type: "subscribe", id: "txn-123" }
 *
 * The server then adds the socket to a per-transaction ID set so that only
 * interested subscribers receive the update.
 *
 * @param {string} transactionId - Transaction ID (e.g., "txn-123")
 * @param {object} update - { id, status, fee, receipt, … }
 * @returns {number} number of sockets that received the message
 */
export function broadcastTransactionStatus(transactionId, update) {
  const message = JSON.stringify({
    type: "transaction_status",
    data: update,
  });
  let sent = 0;
  const key = `txn:${transactionId}`;
  if (clients.has(key)) {
    clients.get(key).forEach((ws) => {
      if (ws.readyState === 1) {
        ws.send(message);
        sent++;
      }
    });
  }
  return sent;
}

/**
 * #959: Broadcast contract edit events to all clients subscribed to a contract
 * 
 * Clients subscribe by sending:
 *   { type: "subscribe_contract_edits", contractId: "CONTRACT_ABC" }
 * 
 * Edit events include: field_locked, field_unlocked, field_updated
 * 
 * @param {string} contractId - Contract identifier
 * @param {object} event - { type, field, userId, data }
 * @returns {number} number of sockets that received the message
 */
export function broadcastContractEdit(contractId, event) {
  const message = JSON.stringify({
    type: "contract_edit",
    data: { ...event, contractId },
  });
  let sent = 0;
  const key = `contract:${contractId}`;
  if (clients.has(key)) {
    clients.get(key).forEach((ws) => {
      if (ws.readyState === 1) {
        ws.send(message);
        sent++;
      }
    });
  }
  return sent;
}

/**
 * #986: Broadcast audit events in real-time
 * 
 * @param {string} contractId - Contract identifier
 * @param {object} auditEvent - Audit log entry
 * @returns {number} number of sockets that received the message
 */
export function broadcastAuditEvent(contractId, auditEvent) {
  const message = JSON.stringify({
    type: "audit_event",
    data: { ...auditEvent, contractId },
  });
  let sent = 0;
  const key = `contract:${contractId}`;
  if (clients.has(key)) {
    clients.get(key).forEach((ws) => {
      if (ws.readyState === 1) {
        ws.send(message);
        sent++;
      }
    });
  }
  return sent;
}
