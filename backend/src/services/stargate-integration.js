import { logger } from '../utils/logger.js';

const STARGATE_API =
  process.env.STARGATE_API_URL || 'https://api.stargate.finance';
const DEFAULT_TIMEOUT_MS = Number(process.env.STARGATE_TIMEOUT_MS || 8);

const CHAIN_IDS = {
  ethereum: 1,
  bsc: 56,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  avalanche: 4314,
  base: 8453,
  linea: 59144,
  scroll: 534352,
  mantle: 5000,
};

const CHAIN_BY_ID = Object.entries(CHAIN_IDS).reduce((acc, [name, id]) => {
  acc[id] = name;
  return acc;
}, {});

function resolveChainId(chain) {
  if (chain == null) return null;
  if (typeof chain === 'number') return chain;
  if (typeof chain === 'string') {
    const lower = chain.toLowerCase();
    if (CHAIN_IDS[lower] !== undefined) return CHAIN_IDS[lower];
    const num = Number(chain);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-Client-ID': 'stellar-royalty-splitter',
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Stargate request failed (${response.status}): ${body.slice(0, 200)}`
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export class StargateIntegration {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || STARGATE_API;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn || fetchWithTimeout;
  }

  async getChains() {
    const data = await this.fetchFn(`${this.baseUrl}/v1/chains`, {
      timeoutMs: this.timeoutMs,
    });
    return Array.isArray(data) ? data : data.chains || [];
  }

  async getTokens(chainId) {
    const id = resolveChainId(chainId);
    if (!id) throw new Error('unsupported chainId');
    const data = await this.fetchFn(`${this.baseUrl}/v1/tokens/${id}`, {
      timeoutMs: this.timeoutMs,
    });
    return Array.isArray(data) ? data : data.tokens || [];
  }

  async getQuote({
    srcChainId,
    dstChainId,
    srcTokenAddress,
    dstTokenAddress,
    amount,
    srcAddress,
    dstAddress,
    slippageTolerance = 0.005,
  }) {
    const srcId = resolveChainId(srcChainId);
    const dstId = resolveChainId(dstChainId);
    if (!srcId || !dstId) throw new Error('srcChainId and dstChainId are required');
    if (!srcAddress || !dstAddress) throw new Error('srcAddress and dstAddress are required');
    if (!amount || BigInt(amount) <= 0n) throw new Error('amount must be > 0');

    const params = new URLSearchParams({
      srcChainId: String(srcId),
      dstChainId: String(dstId),
      srcTokenAddress,
      dstTokenAddress,
      amount: String(amount),
      srcAddress,
      dstAddress,
      slippageTolerance: String(slippageTolerance),
    });

    const data = await this.fetchFn(
      `${this.baseUrl}/v1/quote?${params.toString()}`,
      { timeoutMs: this.timeoutMs }
    );
    return {
      provider: 'stargate',
      srcChainId: srcId,
      dstChainId: dstId,
      srcChain: CHAIN_BY_ID[srcId] || String(srcId),
      dstChain: CHAIN_BY_ID[dstId] || String(dstId),
      inputAmount: String(amount),
      outputAmount: data.amountReceived || data.amountReceivedMin,
      amountReceived: data.amountReceived,
      amountReceivedMin: data.amountReceivedMin,
      fees: data.fees,
      durationSeconds: data.duration,
      expiry: data.expiry,
      route: data.route,
      raw: data,
    };
  }

  async getLiquidity({
    chainId,
    tokenAddress,
  }) {
    const id = resolveChainId(chainId);
    if (!id) throw new Error('unsupported chainId');
    const params = new URLSearchParams({ chainId: String(id) });
    if (tokenAddress) params.set('tokenAddress', tokenAddress);
    const data = await this.fetchFn(
      `${this.baseUrl}/v1/liquidity?${params.toString()}`,
      { timeoutMs: this.timeoutMs }
    );
    return data;
  }

  async getRates(pairs = []) {
    const results = {};
    for (const pair of pairs) {
      try {
        const quote = await this.getQuote(pair);
        const key = `${quote.srcChain}->${quote.dstChain}`;
        results[key] = quote;
      } catch (err) {
        logger.warn('Stargate quote failed', {
          error: err.message,
          pair: JSON.stringify(pair),
        });
      }
    }
    return results;
  }
}

export const stargateIntegration = new StargateIntegration();
export { resolveChainId as resolveStargateChainId, CHAIN_IDS as STARGATE_CHAIN_IDS };
