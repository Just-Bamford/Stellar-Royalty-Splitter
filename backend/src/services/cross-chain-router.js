import { logger } from '../utils/logger.js';
import { thorchainIntegration } from './thorchain-integration.js';
import { stargateIntegration } from './stargate-integration.js';

const MAX_SPLIT_PARTS = Number(process.env.CROSS_CHAIN_MAX_SPLIT_PARTS || 4);
const MIN_PART_AMOUNT = BigInt(process.env.CROSS_CHAIN_MIN_PART_AMOUNT || '1000000');
const DEFAULT_SLIPPAGE = Number(process.env.CROSS_CHAIN_SLIPPAGE ?? 0.005);

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (value == null || value === '') return 0N;
  return BigInt(String(value));
}

function computeEffectiveRate(quote) {
  const in = toBigInt(quote.inputAmount);
  const out = toBigInt(quote.outputAmount);
  if (in <= 0N) return 0N;
  return (out * 1000000000000000000n) / in;
}

function applySlippage(amount, slippage) {
  const a = toBigInt(amount);
  const bps = BigInt(Math.round(slippage * 10000));
  return (a * (10000n - bps)) / 10000n;
}

export class CrossChainRouter {
  constructor(options = {}) {
    this.thorchain = options.thorchain || thorchainIntegration;
    this.stargate = options.stargate || stargateIntegration;
    this.maxSplitParts = options.maxSplitParts || MAX_SPLIT_PARTS;
    this.minPartAmount = options.minPartAmount || MIN_PART_AMOUNT;
  }

  async quoteThorchain(params) {
    try {
      return await this.thorchain.getQuote(params);
    } catch (err) {
      logger.warn('Thorchain quote failed', { error: err.message });
      return null;
    }
  }

  async quoteStargate(params) {
    try {
      return await this.stargate.getQuote(params);
    } catch (err) {
      logger.warn('Stargate quote failed', { error: err.message });
      return null;
    }
  }

  async getQuotes(params) {
    const { thorchainParams, stargateParams } = params;
    const tasks = [];
    if (thorchainParams) tasks.push(this.quoteThorchain(thorchainParams));
    if (stargateParams) tasks.push(this.quoteStargate(stargateParams));
    const results = await Promise.all(tasks);
    return results.filter(Boolean);
  }

  selectBestProvider(quotes) {
    if (!quotes || quotes.length === 0) return null;
    return quotes.reduce((a, b) => {
      const ra = computeEffectiveRate(a);
      const rb = computeEffectiveRate(b);
      return rb > ra ? b : a;
    });
  }

  buildSplitPlan(quotes, totalAmount) {
    const total = toBigInt(totalAmount);
    const sorted = [...quotes].sort((a, b) => {
      const ra = computeEffectiveRate(a);
      const rb = computeEffectiveRate(b);
      return rb > ra ? 1 : rb < ra ? -1 : 0;
    });
    const parts = Math.min(this.maxSplitParts, sorted.length);
    if (parts <= 1 || total < this.minPartAmount * BigInt(parts)) {
      return [{ quote: sorted[0], amount: total }];
    }
    const weights = sorted.slice(0, parts).map((q) => computeEffectiveRate(q));
    const weightSum = weights.reduce((a, b) => a + b, 0N);
    if (weightSum === 0N) {
      return [{ quote: sorted[0], amount: total }];
    }
    const plan = [];
    let allocated = 0N;
    for (let i = 0; i < parts; i++) {
      const isLast = i === parts - 1;
      const amount = isLast
        ? total - allocated
        : (total * weights[i]) / weightSum;
      allocated += amount;
      plan.push({ quote: sorted[i], amount });
    }
    return plan.filter((p) => p.amount > 0Nn);
  }

  async route(params) {
    const {
      amount,
      thorchainParams,
      stargateParams,
      allowSplit = true,
      slippage = DEFAULT_SLIPPAGE,
    } = params;
    if (!amount) throw new Error('amount is required');
    const total = toBigInt(amount);
    if (total <= 0Nn) throw new Error('amount must be > 0');

    const quotes = await this.getQuotes({ thorchainParams, stargateParams });
    if (quotes.length === 0) {
      throw new Error('no cross-chain quotes available');
    }

    const best = this.selectBestProvider(quotes);
    let plan = [{ quote: best, amount: total }];
    if (allowSplit && quotes.length > 1) {
      const split = this.buildSplitPlan(quotes, total);
      if (split.length > 1) {
        const splitOut = split.reduce((acc, p) => {
          const ratio = computeEffectiveRate(p.quote);
          return acc + (p.amount * ratio) / 1000000000000000000n;
        }, 0N);
        const bestOut = toBigInt(best.outputAmount);
        if (splitOut > bestOut) {
          plan = split;
        }
      }
    }

    const executionPlan = plan.map((p) => ({
      provider: p.quote.provider,
      amount: p.amount.toString(),
      minOutput: applySlippage(p.quote.outputAmount, slippage).toString(),
      quote: p.quote,
    }));

    const totalOut = executionPlan.reduce((acc, p) => acc + toBigInt(p.minOutput), 0N);

    return {
      provider: executionPlan.length > 1 ? 'split' : executionPlan[0].provider,
      inputAmount: total.toString(),
      minOutput: totalOut.toString(),
      slippage,
      plan: executionPlan,
      allQuotes: quotes,
    };
  }

  async execute(routeResult, executors = {}) {
    if (!routeResult || !routeResult.plan) throw new Error('routeResult is required');
    const thorchainExecutor = executors.thorchain || this.thorchain.executeSwap?.bind(this.thorchain);
    const stargateExecutor = executors.stargate || this.stargate.executeSwap?.bind(this.stargate);
    if (!thorchainExecutor && !stargateExecutor) {
      throw new Error('no executors configured');
    }

    const results = [];
    for (const step of routeResult.plan) {
      const executor = step.provider === 'thorchain' ? thorchainExecutor : stargateExecutor;
      if (!executor) {
        throw new Error(`executor for ${step.provider} not available`);
      }
      try {
        const res = await executor(step);
        results.push({ provider: step.provider, amount: step.amount, result: res });
      } catch (err) {
        logger.error('cross-chain execution failed', {
          provider: step.provider,
          error: err.message,
        });
        throw new Error(
          `cross-chain execution failed on ${step.provider}: ${err.message}`,
        );
      }
    }
    return { success: true, results };
  }
}

export const crossChainRouter = new CrossChainRouter();
export { computeEffectiveRate as _computeEffectiveRate };
