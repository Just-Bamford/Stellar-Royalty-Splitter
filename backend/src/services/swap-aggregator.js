/**
 * Token Swap Aggregator (#974)
 * 
 * Queries multiple DEXes to find the best rates for token swaps
 * Supports: Stellar DEX, and external aggregators
 * 
 * Usage:
 *   const bestRate = await findBestSwapRate(fromAsset, toAsset, amount);
 *   const result = await executeSwap(fromAsset, toAsset, amount, bestRate.provider);
 */

import { Asset, Server, TransactionBuilder, Operation, Networks } from "@stellar/stellar-sdk";
import logger from "../logger.js";
import { startSpan } from "../tracing.js";

const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon.stellar.org";
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK ?? Networks.PUBLIC;

// DEX provider configurations
const PROVIDERS = {
  STELLAR_DEX: {
    name: "Stellar DEX",
    enabled: true,
    priority: 1,
  },
  // Future: Add more DEX integrations
  // ONE_INCH: {
  //   name: "1inch",
  //   enabled: process.env.ONEINCH_API_KEY ? true : false,
  //   apiKey: process.env.ONEINCH_API_KEY,
  //   priority: 2,
  // },
  // ZERO_X: {
  //   name: "0x Protocol",
  //   enabled: process.env.ZEROX_API_KEY ? true : false,
  //   apiKey: process.env.ZEROX_API_KEY,
  //   priority: 3,
  // },
};

/**
 * Parse Stellar asset from string
 * Format: "native" or "CODE:ISSUER"
 */
function parseAsset(assetString) {
  if (assetString === "native" || assetString === "XLM") {
    return Asset.native();
  }
  const [code, issuer] = assetString.split(":");
  if (!code || !issuer) {
    throw new Error(`Invalid asset format: ${assetString}`);
  }
  return new Asset(code, issuer);
}

/**
 * Query Stellar DEX for path payment rates
 * Uses path finding to discover best routes
 */
async function queryStellarDEX(sourceAsset, destAsset, amount) {
  return startSpan("swap_aggregator.stellar_dex", {
    source_asset: sourceAsset.toString(),
    dest_asset: destAsset.toString(),
    amount,
  }, async () => {
    try {
      const server = new Server(HORIZON_URL);
      
      // Use strict send path finding to get exact source amount
      const pathsResponse = await server
        .strictSendPaths(sourceAsset, amount, [destAsset])
        .call();

      if (!pathsResponse.records || pathsResponse.records.length === 0) {
        logger.info("No paths found on Stellar DEX", {
          source: sourceAsset.toString(),
          dest: destAsset.toString(),
          amount,
        });
        return null;
      }

      // Get the best path (first result is best)
      const bestPath = pathsResponse.records[0];
      
      const rate = parseFloat(bestPath.destination_amount) / parseFloat(amount);
      
      return {
        provider: "STELLAR_DEX",
        providerName: "Stellar DEX",
        sourceAmount: amount,
        destinationAmount: bestPath.destination_amount,
        rate,
        path: bestPath.path.map(p => p.asset_code || "XLM"),
        estimatedFee: "0.00001", // Base fee in XLM
        estimatedTime: "5s",
        raw: bestPath,
      };
    } catch (error) {
      logger.warn("Stellar DEX query failed", {
        error: error.message,
        source: sourceAsset.toString(),
        dest: destAsset.toString(),
      });
      return null;
    }
  });
}

/**
 * Query all enabled DEX providers for rates
 * Returns array of quotes sorted by best rate
 */
export async function findBestSwapRate(sourceAssetString, destAssetString, amount) {
  return startSpan("swap_aggregator.find_best_rate", {
    source_asset: sourceAssetString,
    dest_asset: destAssetString,
    amount,
  }, async () => {
    const sourceAsset = parseAsset(sourceAssetString);
    const destAsset = parseAsset(destAssetString);
    
    const quotes = [];

    // Query Stellar DEX
    if (PROVIDERS.STELLAR_DEX.enabled) {
      const stellarQuote = await queryStellarDEX(sourceAsset, destAsset, amount);
      if (stellarQuote) {
        quotes.push(stellarQuote);
      }
    }

    // Future: Query other DEXes in parallel
    // const promises = [];
    // if (PROVIDERS.ONE_INCH.enabled) {
    //   promises.push(queryOneInch(sourceAsset, destAsset, amount));
    // }
    // if (PROVIDERS.ZERO_X.enabled) {
    //   promises.push(queryZeroX(sourceAsset, destAsset, amount));
    // }
    // const results = await Promise.allSettled(promises);
    // results.forEach(result => {
    //   if (result.status === "fulfilled" && result.value) {
    //     quotes.push(result.value);
    //   }
    // });

    if (quotes.length === 0) {
      throw new Error("No swap routes found across any DEX");
    }

    // Sort by rate (highest first - more destination tokens per source token)
    quotes.sort((a, b) => b.rate - a.rate);

    const bestQuote = quotes[0];
    const savings = quotes.length > 1 
      ? ((bestQuote.rate - quotes[quotes.length - 1].rate) / quotes[quotes.length - 1].rate * 100).toFixed(2)
      : 0;

    logger.info("Best swap rate found", {
      provider: bestQuote.providerName,
      rate: bestQuote.rate,
      destinationAmount: bestQuote.destinationAmount,
      totalQuotes: quotes.length,
      savings: `${savings}%`,
    });

    return {
      best: bestQuote,
      alternatives: quotes.slice(1),
      savings: `${savings}%`,
    };
  });
}

