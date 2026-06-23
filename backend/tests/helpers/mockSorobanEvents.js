export function createAdminTransferEvent(oldAdmin, newAdmin, ledger = 1000, txHash = "mocktx") {
  return {
    ledgerSequence: ledger,
    txHash,
    topic: ["admin_transfer", "previous_admin", oldAdmin, newAdmin],
    value: { _arm: "void", value: null },
  };
}

export function createMockSorobanServer() {
  return {
    getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1000 }),
    getEvents: jest.fn().mockResolvedValue({ events: [] }),
    simulateTransaction: jest.fn().mockResolvedValue({
      result: { retval: { toString: () => "GNEWADMIN" } },
    }),
  };
}