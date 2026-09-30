/**
 * IPFS Integration Tests
 * Issue #1060 - Advanced document management system with IPFS
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import {
  IPFSIntegrationService,
  computeIPFSCID,
  computeChecksum,
  encodeBase58,
} from "../src/services/ipfs-integration.js";

describe("IPFS Integration Service (#1060)", () => {
  let ipfs;

  beforeEach(() => {
    ipfs = new IPFSIntegrationService({
      gatewayUrl: "https://ipfs.io/ipfs",
    });
    ipfs.clearCache();
  });

  describe("Base58 and CID calculation", () => {
    test("encodes buffer to base58 correctly", () => {
      const buffer = Buffer.from("hello world", "utf8");
      const b58 = encodeBase58(buffer);
      expect(typeof b58).toBe("string");
      expect(b58.length).toBeGreaterThan(0);
    });

    test("computes deterministic CID starting with Qm for IPFS v0", () => {
      const content = "Smart Contract Agreement v1.0";
      const cid1 = computeIPFSCID(content);
      const cid2 = computeIPFSCID(content);

      expect(cid1).toBe(cid2);
      expect(cid1.startsWith("Qm")).toBe(true);
    });

    test("computes different CIDs for different contents", () => {
      const cid1 = computeIPFSCID("Contract Version 1");
      const cid2 = computeIPFSCID("Contract Version 2");
      expect(cid1).not.toBe(cid2);
    });

    test("computes sha256 checksum correctly", () => {
      const checksum = computeChecksum("Test Data");
      expect(checksum).toHaveLength(64);
    });
  });

  describe("uploadContent", () => {
    test("uploads string content and returns CID with metadata", async () => {
      const content = "Test document content for IPFS storage";
      const result = await ipfs.uploadContent(content, {
        fileName: "agreement.pdf",
        mimeType: "application/pdf",
        pin: true,
      });

      expect(result.cid).toBeDefined();
      expect(result.cid.startsWith("Qm")).toBe(true);
      expect(result.size).toBe(Buffer.byteLength(content));
      expect(result.mimeType).toBe("application/pdf");
      expect(result.fileName).toBe("agreement.pdf");
      expect(result.pinned).toBe(true);
      expect(result.gatewayUrl).toBe(`https://ipfs.io/ipfs/${result.cid}`);
      expect(ipfs.isPinned(result.cid)).toBe(true);
    });

    test("uploads JSON content and Buffer content", async () => {
      const jsonContent = { title: "Distribution Proof", amount: 5000 };
      const result = await ipfs.uploadContent(jsonContent, {
        fileName: "proof.json",
        mimeType: "application/json",
      });

      expect(result.cid).toBeDefined();
      const retrieved = await ipfs.getContent(result.cid, { asJson: true });
      expect(retrieved.content).toEqual(jsonContent);
    });

    test("throws error when content is null or undefined", async () => {
      await expect(ipfs.uploadContent(null)).rejects.toThrow("Content is required");
    });
  });

  describe("getContent and integrity verification", () => {
    test("retrieves content by CID as string and as buffer", async () => {
      const text = "Decentralized Agreement Content";
      const upload = await ipfs.uploadContent(text, {
        fileName: "doc.txt",
        mimeType: "text/plain",
      });

      const retrievedStr = await ipfs.getContent(upload.cid, { asString: true });
      expect(retrievedStr.content).toBe(text);
      expect(retrievedStr.verified).toBe(true);
      expect(retrievedStr.fileName).toBe("doc.txt");

      const retrievedBuf = await ipfs.getContent(upload.cid);
      expect(Buffer.isBuffer(retrievedBuf.content)).toBe(true);
      expect(retrievedBuf.content.toString("utf8")).toBe(text);
    });

    test("throws error when CID is not found", async () => {
      await expect(ipfs.getContent("QmNonExistentHash123456789")).rejects.toThrow("Content not found on IPFS");
    });

    test("fails verification if content was tampered in storage", async () => {
      const upload = await ipfs.uploadContent("Original Content");
      // Simulate storage corruption
      ipfs.storage.set(upload.cid, Buffer.from("Tampered Content"));

      await expect(ipfs.getContent(upload.cid)).rejects.toThrow("Content integrity verification failed");
    });
  });

  describe("pinning & gateway resolution", () => {
    test("pins and unpins CIDs", async () => {
      const upload = await ipfs.uploadContent("Pin Test", { pin: true });
      expect(ipfs.isPinned(upload.cid)).toBe(true);

      ipfs.unpin(upload.cid);
      expect(ipfs.isPinned(upload.cid)).toBe(false);

      ipfs.pin(upload.cid);
      expect(ipfs.isPinned(upload.cid)).toBe(true);
    });

    test("generates correct gateway URLs", () => {
      const url = ipfs.getGatewayUrl("QmTest123");
      expect(url).toBe("https://ipfs.io/ipfs/QmTest123");
    });

    test("verifyContent helper returns true for matching content and false for mismatch", () => {
      const content = "Verified terms of agreement";
      const cid = computeIPFSCID(content);

      expect(ipfs.verifyContent(cid, content)).toBe(true);
      expect(ipfs.verifyContent(cid, "Different content")).toBe(false);
    });
  });
});
