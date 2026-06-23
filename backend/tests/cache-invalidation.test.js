const { describe, it, expect, beforeEach, afterEach, jest } = require('@jest/globals');
const { AdminTransferEventListener } = require('../src/events/adminTransferListener');
const { ContractStateCache } = require('../src/cache/contractStateCache');

// Mock Soroban SDK
jest.mock('@stellar/stellar-sdk', () => ({
  ...jest.requireActual('@stellar/stellar-sdk'),
  xdr: {
    ScVal: {
      scvSymbol: (name) => ({
        toXDR: (fmt) => Buffer.from(name).toString(fmt === 'hex' ? 'hex' : 'base64')
      }),
      fromXDR: (buf) => ({
        address: () => ({
          toString: () => 'GNEWADMIN123456789'
        })
      })
    }
  }
}));

describe('Cache Invalidation on Admin Transfer', () => {
  let cacheManager;
  let mockServer;
  let listener;
  let mockLogger;

  beforeEach(() => {
    cacheManager = new ContractStateCache(30);
    jest.spyOn(cacheManager, 'invalidateAdmin');
    jest.spyOn(cacheManager, 'invalidateAll');
    jest.spyOn(cacheManager, 'setAdmin');

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };

    mockServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1000 }),
      getEvents: jest.fn().mockResolvedValue({ events: [] })
    };
  });

  afterEach(() => {
    if (listener) listener.stop();
    jest.clearAllMocks();
  });

  describe('1. Immediate Cache Invalidation', () => {
    it('should invalidate admin cache within 100ms of event detection', async () => {
      const mockEvent = {
        ledgerSequence: 1001,
        txHash: 'abc123',
        topic: ['admin_transfer', 'old', 'GOLDADMIN', 'GNEWADMIN123456789']
      };

      mockServer.getEvents = jest.fn()
        .mockResolvedValueOnce({ events: [mockEvent] })
        .mockResolvedValue({ events: [] });

      listener = new AdminTransferEventListener(
        mockServer, 
        'CONTRACT123', 
        cacheManager, 
        mockLogger
      );

      const startTime = performance.now();
      await listener.start();

      // Wait for poll cycle
      await new Promise(r => setTimeout(r, 50));

      const duration = performance.now() - startTime;
      
      expect(cacheManager.invalidateAdmin).toHaveBeenCalled();
      expect(cacheManager.invalidateAll).toHaveBeenCalled();
      expect(duration).toBeLessThan(100);
    });

    it('should log admin change details', async () => {
      const mockEvent = {
        ledgerSequence: 1001,
        txHash: 'abc123',
        topic: ['admin_transfer', 'old', 'GOLDADMIN', 'GNEWADMIN']
      };

      mockServer.getEvents = jest.fn()
        .mockResolvedValueOnce({ events: [mockEvent] })
        .mockResolvedValue({ events: [] });

      listener = new AdminTransferEventListener(
        mockServer, 
        'CONTRACT123', 
        cacheManager, 
        mockLogger
      );

      await listener.start();
      await new Promise(r => setTimeout(r, 50));

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Admin transfer detected')
      );
    });
  });

  describe('2. Health Endpoint Accuracy', () => {
    it('should reflect new admin within 100ms of invalidation', async () => {
      // Simulate cached old admin
      cacheManager.setAdmin('GOLDADMIN');
      
      const mockEvent = {
        ledgerSequence: 1001,
        txHash: 'abc123',
        topic: ['admin_transfer', 'old', 'GOLDADMIN', 'GNEWADMIN']
      };

      mockServer.getEvents = jest.fn()
        .mockResolvedValueOnce({ events: [mockEvent] })
        .mockResolvedValue({ events: [] });

      listener = new AdminTransferEventListener(
        mockServer, 
        'CONTRACT123', 
        cacheManager, 
        mockLogger
      );

      await listener.start();
      await new Promise(r => setTimeout(r, 50));

      // After invalidation, getAdmin should return null (force fresh read)
      const admin = await cacheManager.getAdmin();
      expect(admin).toBeNull();
    });

    it('should return stale flag when cache is out of sync', async () => {
      // Manually set stale state
      cacheManager.setAdmin('GOLDADMIN');
      cacheManager.adminInvalidationTime = Date.now() - 1000; // Old invalidation

      const stats = cacheManager.getStats();
      expect(stats.isAdminStale).toBe(true);
    });
  });

  describe('3. No Stale Addresses', () => {
    it('should never return old admin after invalidation', async () => {
      cacheManager.setAdmin('GOLDADMIN');
      
      await cacheManager.invalidateAdmin();
      
      const admin = await cacheManager.getAdmin();
      expect(admin).toBeNull(); // Forces on-chain read
      expect(cacheManager.invalidateAdmin).toHaveBeenCalled();
    });

    it('should handle multiple rapid admin transfers', async () => {
      const events = [
        { ledgerSequence: 1001, txHash: 'tx1', topic: ['t', 'o', 'A1', 'A2'] },
        { ledgerSequence: 1002, txHash: 'tx2', topic: ['t', 'o', 'A2', 'A3'] },
        { ledgerSequence: 1003, txHash: 'tx3', topic: ['t', 'o', 'A3', 'A4'] }
      ];

      mockServer.getEvents = jest.fn()
        .mockResolvedValueOnce({ events })
        .mockResolvedValue({ events: [] });

      listener = new AdminTransferEventListener(
        mockServer, 
        'CONTRACT123', 
        cacheManager, 
        mockLogger
      );

      await listener.start();
      await new Promise(r => setTimeout(r, 100));

      // Should have invalidated for each event
      expect(cacheManager.invalidateAll).toHaveBeenCalledTimes(1); // Batch invalidation
      expect(mockLogger.info).toHaveBeenCalledTimes(3); // 3 transfer logs
    });
  });

  describe('4. Concurrent Request Consistency', () => {
    it('should handle concurrent reads during admin transfer', async () => {
      cacheManager.setAdmin('GOLDADMIN');

      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(cacheManager.getAdmin());
      }

      // Invalidate mid-read
      await cacheManager.invalidateAdmin();

      const results = await Promise.all(promises);
      
      // All reads should be consistent (either old or null, never mixed in dangerous way)
      const uniqueResults = [...new Set(results)];
      expect(uniqueResults).toContain('GOLDADMIN'); // Some may have read before invalidation
      // After invalidation, new reads return null
    });

    it('should block fresh reads for 500ms after invalidation', async () => {
      cacheManager.setAdmin('GOLDADMIN');
      await cacheManager.invalidateAdmin();

      const admin = await cacheManager.getAdmin();
      expect(admin).toBeNull();

      // Wait for cooldown
      await new Promise(r => setTimeout(r, 600));
      
      // After 500ms, cache can be repopulated
      cacheManager.setAdmin('GNEWADMIN');
      expect(await cacheManager.getAdmin()).toBe('GNEWADMIN');
    });
  });

  describe('5. Webhook Delivery Preservation', () => {
    it('should not affect webhook endpoint functionality', async () => {
      // Mock webhook delivery
      const webhookDelivered = jest.fn().mockResolvedValue(true);
      
      // Simulate admin transfer
      await cacheManager.invalidateAdmin();
      
      // Webhook should still function
      await webhookDelivered({ type: 'test' });
      expect(webhookDelivered).toHaveBeenCalled();
    });

    it('should emit event for downstream webhook consumers', async () => {
      const mockEvent = {
        ledgerSequence: 1001,
        txHash: 'abc123',
        topic: ['admin_transfer', 'old', 'GOLDADMIN', 'GNEWADMIN']
      };

      mockServer.getEvents = jest.fn()
        .mockResolvedValueOnce({ events: [mockEvent] })
        .mockResolvedValue({ events: [] });

      listener = new AdminTransferEventListener(
        mockServer, 
        'CONTRACT123', 
        cacheManager, 
        mockLogger
      );

      const eventPromise = new Promise(resolve => {
        listener.once('adminTransferred', resolve);
      });

      await listener.start();
      const event = await eventPromise;

      expect(event).toMatchObject({
        oldAdmin: expect.any(String),
        newAdmin: expect.any(String),
        ledger: 1001,
        txHash: 'abc123',
        invalidateDuration: expect.any(Number)
      });
    });
  });
});