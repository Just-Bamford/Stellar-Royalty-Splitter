'use strict';

const ethers = require('ethers');

/**
 * MakerDAO Vat integration.
 * Handles collateral deposit, DAI minting, repayment and collateral withdrawal.
 */

const VAT_ABI = [
  'function ilk(bytes32 ilk) view returns (uint256 art, uint256 rate, uint256 spot, uint256 line, uint256 dust)',
  'function urni(bytes32 ilk) view returns (uint256)',
  'function frobk(bytes32 ilk, address u, address v, address w, int256 d, int256 w)',
];

const GEM_JOIN_ABI = [
  'function join(uint256 w)',
  'function exit(uint256 w)',
];

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const RAY = 10n ** 27n;

class MakerDAOIntegration {
  constructor({ provider, vatAddress, gemJoin, daiJoin, signer } = {}) {
    if (!provider) throw new Error('MakerDAOIntegration requires a provider');
    if (!vatAddress) throw new Error('MakerDAOIntegration requires a VAT address');
    this.provider = provider;
    this.vatAddress = vatAddress;
    this.gemJoin = gemJoin;
    this.daiJoin = daiJoin;
    this.signer = signer || null;
    this.vat = new ethers.Contract(vatAddress, VAT_ABI, this.signer || provider);
  }

  _getSigner() {
    if (!this.signer) throw new Error('Signer not configured for write operations');
    return this.signer;
  }

  async getIlk(ilk) {
    const result = await this.vat.ilk(ilk);
    return {
      art: result.art,
      rate: result.rate,
      spot: result.spot,
      line: result.line,
      dust: result.dust,
    };
  }

  async getCollateralValue(ilk, amount) {
    const { spot } = await this.getIlk(ilk);
    return (BigInt(amount) * BigInt(spot)) / BigInt(RAY);
  }

  async getDebtValue(ilk, amount) {
    const { rate } = await this.getIlk(ilk);
    return (BigInt(amount) * BigInt(rate)) / BigInt(RAY);
  }

  async depositCollateral(ilk, amount) {
    const signer = this._getSigner();
    const user = await signer.getAddress();
    const gem = new ethers.Contract(this.gemJoin, GEM_JOIN_ABI, signer);
    const tx = await gem.join(amount);
    const receipt = await tx.wait();
    return { txHash: receipt.transactionHash, user };
  }

  async withdrawCollateral(ilk, amount) {
    const signer = this._getSigner();
    const user = await signer.getAddress();
    const gem = new ethers.Contract(this.gemJoin, GEM_JOIN_ABI, signer);
    const tx = await gem.exit(amount);
    const receipt = await tx.wait();
    return { txHash: receipt.transactionHash, user };
  }

  async mintDAI(ilk, amount) {
    const signer = this._getSigner();
    const user = await signer.getAddress();
    const tx = await this.vat.frobk(ilk, user, user, user, BigInt(amount), 0n);
    const receipt = await tx.wait();
    return { txHash: receipt.transactionHash, user };
  }

  async repayDAI(ilk, amount) {
    const signer = this._getSigner();
    const user = await signer.getAddress();
    const tx = await this.vat.frobk(ilk, user, user, user, -BigInt(amount), 0n);
    const receipt = await tx.wait();
    return { txHash: receipt.transactionHash, user };
  }

  async getPosition(ilk, user) {
    const urn = await this.vat.urn(ilk);
    const ilkData = await this.getIlk(ilk);
    return {
      urn: urn,
      rate: ilkData.rate,
      spot: ilkData.spot,
      user,
    };
  }

  /**
   * Computes the stability fee accrued between two rate snapshots.
   */
  computeStabilityFee({ debt, oldRate, newRate }) {
    if (oldRate === 0n) return 0n;
    const delta = BigInt(newRate) - BigInt(oldRate);
    return (BigInt(debt) * delta) / BigInt(oldRate);
  }
}

module.exports = { MakerDAOIntegration };
