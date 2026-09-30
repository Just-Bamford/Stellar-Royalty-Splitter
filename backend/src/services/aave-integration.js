'use strict';

const ethers = require('ethers');

/**
 * Aave V3 Pool integration.
 * Handles supply, withdraw, borrow, repay and yield accrual accounting.
 */

const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function getReserveData(address asset) view returns (uint256 totalLiquidity, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint256 currentLiquidityRate, uint256 currentVariableBorrowRate, uint256 currentStableBorrowRate, uint256 availableLiquidity, uint256 usageAsCollateral)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReserveAtIndex(address asset, uint256 index) view returns (uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 availableLiquidity, uint256 usageAsCollateral)',
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenPalance, uint256 currentStableDebt, address currentVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint256 usageAsCollateral)',
];

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const RATE_MODE = { NONE: 0, STABLE: 1, VARIABLE: 2 };

class AaveIntegration {
  constructor({ provider, poolAddress, signer } = {}) {
    if (!provider) throw new Error('AaveIntegration requires a provider');
    if (!poolAddress) throw new Error('AaveIntegration requires a pool address');
    this.provider = provider;
    this.poolAddress = poolAddress;
    this.signer = signer || null;
    this.pool = new ethers.Contract(poolAddress, AAVE_POOL_ABI, this.signer || provider);
  }

  _getSigner() {
    if (!this.signer) throw new Error('Signer not configured for write operations');
    return this.signer;
  }

  async _ensureApproval(asset, amount) {
    const token = new ethers.Contract(asset, ERC20_ABI, this._getSigner());
    const owner = await this.signer.getAddress();
    const allowance = await token.allowance(owner, this.poolAddress);
    if (allowance.lt(amount)) {
      const tx = await token.approve(this.poolAddress, amount);
      await tx.wait();
    }
  }

  async supply(asset, amount, onBehalfOf) {
    const signer = this._getSigner();
    const recipient = onBehalfOf || (await signer.getAddress());
    await this._ensureApproval(asset, amount);
    const tx = await this.pool.supply(asset, amount, recipient, 0);
    const receipt = await tx.wait();
    return { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
  }

  async withdraw(asset, amount, to) {
    const signer = this._getSigner();
    const recipient = to || (await signer.getAddress());
    const tx = await this.pool.withdraw(asset, amount, recipient);
    const receipt = await tx.wait();
    return { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
  }

  async borrow(asset, amount, interestRateMode = RATE_MODE.VARIABLE, onBehalfOf) {
    const signer = this._getSigner();
    const recipient = onBehalfOf || (await signer.getAddress());
    const tx = await this.pool.borrow(asset, amount, interestRateMode, 0, recipient);
    const receipt = await tx.wait();
    return { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
  }

  async repay(asset, amount, interestRateMode = RATE_MODE.VARIABLE, onBehalfOf) {
    const signer = this._getSigner();
    const recipient = onBehalfOf || (await signer.getAddress());
    await this._ensureApproval(asset, amount);
    const tx = await this.pool.repay(asset, amount, interestRateMode, recipient);
    const receipt = await tx.wait();
    return { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
  }

  async getReserveData(asset) {
    const data = await this.pool.getReserveData(asset);
    return {
      totalLiquidity: data.totalLiquidity,
      totalStableDebt: data.totalStableDebt,
      totalVariableDebt: data.totalVariableDebt,
      liquidityRate: data.liquidityRate,
      liquidityIndex: data.liquidityIndex,
      variableBorrowIndex: data.variableBorrowIndex,
      currentLiquidityRate: data.currentLiquidityRate,
      currentVariableBorrowRate: data.currentVariableBorrowRate,
      currentStableBorrowRate: data.currentStableBorrowRate,
      availableLiquidity: data.availableLiquidity,
      usageAsCollateral: data.usageAsCollateral,
    };
  }

  async getUserAccountData(user) {
    const data = await this.pool.getUserAccountData(user);
    return {
      totalCollateralBase: data.totalCollateralBase,
      totalDebtBase: data.totalDebtBase,
      availableBorrowsBase: data.availableBorrowsBase,
      currentLiquidationThreshold: data.currentLiquidationThreshold,
      ltv: data.ltv,
      healthFactor: data.healthFactor,
    };
  }

  async getUserReserveData(asset, user) {
    const data = await this.pool.getUserReserveData(asset, user);
    return {
      currentATokenBalance: data.currentATokenBalance,
      currentStableDebt: data.currentStableDebt,
      currentVariableDebt: data.currentVariableDebt,
      stableBorrowRate: data.stableBorrowRate,
      liquidityRate: data.liquidityRate,
      usageAsCollateral: data.usageAsCollateral,
    };
  }

  /**
   * Computes yield accrued between two liquidity index snapshots.
   * Yield = principal * (newIndex - oldIndex) / oldIndex
   */
  computeYield({ principal, oldIndex, newIndex }) {
    if (oldIndex === 0n) return 0n;
    const delta = BigInt(newIndex) - BigInt(oldIndex);
    return (BigInt(principal) * delta) / BigInt(oldIndex);
  }

  async getYieldAccrued(asset, user, principal, oldIndex) {
    const reserve = await this.getReserveData(asset);
    const yieldAccrued = this.computeYield({
      principal,
      oldIndex,
      newIndex: reserve.liquidityIndex,
    });
    return {
      yield: yieldAccrued,
      currentIndex: reserve.liquidityIndex,
      currentAPY: reserve.currentLiquidityRate,
      user: user || null,
    };
  }
}

module.exports = { AaveIntegration, RATE_MODE };
