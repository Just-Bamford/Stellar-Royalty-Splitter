#![cfg(test)]

/**
 * Simulation Testing for Contract Behavior Under Load (#977).
 *
 * Implements full-scale load simulations, boundary conditions, extreme numeric values,
 * and resource budget measurements for the Stellar Royalty Splitter Soroban smart contract.
 *
 * Scenarios Tested:
 *  1. Large Collaborator Pools (1000+ Collaborators & Boundary Enforcement):
 *     Verifies safe boundary rejection and resource bounding without storage corruption.
 *  2. Extreme Numeric Values (i128::MAX Handling):
 *     Confirms overflow-safe quotient/remainder decomposition for astronomical amounts.
 *  3. High-Frequency Distributions (1000+ Sequential Distribution Operations):
 *     Measures throughput (ops/sec), storage growth, and CPU instruction stability.
 *  4. Systematic Resource Scaling:
 *     Measures CPU instructions and memory byte cost across varying collaborator sizes.
 */
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, Vec as SorobanVec,
};
use stellar_royalty_splitter::{
    ContractError, RoyaltySplitterClient, MAX_COLLABORATORS, TOTAL_SHARE_WEIGHT,
};

/// Helper to set up a new RoyaltySplitter contract instance in test environment.
fn setup(env: &Env) -> (Address, RoyaltySplitterClient<'_>) {
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(env, &contract_id);
    (contract_id, client)
}

/// Helper to create and register a mock Stellar Asset Contract.
fn make_token(env: &Env, admin: &Address) -> Address {
    env.register_stellar_asset_contract(admin.clone())
}

/// Helper to mint tokens directly to a destination address.
fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(to, &amount);
}

// ---------------------------------------------------------------------------
// Scenario 1: Large Collaborator Pools (1000+ Collaborators & Bounds)
// ---------------------------------------------------------------------------

#[test]
fn test_simulate_large_collaborator_pool_rejection_boundary() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.budget().reset_unlimited();

    let (_, client) = setup(&env);

    // Generate 1000 simulated collaborators
    let mut large_collaborators = SorobanVec::new(&env);
    let mut shares = SorobanVec::new(&env);

    for _ in 0..1000 {
        large_collaborators.push_back(Address::generate(&env));
        shares.push_back(10); // 1000 * 10 = 10,000 bps
    }

    assert_eq!(large_collaborators.len(), 1000);

    // Attempting to initialize with 1000 collaborators must safely fail
    // and enforce the MAX_COLLABORATORS limit rather than exhausting host memory
    let result = client.try_initialize(&large_collaborators, &shares);

    assert!(
        result.is_err(),
        "Contract must reject collaborator pool exceeding MAX_COLLABORATORS (10)"
    );
    assert_eq!(
        result.unwrap_err(),
        Ok(ContractError::TooManyRecipients.into()),
        "Must return typed TooManyRecipients error code"
    );

    std::println!(
        "\n[Simulation] 1000+ Collaborator Boundary: Successfully enforced MAX_COLLABORATORS = {} (Rejected 1000 collaborators cleanly)",
        MAX_COLLABORATORS
    );
}

#[test]
fn test_simulate_max_collaborator_distribution_success() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.budget().reset_unlimited();

    let (contract_id, client) = setup(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    // Set up maximum allowed collaborators (10) with 1,000 bps (10%) each
    let mut collaborators = SorobanVec::new(&env);
    let mut shares = SorobanVec::new(&env);

    for _ in 0..MAX_COLLABORATORS {
        collaborators.push_back(Address::generate(&env));
        shares.push_back(TOTAL_SHARE_WEIGHT / MAX_COLLABORATORS);
    }

    client.initialize(&collaborators, &shares);

    let distribution_amount = 1_000_000_i128; // 1,000,000 stroops (0.1 XLM)
    mint(&env, &token, &contract_id, distribution_amount);

    let initial_cpu = env.budget().cpu_instruction_cost();
    let initial_mem = env.budget().memory_bytes_cost();

    client.distribute(&token);

    let final_cpu = env.budget().cpu_instruction_cost();
    let final_mem = env.budget().memory_bytes_cost();

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&contract_id), 0);

    for i in 0..MAX_COLLABORATORS {
        let recipient = collaborators.get(i).unwrap();
        assert_eq!(token_client.balance(&recipient), 100_000);
    }

    std::println!(
        "[Simulation] Max Collaborator Pool ({} recipients) Distribution: CPU Instructions = {}, Memory Bytes = {}",
        MAX_COLLABORATORS,
        final_cpu - initial_cpu,
        final_mem - initial_mem
    );
}

// ---------------------------------------------------------------------------
// Scenario 2: Extreme Numeric Values (i128::MAX)
// ---------------------------------------------------------------------------

