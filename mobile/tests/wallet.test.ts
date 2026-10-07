import { describe, it, expect, beforeEach } from "vitest";
import { walletService } from "../src/services/wallet";

describe("Mobile Wallet Service", () => {
  beforeEach(async () => {
    await walletService.disconnect();
  });

  it("generates correct MetaMask Mobile deep links", () => {
    const link = walletService.createMetaMaskDeepLink("https://stellar-royalty.app/dashboard");
    expect(link).toBe("https://metamask.app.link/dapp/stellar-royalty.app/dashboard");
  });

  it("connects to Freighter mobile wallet", async () => {
    const session = await walletService.connect("freighter");
    expect(session.walletType).toBe("freighter");
    expect(session.address).toMatch(/^G[A-Z0-9]+/);
    expect(session.chainId).toBe(148);

    const active = await walletService.getActiveSession();
    expect(active?.address).toBe(session.address);
  });

  it("connects to MetaMask mobile wallet", async () => {
    const session = await walletService.connect("metamask");
    expect(session.walletType).toBe("metamask");
    expect(session.address).toMatch(/^0x/);
  });

  it("signs transaction XDR when connected", async () => {
    await walletService.connect("freighter");
    const signature = await walletService.signTransaction({
      xdr: "AAAAAG2X8P39129038102938102938102938102938",
    });

    expect(signature).toContain("SIGNED_AAAAAG2X8P3912903810293810293810");
  });

  it("throws error when signing without an active session", async () => {
    await expect(
      walletService.signTransaction({ xdr: "AAAAA..." }),
    ).rejects.toThrow("No active mobile wallet session");
  });

  it("signs messages when connected", async () => {
    await walletService.connect("freighter");
    const sig = await walletService.signMessage("Verify ownership");
    expect(sig).toContain("SIG_");
  });

  it("disconnects active wallet session", async () => {
    await walletService.connect("freighter");
    await walletService.disconnect();
    const active = await walletService.getActiveSession();
    expect(active).toBeNull();
  });
});
