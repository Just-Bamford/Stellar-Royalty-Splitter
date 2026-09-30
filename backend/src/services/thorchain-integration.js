/**
 * Thorchain integration service.
 *
 * Provides quote fetching and swap execution against the Thorchain
 * THORNode API (cross-chain Stellar <-> EVM liquidity).
 */

const { logger } = require('../utils/logger');

const DEFAULT_BASE_URL = 'https://midgard.thorchain.network';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_SWAP_SLIPPAGE_BPS = 500; // 5% max slippage

class ThorchainError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'ThorchainError';
    this.code = code || 'THAORCHAIN_ERROR';
    this.details = details || null;
  }
}

function normalizeAsset(asset) {
  if (!asset) {
    throw new ThorchainError('Asset is required', 'INVALID_ASSET');
  }
  if (typeof asset === 'string') {
    return asset.toUpperCase();
  }
  if (typeof asset === 'object') {
    const { chain, symbol, tokenAddress } = asset;
    if (!chain || !symbol) {
      throw new ThorchainError(
        'Asset object must include chain and symbol',
        'INVALID_ASSET',
        asset,
      );
    }
    const normalizedChain = String(chain).toUpperCase();
    const normalizedSymbol = String(symbol).toUpperCase();
    if (normalizedChain === 'STELLAR' || normalizedChain === 'XLM') {
      return `${normalizedChain}.${normalizedSymbol}`;
    }
    if (tokenAddress) {
      return `${normalizedChain}.${normalizedSymbol}-${tokenAddress}`;
    }
    return `${normalizedChain}.${normalizedSymbol}`;
  }
  throw new ThorchainError('Unsupported asset format', 'INVALID_ASSET', asset);
}

function toBaseUnits(amount, decimals = 8) {
  if (amount === undefined || amount === null) {
    throw new ThorchainError('Amount is required', 'INVALID_AMOUNT');
  }
  const asString = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(asString)) {
    throw new ThorchainError('Amount must be a positive numeric value', 'INVALID_AMOUNT', amount);
  }
  const parts = asString.split('.');
  const whole = parts[0];
  const frac = parts[1] ?? '';
  if (frac.length > decimals) {
    throw new ThorchainError(
      `Amount has more than ${decimals} decimal places`,
      'INVALID_AMOUNT',
      amount,
    );
  }
  const paddedFrac = frac.padEnd(decimals, '0');
  return BigInt(`${whole}${paddedFrac}`).toString();
}

function fromBaseUnits(amount, decimals = 8) {
  if (amount === undefined || amount === null) {
    return '0';
  }
  const str = BigInt(String(amount)).toString();
  if (decimals === 0) {
    return str;
  }
  const negative = str.startsWith('-');
  const digits = negative ? str.slice(1) : str;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  const result = frac ? `${whole}.${frac}` : whole;
  return negative ? `-${result}` : result;
}