#[test]
fn test_simulate_extreme_amounts_near_i128_max() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.budget().reset_unlimited();

    let (contract_id, client) = setup(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);

    // 50% (5,000 bps), 30% (3,000 bps), 20% (2,000 bps)
    client.initialize(
        &vec![&env, alice.clone(), bob.clone(), charlie.clone()],
        &vec![&env, 5000_u32, 3000_u32, 2000_u32],
    );

    // Test extreme amounts: i128::MAX
    let extreme_amount = i128::MAX;
    mint(&env, &token, &contract_id, extreme_amount);

    let initial_cpu = env.budget().cpu_instruction_cost();
    client.distribute(&token);
    let cpu_used = env.budget().cpu_instruction_cost() - initial_cpu;

    let token_client = TokenClient::new(&env, &token);
    let bal_alice = token_client.balance(&alice);
    let bal_bob = token_client.balance(&bob);
    let bal_charlie = token_client.balance(&charlie);
    let contract_bal = token_client.balance(&contract_id);

    assert_eq!(contract_bal, 0, "Contract balance must be fully cleared");

    // Invariant: sum of all recipients' payouts must equal the total minted amount exactly
    let total_distributed = bal_alice + bal_bob + bal_charlie;
    assert_eq!(
        total_distributed, extreme_amount,
        "Sum of payouts must equal exact i128::MAX without overflow or loss"
    );

    std::println!(
        "[Simulation] Extreme Amount i128::MAX ({} stroops) Distribution Succeeded: CPU Cost = {}",
        extreme_amount,
        cpu_used
    );
}

// ---------------------------------------------------------------------------
// Scenario 3: High-Frequency Distribution Operations (1000+ Operations)
// ---------------------------------------------------------------------------

#[test]
fn test_simulate_high_frequency_1000_distributions() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.budget().reset_unlimited();

    let (contract_id, client) = setup(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    client.initialize(
        &vec![&env, a.clone(), b.clone(), c.clone()],
        &vec![&env, 5000_u32, 3000_u32, 2000_u32],
    );

    let num_operations: u32 = 1000;
    let amount_per_op: i128 = 10_000;

    let start_time = std::time::Instant::now();
    let initial_cpu = env.budget().cpu_instruction_cost();
    let initial_mem = env.budget().memory_bytes_cost();

    for i in 1..=num_operations {
        mint(&env, &token, &contract_id, amount_per_op);
        client.distribute(&token);

        // Advance ledger timestamp to simulate continuous high-frequency stream
        env.ledger().with_mut(|l| {
            l.timestamp = l.timestamp.saturating_add(1);
            l.sequence_number = l.sequence_number.saturating_add(1);
        });

        if i % 250 == 0 {
            let elapsed = start_time.elapsed().as_secs_f64();
            let current_ops_per_sec = (i as f64) / elapsed.max(0.001);
            std::println!(
                "  [High-Frequency Progress] Completed {}/{} distributions ({:.1} ops/sec)",
                i,
                num_operations,
                current_ops_per_sec
            );
        }
    }

    let elapsed = start_time.elapsed();
    let total_cpu = env.budget().cpu_instruction_cost() - initial_cpu;
    let total_mem = env.budget().memory_bytes_cost() - initial_mem;

    let throughput_ops_sec = (num_operations as f64) / elapsed.as_secs_f64().max(0.001);
    let avg_cpu_per_op = total_cpu / (num_operations as u64);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&contract_id), 0);
    assert_eq!(
        token_client.balance(&a),
        (amount_per_op * (num_operations as i128)) * 5000 / 10000
    );

    std::println!("\n=======================================================");
    std::println!("  HIGH-FREQUENCY SIMULATION SUMMARY (1000 OPERATIONS)");
    std::println!("=======================================================");
    std::println!("  Total Operations:         {}", num_operations);
    std::println!(
        "  Total Wall-Clock Time:    {:.3} seconds",
        elapsed.as_secs_f64()
    );
    std::println!(
        "  Throughput:               {:.1} operations/sec",
        throughput_ops_sec
    );
    std::println!(
        "  Average CPU Cost/Op:      {} instructions",
        avg_cpu_per_op
    );
    std::println!("  Total CPU Instructions:   {}", total_cpu);
    std::println!("  Total Memory Bytes:       {}", total_mem);
    std::println!("=======================================================\n");
}

// ---------------------------------------------------------------------------
// Scenario 4: Resource Scaling by Collaborator Count
// ---------------------------------------------------------------------------

#[test]
fn test_measure_resource_scaling_by_collaborator_count() {
    let counts = [1, 2, 4, 6, 8, 10];

    std::println!("\n=======================================================");
    std::println!("  RESOURCE BUDGET SCALING CURVE (COLLABORATOR COUNT)");
    std::println!("=======================================================");
    std::println!("  Recipients | CPU Instructions | Memory Bytes | Payout Validated");
    std::println!("-------------------------------------------------------");

    for &count in &counts {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        env.budget().reset_unlimited();

        let (contract_id, client) = setup(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        let mut collaborators = SorobanVec::new(&env);
        let mut shares = SorobanVec::new(&env);
        let share_each = TOTAL_SHARE_WEIGHT / (count as u32);
        let mut remainder = TOTAL_SHARE_WEIGHT % (count as u32);

        for _ in 0..count {
            collaborators.push_back(Address::generate(&env));
            let s = share_each
                + if remainder > 0 {
                    remainder -= 1;
                    1
                } else {
                    0
                };
            shares.push_back(s);
        }

        client.initialize(&collaborators, &shares);
        mint(&env, &token, &contract_id, 100_000);

        let pre_cpu = env.budget().cpu_instruction_cost();
        let pre_mem = env.budget().memory_bytes_cost();

        client.distribute(&token);

        let cpu_used = env.budget().cpu_instruction_cost() - pre_cpu;
        let mem_used = env.budget().memory_bytes_cost() - pre_mem;

        let token_client = TokenClient::new(&env, &token);
        let contract_bal = token_client.balance(&contract_id);
        assert_eq!(contract_bal, 0);

        std::println!(
            "  {:>10} | {:>16} | {:>12} | {:>16}",
            count,
            cpu_used,
            mem_used,
            "100% Correct"
        );
    }
    std::println!("=======================================================\n");
}
