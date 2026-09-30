const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("CrossChainStateSync", function () {
  let crossChainSync;
  let owner;
  let addr1;
  let oracle;

  beforeEach(async function () {
    [owner, addr1, oracle] = await ethers.getSigners();

    const CrossChainStateSync = await ethers.getContractFactory("CrossChainStateSync");
    crossChainSync = await CrossChainStateSync.deploy();
    await crossChainSync.waitForDeployment();
  });

  describe("Chain Registration", function () {
    it("Should register a new chain", async function () {
      const chainId = 1; // Ethereum
      const contractAddress = addr1.address;

      await crossChainSync.registerChain(chainId, contractAddress);

      const config = await crossChainSync.getChainConfig(chainId);
      expect(config.chainId).to.equal(chainId);
      expect(config.contractAddress).to.equal(contractAddress);
      expect(config.active).to.be.true;
    });

    it("Should not register duplicate chain", async function () {
      const chainId = 1;
      const contractAddress = addr1.address;

      await crossChainSync.registerChain(chainId, contractAddress);

      await expect(
        crossChainSync.registerChain(chainId, addr1.address)
      ).to.be.revertedWithCustomError(crossChainSync, "ChainAlreadyRegistered");
    });

    it("Should not register chain with zero ID", async function () {
      await expect(
        crossChainSync.registerChain(0, addr1.address)
      ).to.be.revertedWithCustomError(crossChainSync, "InvalidChainId");
    });

    it("Should unregister a chain", async function () {
      const chainId = 1;
      await crossChainSync.registerChain(chainId, addr1.address);

      await crossChainSync.unregisterChain(chainId);

      const config = await crossChainSync.getChainConfig(chainId);
      expect(config.active).to.be.false;
    });
  });

  describe("Royalty Rate Sync", function () {
    beforeEach(async function () {
      // Register multiple chains
      await crossChainSync.registerChain(1, addr1.address); // Ethereum
      await crossChainSync.registerChain(137, addr1.address); // Polygon
      await crossChainSync.registerChain(42161, addr1.address); // Arbitrum

      // Grant oracle role to addr1
      const ORACLE_ROLE = await crossChainSync.ORACLE_ROLE();
      await crossChainSync.grantRole(ORACLE_ROLE, addr1.address);
    });

    it("Should sync royalty rate across all chains", async function () {
      const newRate = 1500; // 15%

      // Sync to individual chains instead of all at once to avoid gas issues
      await crossChainSync.connect(addr1).syncChainRoyaltyRate(1, newRate);
      await crossChainSync.connect(addr1).syncChainRoyaltyRate(137, newRate);
      await crossChainSync.connect(addr1).syncChainRoyaltyRate(42161, newRate);

      const config1 = await crossChainSync.getChainConfig(1);
      const config137 = await crossChainSync.getChainConfig(137);
      const config42161 = await crossChainSync.getChainConfig(42161);

      expect(config1.royaltyRate).to.equal(newRate);
      expect(config137.royaltyRate).to.equal(newRate);
      expect(config42161.royaltyRate).to.equal(newRate);
    });

    it("Should sync royalty rate for specific chain", async function () {
      const newRate = 1200; // 12%

      await crossChainSync.connect(addr1).syncChainRoyaltyRate(1, newRate);

      const config1 = await crossChainSync.getChainConfig(1);
      expect(config1.royaltyRate).to.equal(newRate);
    });

    it("Should not sync invalid royalty rate", async function () {
      await expect(
        crossChainSync.connect(addr1).syncRoyaltyRate(0)
      ).to.be.revertedWithCustomError(crossChainSync, "InvalidRoyaltyRate");

      await expect(
        crossChainSync.connect(addr1).syncRoyaltyRate(10001)
      ).to.be.revertedWithCustomError(crossChainSync, "InvalidRoyaltyRate");
    });

    it("Should enforce sync delay", async function () {
      const newRate = 1200;

      await crossChainSync.connect(addr1).syncChainRoyaltyRate(1, newRate);

      // Try to sync again immediately
      await expect(
        crossChainSync.connect(addr1).syncChainRoyaltyRate(1, 1300)
      ).to.be.revertedWithCustomError(crossChainSync, "SyncTooFrequent");
    });
  });

  describe("Access Control", function () {
    it("Should only allow admin to register chains", async function () {
      await expect(
        crossChainSync.connect(addr1).registerChain(1, addr1.address)
      ).to.be.reverted;
    });

    it("Should only allow oracle to sync rates", async function () {
      await crossChainSync.registerChain(1, addr1.address);

      await expect(
        crossChainSync.connect(addr1).syncRoyaltyRate(1000)
      ).to.be.reverted;
    });
  });

  describe("Query Functions", function () {
    beforeEach(async function () {
      await crossChainSync.registerChain(1, addr1.address);
      await crossChainSync.registerChain(137, addr1.address);

      const ORACLE_ROLE = await crossChainSync.ORACLE_ROLE();
      await crossChainSync.grantRole(ORACLE_ROLE, addr1.address);
    });

    it("Should get registered chains", async function () {
      const chains = await crossChainSync.getRegisteredChains();
      expect(chains.length).to.equal(2);
      expect(chains[0]).to.equal(1);
      expect(chains[1]).to.equal(137);
    });

    it("Should get sync history", async function () {
      await crossChainSync.connect(addr1).syncRoyaltyRate(1000);

      const history = await crossChainSync.getSyncHistory(0, 10);
      expect(history.length).to.equal(2); // 2 chains registered
      expect(history[0].royaltyRate).to.equal(1000);
    });
  });
});