class ThorchainIntegration {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || process.env.THAORCHAIN_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new ThorchainError(
        'A fetch implementation is required (Node 18+ or injoined)',
        'NO_FETCH',
      );
    }
  }

  async _request(path, query = {}) {
    const url = new URL(this.baseUrl + path);
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.append(key, String(value));
      }
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new ThorchainError(
          `Thorchain request timed out after ${this.timeoutMs}ms`,
          'TIMEOUT',
          { path, query },
        );
      }
      throw new ThorchainError(
        `Thorchain request failed: ${err.message}`,
        'NETWORK_ERROR',
        { path, query },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ThorchainError(
        `Thorchain API returned ${response.status}`,
        'HTTP_ERROR',
        { status: response.status, body, path },
      );
    }

    try {
      return await response.json();
    } catch (err) {
      throw new ThorchainError(
        'Thorchain API returned invalid JSON',
        'INVALID_RESPONSE',
        { path },
      );
    }
  }

  async getPools() {
    const data = await this._request('/cosmos/bankbase/v1/pools');
    return Array.isArray(data) ? data : [];
  }

 async getPool(asset) {
    const normalized = normalizeAsset(asset);
    const data = await this._request('/cosmos/bankbase/v1/pool', { asset: normalized });
    return data;
  }

  async getInboundAddresses() {
    const data = await this._request('/thorchain/inbound_addresses');
    return data || {};
  }

  async getQuote(params) {
    const {
      fromAsset,
      toAsset,
      amount,
      amountDecimals = 8,
      affiliate,
      affiliateBps,
    } = params || {};

    const normalizedFrom = normalizeAsset(fromAsset);
    const normalizedTo = normalizeAsset(toAsset);
    const baseAmount = toBaseUnits(amount, amountDecimals);

    const data = await this._request('/thorchain/quote', {
      from_asset: normalizedFrom,
      to_asset: normalizedTo,
      amount: baseAmount,
      affiliate,
      affiliate_basis_points: affiliate ? String(affiliateBps ?? 0) : undefined,
    });

    const expectedOut = data.expected_amount_out || data.expected_amount_out_base || '0';
    const inboundAddress = data.inbound_address || data.inbound_addresses || null;
    const expectedDecimals = data.expected_amount_out_decimals ?? 8;

    return {
      provider: 'thorchain',
      fromAsset: normalizedFrom,
      toAsset: normalizedTo,
      amountIn: baseAmount,
      amountInDecimals: amountDecimals,
      expectedAmountOut: String(expectedOut),
      expectedAmountOutDecimals: expectedDecimals,
      expectedAmountOutFormatted: fromBaseUnits(expectedOut, expectedDecimals),
      expiry: data.expiry || null,
      inboundAddress: inboundAddress,
      outboundDelay: data.outbound_delay || null,
      slippageBps: data.recommended_min_out_in_bps || null,
      raw: data,
    };
  }

  async getSwapPayload(params) {
    const {
      fromAsset,
      toAsset,
      amount,
      amountDecimals = 8,
      destinationAddress,
      affiliate,
      affiliateBps = 0,
      slippageBps = DEFAULT_SWAP_SLIPPAGE_BPS,
    } = params || {};

    if (!destinationAddress) {
      throw new ThorchainError(
        'destinationAddress is required',
        'MISSING_DESTINATION',
      );
    }

    const normalizedFrom = normalizeAsset(fromAsset);
    const normalizedTo = normalizeAsset(toAsset);
    const baseAmount = toBaseUnits(amount, amountDecimals);

    const quote = await this.getQuote({
      fromAsset: normalizedFrom,
      toAsset: normalizedTo,
      amount,
      amountDecimals,
      affiliate,
    });

    const expectedOut = BigInt(quote.expectedAmountOut || '0');
    const minOut = (expectedOut * BigInt(10000 - Number(slippageBps))) / BigInt(10000);

    const memoParts = [
      '=:',
      normalizedTo,
      destinationAddress,
      '/',
      minOut.toString(),
    ];
    if (affiliate) {
      memoParts.push(`:${affiliate}:${affiliateBps}`);
    }

    return {
      provider: 'thorchain',
      memo: memoParts.join(''),
      inboundAddress: quote.inboundAddress,
      amountIn: baseAmount,
      amountInDecimals: amountDecimals,
      minOut: minOut.toString(),
      expectedAmountOut: quote.expectedAmountOut,
      expiry: quote.expiry,
      quote,
    };
  }

  async getTransactionStatus(txid) {
    if (!txid) {
      throw new ThorchainError('txid is required', 'MISSING_TXHASH');
    }
    const data = await this._request('/thorchain/tx/status', { txid: String(txid).toUpperCase() });
    return data;
  }

  async getAvailableLiquidity(asset) {
    const pool = await this.getPool(asset);
    const decimals = Number(pool.decimals ?? 8);
    const balanceAsset = BigInt(pool.balance_asset || '0');
    const balanceRune = BigInt(pool.balance_rune || '0');
    return {
      asset: pool.asset,
      status: pool.status,
      balanceAsset: balanceAsset.toString(),
      balanceAssetFormatted: fromBaseUnits(balanceAsset, decimals),
      balanceRune: balanceRune.toString(),
      balanceRuneFormatted: fromBaseUnits(balanceRune, 8),
      decimals,
    };
  }
}

module.exports = {
  ThorchainIntegration,
  ThorchainError,
  normalizeAsset,
  toBaseUnits,
  fromBaseUnits,
  DEFAULT_SWAP_SLIPPAGE_BPS,
};
