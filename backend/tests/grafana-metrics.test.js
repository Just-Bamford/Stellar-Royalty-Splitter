/**
 * Custom metrics behind the Grafana dashboards (#935).
 */
import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import {
  prometheusMetrics,
  resetMetrics,
  recordDistributionLatency,
  recordDistributionGas,
  recordDistributionOutcomeMetric,
  recordSecondarySaleProcessing,
  recordSecondaryRoyaltyAccrued,
  recordSecondaryRoyaltyDistributed,
  setSecondaryRoyaltyPoolSource,
  recordCollaboratorPayout,
  recordContractStateChange,
} from "../src/metrics.js";

describe("#935 dashboard metrics", () => {
  beforeEach(() => resetMetrics());
  afterEach(() => setSecondaryRoyaltyPoolSource(null));

  test("distribution latency is a histogram per phase", async () => {
    recordDistributionLatency("simulation", 120);
    recordDistributionLatency("build", 300);
    recordDistributionLatency("submission", 8000);
    recordDistributionLatency("submission", -5); // ignored

    const text = await prometheusMetrics();
    expect(text).toMatch(/stellar_distribution_latency_seconds_bucket\{le="0.25",phase="simulation"\} 1/);
    expect(text).toMatch(/stellar_distribution_latency_seconds_count\{phase="build"\} 1/);
    expect(text).toMatch(/stellar_distribution_latency_seconds_count\{phase="submission"\} 1/);
  });

  test("gas usage accepts numeric strings and ignores garbage", async () => {
    recordDistributionGas("54321");
    recordDistributionGas(undefined);
    recordDistributionGas("not-a-number");

    const text = await prometheusMetrics();
    expect(text).toMatch(/stellar_distribution_gas_stroops_count 1/);
    expect(text).toMatch(/stellar_distribution_gas_stroops_sum 54321/);
  });

  test("distribution outcomes and secondary sale processing", async () => {
    recordDistributionOutcomeMetric("built");
    recordDistributionOutcomeMetric("confirmed");
    recordSecondarySaleProcessing(400);

    const text = await prometheusMetrics();
    expect(text).toMatch(/stellar_distributions_total\{outcome="built"\} 1/);
    expect(text).toMatch(/stellar_distributions_total\{outcome="confirmed"\} 1/);
    expect(text).toMatch(/stellar_secondary_sale_processing_seconds_count 1/);
  });

  test("secondary royalty accrual, distribution, and pool gauge", async () => {
    recordSecondaryRoyaltyAccrued("CA", 500);
    recordSecondaryRoyaltyAccrued("CA", 250);
    recordSecondaryRoyaltyDistributed("CA", 600n);
    setSecondaryRoyaltyPoolSource(() => [{ contractId: "CA", pending: 150 }]);

    const text = await prometheusMetrics();
    expect(text).toMatch(/stellar_secondary_royalty_accrued_total\{contractId="CA"\} 750/);
    expect(text).toMatch(/stellar_secondary_royalty_distributed_total\{contractId="CA"\} 600/);
    expect(text).toMatch(/stellar_secondary_royalty_pool_pending\{contractId="CA"\} 150/);
  });

  test("a failing pool source does not break the scrape", async () => {
    setSecondaryRoyaltyPoolSource(() => {
      throw new Error("db locked");
    });
    const text = await prometheusMetrics();
    expect(text).toMatch(/# TYPE stellar_secondary_royalty_pool_pending gauge/);
    expect(text).toMatch(/stellar_distribute_calls_total/);
  });

  test("collaborator payouts track earnings and frequency", async () => {
    recordCollaboratorPayout("CA", "GCOLLAB1", "1000");
    recordCollaboratorPayout("CA", "GCOLLAB1", 500);

    const text = await prometheusMetrics();
    expect(text).toMatch(/stellar_collaborator_earnings_total\{contractId="CA",collaborator="GCOLLAB1"\} 1500/);
    expect(text).toMatch(/stellar_collaborator_payouts_total\{contractId="CA",collaborator="GCOLLAB1"\} 2/);
  });

  test("contract state changes are counted per action", async () => {
    recordContractStateChange("CA", "royalty_rate_set");
    recordContractStateChange("CA", "royalty_rate_set");

    const text = await prometheusMetrics();
    expect(text).toMatch(/stellar_contract_state_changes_total\{contractId="CA",action="royalty_rate_set"\} 2/);
  });
});
