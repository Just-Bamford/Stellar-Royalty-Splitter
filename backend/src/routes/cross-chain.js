import express from 'express';
import { crossChainRouter } from '../services/cross-chain-router.js';import { thorchainIntegration } from '../services/thorchain-integration.js';
import { stargateIntegration } from '../services/stargate-integration.js';
import logger from '../logger.js';

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.get('/health', asyncHandler(async (_req, res) => {
  const [thor, star] = await Promise.allSettled([
    thorchainIntegration.getPools(),
    stargateIntegration.getChains(),
  ]);
  res.json({
    thorchain: thor.status === 'fulfilled',
    stargate: star.status === 'fulfilled',
  });
}));

router.get('/rates', asyncHandler(async (req, res) => {
  const { assets } = req.query;
  const assetList = assets ? String(assets).split(',') : [];
  const thorRates = await thorchainIntegration.getRates(assetList);
  res.json({ thorchain: thorRates });
}));

router.post('/quote', asyncHandler(async (req, res) => {
  const {
    amount,
    thorchainParams,
    stargateParams,
    allowSplit,
    slippage,
  } = req.body || {};
  if (!amount) return res.status(400).json({ error: 'amount is required' });
  try {
    const routeResult = await crossChainRouter.route({
      amount,
      thorchainParams,
      stargateParams,
      allowSplit,
      slippage,
    });
    res.json(routeResult);
  } catch (err) {
    logger.warn('Quote request failed', { error: err.message });
    res.status(422).json({ error: err.message });
  }
}));

router.post('/execute', asyncHandler(async (req, res) => {
  const { amount, thorchainParams, stargateParams, allowSplit, slippage } = req.body || {};
  if (!amount) return res.status(400).json({ error: 'amount is required' });
  try {
    const routeResult = await crossChainRouter.route({
      amount,
      thorchainParams,
      stargateParams,
      allowSplit,
      slippage,
    });
    const result = await crossChainRouter.execute(routeResult);
    res.json({ route: routeResult, execution: result });
  } catch (err) {
    logger.error('Execution request failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}));

router.get('/thorchain/pools', asyncHandler(async (_req, res) => {
  const pools = await thorchainIntegration.getPools();
  res.json({ pools });
}));

router.get('/thorchain/pool/:asset', asyncHandler(async (req, res) => {
  const liquidity = await thorchainIntegration.getLiquidity(req.params.asset);
  res.json(liquidity);
}));

router.get('/thorchain/tx/:txid', asyncHandler(async (req, res) => {
  const tx = await thorchainIntegration.getTxStatus(req.params.txid);
  res.json(tx);
}));

router.get('/stargate/chains', asyncHandler(async (_req, res) => {
  const chains = await stargateIntegration.getChains();
  res.json({ chains });
}));

router.get('/stargate/tokens/:chainId', asyncHandler(async (req, res) => {
  const tokens = await stargateIntegration.getTokens(req.params.chainId);
  res.json({ tokens });
}));

router.get('/stargate/liquidity', asyncHandler(async (req, res) => {
  const { chainId, tokenAddress } = req.query;
  if (!chainId) return res.status(400).json({ error: 'chainId is required' });
  const liquidity = await stargateIntegration.getLiquidity({ chainId, tokenAddress });
  res.json(liquidity);
}));

export default router;
export { router as crossChainRouter };
