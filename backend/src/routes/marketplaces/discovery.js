'use strict';

const express = require('express');
const svc = require('../../services/marketplace-integration');

const router = express.Router();

/** GET /api/v1/marketplaces/opensea/:slug — collection metadata + stats */
router.get('/opensea/:slug', async (req, res) => {
  try {
      const data = await svc.fetchOpenSeaCollection(req.params.slug);
          res.json(data);
            } catch (err) {
                res.status(err.status && err.status < 500 ? 502 : 500).json({ error: err.message });
                  }
                  });

                  /** GET /api/v1/marketplaces/magiceden/:symbol — collection metadata + stats */
                  router.get('/magiceden/:symbol', async (req, res) => {
                    try {
                        const data = await svc.fetchMagicEdenCollection(req.params.symbol);
                            res.json(data);
                              } catch (err) {
                                  res.status(err.status && err.status < 500 ? 502 : 500).json({ error: err.message });
                                    }
                                    });

                                    /** POST /api/v1/marketplaces/discover  { walletAddress, chain } */
                                    router.post('/discover', async (req, res) => {
                                      try {
                                          const { walletAddress, chain } = req.body ?? {};
                                              if (!walletAddress) {
                                                    return res.status(400).json({ error: 'walletAddress is required' });
                                                        }
                                                            const collections = await svc.discoverWalletCollections({ walletAddress, chain });
                                                                res.json({ walletAddress, chain: chain ?? 'ethereum', collections });
                                                                  } catch (err) {
                                                                      res.status(400).json({ error: err.message });
                                                                        }
                                                                        });

                                                                        /** POST /api/v1/marketplaces/link  { marketplace, collectionKey, contractId } */
                                                                        router.post('/link', (req, res) => {
                                                                          try {
                                                                              const { marketplace, collectionKey, contractId } = req.body ?? {};
                                                                                  const entry = svc.linkCollection({ marketplace, collectionKey, contractId });
                                                                                      res.status(201).json(entry);
                                                                                        } catch (err) {
                                                                                            res.status(400).json({ error: err.message });
                                                                                              }
                                                                                              });

                                                                                              /** POST /api/v1/marketplaces/unlink  { marketplace, collectionKey } */
                                                                                              router.post('/unlink', (req, res) => {
                                                                                                const { marketplace, collectionKey } = req.body ?? {};
                                                                                                  const removed = svc.unlinkCollection({ marketplace, collectionKey });
                                                                                                    res.json({ removed });
                                                                                                    });

                                                                                                    /** GET /api/v1/marketplaces/linked — dashboard: currently linked collections */
                                                                                                    router.get('/linked', (_req, res) => {
                                                                                                      res.json({ collections: svc.listLinkedCollections() });
                                                                                                      });

                                                                                                      module.exports = router;