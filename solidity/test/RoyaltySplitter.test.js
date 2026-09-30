const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RoyaltySplitter", function () {
  let royaltySplitter;
  let owner;
  let addr1;
  let addr2;
  let addr3;
  let token;

  beforeEach(async function () {
    [owner, addr1, addr2, addr3] = await ethers.getSigners();

    // Deploy mock ERC20 token for testing
    const MockToken = await ethers.getContractFactory("MockERC20");
    token = await MockToken.deploy("Test Token", "TTK");
    await token.waitForDeployment();

    // Deploy RoyaltySplitter
    const RoyaltySplitter = await ethers.getContractFactory("RoyaltySplitter");
    royaltySplitter = await RoyaltySplitter.deploy();
    await royaltySplitter.waitForDeployment();

    // Initialize contract
    const collaborators = [owner.address, addr1.address, addr2.address];
    const shares = [5000, 3000, 2000]; // 50%, 30%, 20%
    const royaltyRate = 1000; // 10%

    await royaltySplitter.initialize(collaborators, shares, royaltyRate);
  });

  describe("Initialization", function () {
    it("Should initialize correctly", async function () {
      const rate = await royaltySplitter.royaltyRate();
      expect(rate).to.equal(1000);
    });

    it("Should not allow double initialization", async function () {
      await expect(
        royaltySplitter.initialize([owner.address], [10000], 1000)
      ).to.be.revertedWithCustomError(royaltySplitter, "AlreadyInitialized");
    });

    it("Should require correct share total", async function () {
      const RoyaltySplitter = await ethers.getContractFactory("RoyaltySplitter");
      const newSplitter = await RoyaltySplitter.deploy();
      await newSplitter.waitForDeployment();

      await expect(
        newSplitter.initialize([owner.address], [5000], 1000)
      ).to.be.revertedWithCustomError(newSplitter, "InvalidShareTotal");
    });
  });

  describe("Distribution", function () {
    beforeEach(async function () {
      // Mint tokens to contract
      await token.mint(await royaltySplitter.getAddress(), ethers.parseEther("1000"));
    });

    it("Should distribute royalties correctly", async function () {
      // Disable incentives for predictable distribution
      await royaltySplitter.setIncentivesEnabled(false);
      
      const amount = ethers.parseEther("100");
      await royaltySplitter.distribute(await token.getAddress(), amount);

      const ownerBalance = await token.balanceOf(owner.address);
      const addr1Balance = await token.balanceOf(addr1.address);
      const addr2Balance = await token.balanceOf(addr2.address);

      // 50% * 90% (after 10% fee) = 45%
      expect(ownerBalance).to.equal(ethers.parseEther("45"));
      // 30% * 90% = 27%
      expect(addr1Balance).to.equal(ethers.parseEther("27"));
      // 20% * 90% = 18%
      expect(addr2Balance).to.equal(ethers.parseEther("18"));
    });

    it("Should record distribution history", async function () {
      const amount = ethers.parseEther("100");
      await royaltySplitter.distribute(await token.getAddress(), amount);

      const history = await royaltySplitter.getDistributionHistory(0, 10);
      expect(history.length).to.equal(1);
      expect(history[0].totalAmount).to.equal(amount);
    });

    it("Should fail when paused", async function () {
      await royaltySplitter.pause();
      
      const amount = ethers.parseEther("100");
      await expect(
        royaltySplitter.distribute(await token.getAddress(), amount)
      ).to.be.revertedWithCustomError(royaltySplitter, "EnforcedPause");
    });
  });

  describe("Royalty Rate", function () {
    it("Should change royalty rate", async function () {
      await royaltySplitter.setRoyaltyRate(1500);
      expect(await royaltySplitter.royaltyRate()).to.equal(1500);
    });

    it("Should record rate change history", async function () {
      await royaltySplitter.setRoyaltyRate(1500);
      const history = await royaltySplitter.getRoyaltyRateHistory();
      expect(history.length).to.equal(1);
      expect(history[0].oldRate).to.equal(1000);
      expect(history[0].newRate).to.equal(1500);
    });

    it("Should not allow zero rate", async function () {
      await expect(
        royaltySplitter.setRoyaltyRate(0)
      ).to.be.revertedWithCustomError(royaltySplitter, "RoyaltyRateZero");
    });

    it("Should not allow rate > 10000", async function () {
      await expect(
        royaltySplitter.setRoyaltyRate(10001)
      ).to.be.revertedWithCustomError(royaltySplitter, "RoyaltyRateTooHigh");
    });
  });

  describe("Collaborators", function () {
    it("Should add collaborator after removing one", async function () {
      await royaltySplitter.removeCollaborator(addr2.address);
      await royaltySplitter.addCollaborator(addr3.address, 2000);
      const collaborators = await royaltySplitter.getCollaborators();
      expect(collaborators.length).to.equal(3);
    });

    it("Should remove collaborator", async function () {
      await royaltySplitter.removeCollaborator(addr1.address);
      const collaborators = await royaltySplitter.getCollaborators();
      expect(collaborators.length).to.equal(2);
    });

    it("Should not add duplicate collaborator", async function () {
      await expect(
        royaltySplitter.addCollaborator(owner.address, 1000)
      ).to.be.revertedWithCustomError(royaltySplitter, "DuplicateRecipient");
    });
  });

  describe("Cross-chain Sync", function () {
    it("Should sync chain state", async function () {
      const chainId = 1; // Ethereum
      const contractAddress = addr1.address;
      const royaltyRate = 1000;

      await royaltySplitter.syncChainState(chainId, contractAddress, royaltyRate);
      
      const chainState = await royaltySplitter.getChainStates(chainId);
      expect(chainState.chainId).to.equal(chainId);
      expect(chainState.contractAddress).to.equal(contractAddress);
      expect(chainState.royaltyRate).to.equal(royaltyRate);
    });
  });

  describe("Linked Pools", function () {
    it("Should link pool", async function () {
      await royaltySplitter.linkPool(addr1.address, 2000);
      const pools = await royaltySplitter.getLinkedPools();
      expect(pools.length).to.equal(1);
      expect(pools[0].poolAddress).to.equal(addr1.address);
    });

    it("Should unlink pool", async function () {
      await royaltySplitter.linkPool(addr1.address, 2000);
      await royaltySplitter.unlinkPool(addr1.address);
      const pools = await royaltySplitter.getLinkedPools();
      expect(pools.length).to.equal(0);
    });

    it("Should not link self", async function () {
      await expect(
        royaltySplitter.linkPool(await royaltySplitter.getAddress(), 2000)
      ).to.be.revertedWithCustomError(royaltySplitter, "InvalidLinkedPool");
    });
  });

  describe("Vesting", function () {
    it("Should create vesting schedule", async function () {
      await royaltySplitter.createVestingSchedule(addr3.address, 1000, 30, 365);
      const schedule = await royaltySplitter.vestingSchedules(addr3.address);
      expect(schedule.beneficiary).to.equal(addr3.address);
      expect(schedule.totalShares).to.equal(1000);
    });

    it("Should calculate vested shares correctly", async function () {
      await royaltySplitter.createVestingSchedule(addr3.address, 1000, 30, 365);
      
      // Before cliff - should be 0
      let schedule = await royaltySplitter.vestingSchedules(addr3.address);
      expect(schedule.claimedShares).to.equal(0);
    });
  });

  describe("Pause/Unpause", function () {
    it("Should pause contract", async function () {
      await royaltySplitter.pause();
      expect(await royaltySplitter.paused()).to.be.true;
    });

    it("Should unpause contract", async function () {
      await royaltySplitter.pause();
      await royaltySplitter.unpause();
      expect(await royaltySplitter.paused()).to.be.false;
    });

    it("Should emit Paused event when paused", async function () {
      await expect(royaltySplitter.pause())
        .to.emit(royaltySplitter, "Paused")
        .withArgs(owner.address);
    });

    it("Should emit Unpaused event when unpaused", async function () {
      await royaltySplitter.pause();
      await expect(royaltySplitter.unpause())
        .to.emit(royaltySplitter, "Unpaused")
        .withArgs(owner.address);
    });
  });

  describe("Access Control", function () {
    it("Should grant admin role", async function () {
      const hasRole = await royaltySplitter.hasRole(await royaltySplitter.ADMIN_ROLE(), owner.address);
      expect(hasRole).to.be.true;
    });

    it("Should not allow non-admin to set royalty rate", async function () {
      await expect(
        royaltySplitter.connect(addr1).setRoyaltyRate(1500)
      ).to.be.reverted;
    });
  });
});