/**
 * Execute a swap using the specified provider
 * For Stellar DEX, this creates a path payment operation
 */
export async function executeSwap(
  sourceAssetString,
  destAssetString,
  amount,
  provider = "STELLAR_DEX",
  { 
    sourceKeypair, 
    destAddress,
    minDestAmount,
  } = {}
) {
  return startSpan("swap_aggregator.execute_swap", {
    provider,
    source_asset: sourceAssetString,
    dest_asset: destAssetString,
    amount,
  }, async () => {
    if (!sourceKeypair || !destAddress) {
      throw new Error("sourceKeypair and destAddress are required");
    }

    if (provider === "STELLAR_DEX") {
      return executeStellarDEXSwap(
        sourceAssetString,
        destAssetString,
        amount,
        sourceKeypair,
        destAddress,
        minDestAmount
      );
    }

    throw new Error(`Unsupported swap provider: ${provider}`);
  });
}

/**
 * Execute swap on Stellar DEX using path payment
 */
async function executeStellarDEXSwap(
  sourceAssetString,
  destAssetString,
  amount,
  sourceKeypair,
  destAddress,
  minDestAmount
) {
  const sourceAsset = parseAsset(sourceAssetString);
  const destAsset = parseAsset(destAssetString);
  
  const server = new Server(HORIZON_URL);
  
  // Load source account
  const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());
  
  // Find best path
  const pathsResponse = await server
    .strictSendPaths(sourceAsset, amount, [destAsset])
    .call();

  if (!pathsResponse.records || pathsResponse.records.length === 0) {
    throw new Error("No swap path found");
  }

  const bestPath = pathsResponse.records[0];
  const destAmountStr = bestPath.destination_amount;
  
  // Apply slippage tolerance (default 1%)
  const slippageTolerance = parseFloat(process.env.SWAP_SLIPPAGE_TOLERANCE ?? "0.01");
  const minDestAmountCalc = minDestAmount ?? 
    (parseFloat(destAmountStr) * (1 - slippageTolerance)).toFixed(7);

  // Build transaction
  const transaction = new TransactionBuilder(sourceAccount, {
    fee: await server.fetchBaseFee(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: sourceAsset,
        sendAmount: amount,
        destination: destAddress,
        destAsset: destAsset,
        destMin: minDestAmountCalc.toString(),
        path: bestPath.path.map(p => {
          if (p.asset_type === "native") {
            return Asset.native();
          }
          return new Asset(p.asset_code, p.asset_issuer);
        }),
      })
    )
    .setTimeout(30)
    .build();

  transaction.sign(sourceKeypair);

  // Submit transaction
  const result = await server.submitTransaction(transaction);

  logger.info("Swap executed successfully", {
    provider: "Stellar DEX",
    txHash: result.hash,
    sourceAmount: amount,
    destAmount: destAmountStr,
  });

  return {
    success: true,
    txHash: result.hash,
    provider: "Stellar DEX",
    sourceAmount: amount,
    destinationAmount: destAmountStr,
    ledger: result.ledger,
  };
}

/**
 * Get swap rate history for analytics
 * Useful for tracking rate trends over time
 */
export async function getSwapRateHistory(
  sourceAssetString,
  destAssetString,
  { hours = 24, interval = 60 } = {}
) {
  return startSpan("swap_aggregator.rate_history", {
    source_asset: sourceAssetString,
    dest_asset: destAssetString,
    hours,
  }, async () => {
    const sourceAsset = parseAsset(sourceAssetString);
    const destAsset = parseAsset(destAssetString);
    
    const server = new Server(HORIZON_URL);
    
    // Get trade aggregations (OHLC data)
    const now = Date.now();
    const startTime = now - hours * 60 * 60 * 1000;
    
    try {
      const trades = await server
        .tradeAggregation(sourceAsset, destAsset, startTime, now, interval * 60 * 1000, 0)
        .limit(200)
        .call();

      const history = trades.records.map(record => ({
        timestamp: parseInt(record.timestamp),
        open: parseFloat(record.open),
        high: parseFloat(record.high),
        low: parseFloat(record.low),
        close: parseFloat(record.close),
        volume: parseFloat(record.base_volume),
        tradeCount: parseInt(record.counter),
      }));

      return {
        sourceAsset: sourceAssetString,
        destAsset: destAssetString,
        period: { hours, interval },
        data: history,
      };
    } catch (error) {
      logger.warn("Failed to fetch swap rate history", {
        error: error.message,
        source: sourceAssetString,
        dest: destAssetString,
      });
      return {
        sourceAsset: sourceAssetString,
        destAsset: destAssetString,
        period: { hours, interval },
        data: [],
      };
    }
  });
}

/**
 * Estimate swap output amount without executing
 * Useful for UI previews
 */
export async function estimateSwapOutput(sourceAssetString, destAssetString, amount) {
  const result = await findBestSwapRate(sourceAssetString, destAssetString, amount);
  return {
    inputAmount: amount,
    outputAmount: result.best.destinationAmount,
    rate: result.best.rate,
    provider: result.best.providerName,
    path: result.best.path,
    estimatedFee: result.best.estimatedFee,
    estimatedTime: result.best.estimatedTime,
    savings: result.savings,
  };
}
