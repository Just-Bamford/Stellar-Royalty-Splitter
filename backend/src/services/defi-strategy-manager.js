'use strict';

const { AaveIntegration } = require('./aave-integration');
const { MakerDAOIntegration } = require('./makerdao-integration');

/**
 * Strategy manager for DeFi yield and leverage operations.
 */

const STRATEGY = {
  IDLE: 'idle',
  AAVE_DEPOSIT: 'AaveDeposit',
  MAKER_DAI: 'MakerDAI',
};

class DeFiStrategyManager {
  constructor({ provider, signer, aaveConfig, makerConfig } = {}) {
    this.provider = provider;
    this.signer = signer || null;
    this.aave = aveProvider ? new AaveIntegration({ provider, signer, ...aaveConfig }) : null;
    this.maker = makerConfig ? new MakerDAOIntegration({ provider, signer, ...makerConfig }) : null;
    this.strategies = new Map();
  }

  registerStrategy(name, handler) {
    this.strategies.set(name, handler);
  }

  async depositToAave({ asset, amount, onBehalfOf }) {
    if (!this.aave) throw new Error('Aave integration not configured');
    const result = await this.aave.supply(asset, amount, onBehalfOf);
    return { strategy: STRATEGY.AAVE_DEPOSIT, ...result };
  }

  async withdrawFromAave({ asset, amount, to }) {
    if (!this.aave) throw new Error('Aave integration not configured');
    const result = await this.aave.withdraw(asset, amount, to);
    return { strategy: STRATEGY.IDLE, txHash: result.txHash };
  }

  async mintDAIFromMaker({ tilk, amount }) {
    if (!this.maker) throw new Error('MakerDAO integration not configured');
    const result = await this.maker.mintDAI(ilk, amount);
    return { strategy: STRATEGY.MAKER_DAI, txHash: result.txHash };
  }

  async getStatus({ asset, user, ilk, principal, oldIndex }) {
    const status = { strategies: [] };
    if (this.aave && asset && user) {
      const reserve = await this.aave.getReserveData(asset);
      const userData = await this.aave.getUserReserveData(asset, user);
      const yieldAccrued = oldIndex !== undefined
        ? await this.aave.getYieldAccrued(asset, user, principal || userData.currentATokenBalance, oldIndex)
        : null;
      status.strategies.push({
        name: STRATEGY.AAVE_DEPOSIT,
        balance: userData.currentATokenBalance,
        debt: userData.currentStableDebt + userData.currentVariableDebt,
        apy: reserve.currentLiquidityRate,
        yield: yieldAccrued,
      });
    }
    if (this.maker && ilk && user) {
      const position = await this.maker.getPosition(ilk, user);
      status.strategies.push({
        name: STRATEGY.MAKER_DAI,
        urn: position.urn,
        rate: position.rate,
        spot: position.spot,
      });
    }
    return status;
  }

  async switchStrategy({ from, to, asset, amount }) {
    const handler = this.strategies.get(to);
    if (!handler) throw new Error(`Unknown strategy: ${to}`);
    if (from) {
      const fromHandler = this.strategies.get(from);
      if (fromHandler) await fromHandler.exit({ asset, amount, to });
    }
    return handler.enter({ asset, amount, to });
  }
}

module.exports = { DeFiStrategyManager, STRATEGY };
