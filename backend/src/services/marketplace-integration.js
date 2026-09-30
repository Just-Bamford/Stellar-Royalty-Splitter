'use strict';

const OPENSEA_BASE = 'https://api.opensea.io/api/v2';
const MAGICEDEN_BASE = 'https://api-mainnet.magiceden.dev/v2';

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value) {
  cache.set(key, { value, at: Date.now() });
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { accept: 'application/json', ...options.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Request to ${url} failed: ${res.status} ${body}`.trim());
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchOpenSeaCollection(slug) {
  if (!slug) throw new Error('slug is required');
  const cacheKey = `opensea:${slug}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const apiKey = process.env.OPENSEA_API_KEY;
  const headers = apiKey ? { 'x-api-key': apiKey } : {};

  const [collection, stats] = await Promise.all([
    fetchJson(`${OPENSEA_BASE}/collections/${encodeURIComponent(slug)}`, { headers }),
    fetchJson(`${OPENSEA_BASE}/collections/${encodeURIComponent(slug)}/stats`, { headers }),
  ]);

  const result = {
    marketplace: 'opensea',
    slug,
    name: collection.name ?? collection.collection ?? slug,
    description: collection.description ?? null,
    imageUrl: collection.image_url ?? null,
    royaltiesEnabled: Array.isArray(collection.fees) && collection.fees.length > 0,
    fees: collection.fees ?? [],
    floorPrice: stats?.total?.floor_price ?? null,
    volume24h: stats?.intervals?.find((i) => i.interval === 'one_day')?.volume ?? null,
    volumeTotal: stats?.total?.volume ?? null,
    fetchedAt: new Date().toISOString(),
  };

  setCached(cacheKey, result);
  return result;
}

async function fetchMagicEdenCollection(symbol) {
  if (!symbol) throw new Error('symbol is required');
  const cacheKey = `magiceden:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const [collection, stats] = await Promise.all([
    fetchJson(`${MAGICEDEN_BASE}/collections/${encodeURIComponent(symbol)}`),
    fetchJson(`${MAGICEDEN_BASE}/collections/${encodeURIComponent(symbol)}/stats`),
  ]);

  const result = {
    marketplace: 'magiceden',
    symbol,
    name: collection.name ?? symbol,
    description: collection.description ?? null,
    imageUrl: collection.image ?? null,
    royaltiesEnabled: (collection.royalty?.sellerFeeBasisPoints ?? 0) > 0,
    royaltyBps: collection.royalty?.sellerFeeBasisPoints ?? 0,
    floorPrice: stats?.floorPrice != null ? stats.floorPrice / 1e9 : null,
    volume24h: null,
    volumeTotal: stats?.volumeAll != null ? stats.volumeAll / 1e9 : null,
    fetchedAt: new Date().toISOString(),
  };

  setCached(cacheKey, result);
  return result;
}

async function discoverWalletCollections({ walletAddress, chain = 'ethereum' }) {
  if (!walletAddress) throw new Error('walletAddress is required');

  if (chain === 'solana') {
    const nfts = await fetchJson(
      `${MAGICEDEN_BASE}/wallets/${encodeURIComponent(walletAddress)}/tokens`,
    ).catch(() => []);
    const bySymbol = new Map();
    for (const nft of Array.isArray(nfts) ? nfts : []) {
      const symbol = nft.collection;
      if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, true);
    }
    const collections = await Promise.all(
      [...bySymbol.keys()].map((symbol) =>
        fetchMagicEdenCollection(symbol).catch((err) => ({
          marketplace: 'magiceden',
          symbol,
          error: err.message,
        })),
      ),
    );
    return collections;
  }

  const data = await fetchJson(
    `${OPENSEA_BASE}/chain/${encodeURIComponent(chain)}/account/${encodeURIComponent(
      walletAddress,
    )}/nfts`,
    { headers: process.env.OPENSEA_API_KEY ? { 'x-api-key': process.env.OPENSEA_API_KEY } : {} },
  ).catch(() => ({ nfts: [] }));

  const slugs = new Set();
  for (const nft of data.nfts ?? []) {
    if (nft.collection) slugs.add(nft.collection);
  }

  return Promise.all(
    [...slugs].map((slug) =>
      fetchOpenSeaCollection(slug).catch((err) => ({
        marketplace: 'opensea',
        slug,
        error: err.message,
      })),
    ),
  );
}

const links = new Map();

function linkCollection({ marketplace, collectionKey, contractId }) {
  if (!marketplace || !collectionKey || !contractId) {
    throw new Error('marketplace, collectionKey and contractId are required');
  }
  const key = `${marketplace}:${collectionKey}`;
  const entry = { marketplace, collectionKey, contractId, linkedAt: new Date().toISOString() };
  links.set(key, entry);
  return entry;
}

function unlinkCollection({ marketplace, collectionKey }) {
  return links.delete(`${marketplace}:${collectionKey}`);
}

function listLinkedCollections() {
  return [...links.values()];
}

module.exports = {
  fetchOpenSeaCollection,
  fetchMagicEdenCollection,
  discoverWalletCollections,
  linkCollection,
  unlinkCollection,
  listLinkedCollections,
};