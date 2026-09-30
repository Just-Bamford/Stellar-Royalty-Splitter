'use strict';

const {
  fetchOpenSeaCollection,
    fetchMagicEdenCollection,
      linkCollection,
        unlinkCollection,
          listLinkedCollections,
          } = require('../src/services/marketplace-integration');

          describe('marketplace-integration service', () => {
            const originalFetch = global.fetch;

              afterEach(() => {
                  global.fetch = originalFetch;
                      jest.clearAllMocks();
                        });

                          it('fetches and normalizes an OpenSea collection', async () => {
                              global.fetch = jest.fn()
                                    .mockResolvedValueOnce({
                                            ok: true,
                                                    json: async () => ({ name: 'Cool Cats', fees: [{ fee: 5 }] }),
                                                          })
                                                                .mockResolvedValueOnce({
                                                                        ok: true,
                                                                                json: async () => ({
                                                                                          total: { floor_price: 1.2, volume: 500 },
                                                                                                    intervals: [{ interval: 'one_day', volume: 10 }],
                                                                                                            }),
                                                                                                                  });

                                                                                                                      const result = await fetchOpenSeaCollection('cool-cats');
                                                                                                                          expect(result.marketplace).toBe('opensea');
                                                                                                                              expect(result.name).toBe('Cool Cats');
                                                                                                                                  expect(result.royaltiesEnabled).toBe(true);
                                                                                                                                      expect(result.floorPrice).toBe(1.2);
                                                                                                                                          expect(result.volume24h).toBe(10);
                                                                                                                                            });

                                                                                                                                              it('throws when slug is missing', async () => {
                                                                                                                                                  await expect(fetchOpenSeaCollection()).rejects.toThrow('slug is required');
                                                                                                                                                    });

                                                                                                                                                      it('surfaces a non-ok OpenSea response as an error', async () => {
                                                                                                                                                          global.fetch = jest.fn().mockResolvedValue({
                                                                                                                                                                ok: false,
                                                                                                                                                                      status: 404,
                                                                                                                                                                            text: async () => 'not found',
                                                                                                                                                                                });
                                                                                                                                                                                    await expect(fetchOpenSeaCollection('missing-collection')).rejects.toThrow('404');
                                                                                                                                                                                      });

                                                                                                                                                                                        it('fetches and normalizes a Magic Eden collection', async () => {
                                                                                                                                                                                            global.fetch = jest.fn()
                                                                                                                                                                                                  .mockResolvedValueOnce({
                                                                                                                                                                                                          ok: true,
                                                                                                                                                                                                                  json: async () => ({
                                                                                                                                                                                                                            name: 'DeGods',
                                                                                                                                                                                                                                      image: 'https://example.com/img.png',
                                                                                                                                                                                                                                                royalty: { sellerFeeBasisPoints: 500 },
                                                                                                                                                                                                                                                        }),
                                                                                                                                                                                                                                                              })
                                                                                                                                                                                                                                                                    .mockResolvedValueOnce({
                                                                                                                                                                                                                                                                            ok: true,
                                                                                                                                                                                                                                                                                    json: async () => ({ floorPrice: 5_000_000_000, volumeAll: 100_000_000_000 }),
                                                                                                                                                                                                                                                                                          });

                                                                                                                                                                                                                                                                                              const result = await fetchMagicEdenCollection('degods');
                                                                                                                                                                                                                                                                                                  expect(result.marketplace).toBe('magiceden');
                                                                                                                                                                                                                                                                                                      expect(result.royaltiesEnabled).toBe(true);
                                                                                                                                                                                                                                                                                                          expect(result.floorPrice).toBe(5);
                                                                                                                                                                                                                                                                                                              expect(result.volumeTotal).toBe(100);
                                                                                                                                                                                                                                                                                                                });

                                                                                                                                                                                                                                                                                                                  it('throws when symbol is missing', async () => {
                                                                                                                                                                                                                                                                                                                      await expect(fetchMagicEdenCollection()).rejects.toThrow('symbol is required');
                                                                                                                                                                                                                                                                                                                        });

                                                                                                                                                                                                                                                                                                                          it('links, lists and unlinks a collection', () => {
                                                                                                                                                                                                                                                                                                                              const entry = linkCollection({
                                                                                                                                                                                                                                                                                                                                    marketplace: 'opensea',
                                                                                                                                                                                                                                                                                                                                          collectionKey: 'cool-cats',
                                                                                                                                                                                                                                                                                                                                                contractId: 'CONTRACT123',
                                                                                                                                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                                                                                                                                        expect(entry.contractId).toBe('CONTRACT123');
                                                                                                                                                                                                                                                                                                                                                            expect(listLinkedCollections()).toContainEqual(expect.objectContaining({ contractId: 'CONTRACT123' }));

                                                                                                                                                                                                                                                                                                                                                                const removed = unlinkCollection({ marketplace: 'opensea', collectionKey: 'cool-cats' });
                                                                                                                                                                                                                                                                                                                                                                    expect(removed).toBe(true);
                                                                                                                                                                                                                                                                                                                                                                        expect(listLinkedCollections()).not.toContainEqual(expect.objectContaining({ contractId: 'CONTRACT123' }));
                                                                                                                                                                                                                                                                                                                                                                          });

                                                                                                                                                                                                                                                                                                                                                                            it('rejects linking without required fields', () => {
                                                                                                                                                                                                                                                                                                                                                                                expect(() => linkCollection({ marketplace: 'opensea' })).toThrow();
                                                                                                                                                                                                                                                                                                                                                                                  });
                                                                                                                                                                                                                                                                                                                                                                                  });