import { describe, it, expect, beforeEach } from "vitest";
import { useTransactionStore } from "../transactionsStore";

describe("transactionsStore", () => {
  beforeEach(() => {
    useTransactionStore.setState({ current: null });
  });

  it("initializes with current transaction as null", () => {
    expect(useTransactionStore.getState().current).toBeNull();
  });

  it("beginTransaction sets current transaction to building phase", () => {
    useTransactionStore.getState().beginTransaction();
    const current = useTransactionStore.getState().current;
    expect(current).not.toBeNull();
    expect(current?.phase).toBe("building");
    expect(current?.label).toBe("Building transaction…");
    expect(current?.errorMessage).toBeNull();
  });

  it("updatePhase transitions phase and updates entry metadata", () => {
    useTransactionStore.getState().beginTransaction();
    useTransactionStore.getState().updatePhase("signing");

    let current = useTransactionStore.getState().current;
    expect(current?.phase).toBe("signing");
    expect(current?.label).toBe("Signing with Freighter…");

    useTransactionStore.getState().updatePhase("confirming", {
      txHash: "0x123456789",
      transactionId: 42,
    });

    current = useTransactionStore.getState().current;
    expect(current?.phase).toBe("confirming");
    expect(current?.txHash).toBe("0x123456789");
    expect(current?.transactionId).toBe(42);
    expect(current?.confirmingStartedAt).not.toBeNull();

    useTransactionStore.getState().updatePhase("failed", {
      error: "User cancelled signing",
    });

    current = useTransactionStore.getState().current;
    expect(current?.phase).toBe("failed");
    expect(current?.errorMessage).toBe("User cancelled signing");
  });

  it("reset clears the current transaction state", () => {
    useTransactionStore.getState().beginTransaction();
    expect(useTransactionStore.getState().current).not.toBeNull();

    useTransactionStore.getState().reset();
    expect(useTransactionStore.getState().current).toBeNull();
  });
});
