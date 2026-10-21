/**
 * Tests for websocket.js module-level client state isolation (#1232).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import http from "http";
import WebSocket from "ws";
import {
  initializeWebSocket,
  sendNotification,
  clearClients,
  getClientCount,
} from "../src/websocket.js";

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let server;
let wss;
let port;

beforeAll(async () => {
  server = http.createServer();
  wss = initializeWebSocket(server);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

afterAll(async () => {
  wss.clients.forEach((ws) => ws.terminate());
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
});

// Sockets are left open on purpose: without this reset the second test would
// still see the first test's subscription and sendNotification would succeed.
afterEach(() => {
  clearClients();
});

function subscribe(walletAddress) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://localhost:${port}/ws`);
    client.on("open", () => client.send(JSON.stringify({ type: "subscribe", walletAddress })));
    client.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "subscribed") resolve(client);
    });
    client.on("error", reject);
  });
}

describe("websocket client state", () => {
  test("subscribing a wallet registers a client", async () => {
    expect(getClientCount()).toBe(0);
    await subscribe(WALLET);
    expect(getClientCount()).toBe(1);
    expect(sendNotification(WALLET, { message: "hello" })).toBe(true);
  });

  test("a later test using the same wallet starts with no clients", () => {
    expect(getClientCount()).toBe(0);
    expect(sendNotification(WALLET, { message: "hello" })).toBe(false);
  });
});

describe("clearClients", () => {
  test("removes every subscription", async () => {
    await subscribe(WALLET);
    await subscribe(WALLET);
    expect(getClientCount()).toBe(2);
    clearClients();
    expect(getClientCount()).toBe(0);
  });
});
