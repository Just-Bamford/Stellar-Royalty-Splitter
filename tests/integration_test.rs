#![cfg(test)]
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, IntoVal,
};
use stellar_royalty_splitter::RoyaltySplitterClient;

fn setup(env: &Env) -> (Address, RoyaltySplitterClient) {
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(env, &contract_id);
    (contract_id, client)
}

fn make_token(env: &Env, admin: &Address) -> Address {
    env.register_stellar_asset_contract(admin.clone())
}

fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(to, &amount);
}

#[test]
#[should_panic(expected = "contract not initialized")]
fn test_distribute_before_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);
    client.distribute(&token);
}

#[test]
#[should_panic(expected = "no balance to distribute")]
fn test_distribute_zero_balance_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);
    client.initialize(&vec![&env, a, b], &vec![&env, 5000_u32, 5000_u32]);
    // contract balance is 0 — must panic
    client.distribute(&token);
}

#[test]
#[should_panic(expected = "shares must sum to 10000")]
fn test_royalty_rate_exceeds_max_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    // shares sum to 10001, not 10000
    client.initialize(&vec![&env, a, b], &vec![&env, 5001_u32, 5000_u32]);
}

/// Issue #106 — worst-case dust: last collaborator holds 1 bp (0.01%) and the
/// distribution amount is 9_999 stroops (just under 10_000).
/// Concretely: payout_a = 9_999 * 9_999 / 10_000 = 9_998, dust = 1.
#[test]
fn test_dust_bounded_for_1bp_last_collaborator() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let last = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), last.clone()],
        &vec![&env, 9999_u32, 1_u32],
    );

    let amount: i128 = 9_999;
    mint(&env, &token, &contract_id, amount);
    client.distribute(&token);

    let admin_payout = TokenClient::new(&env, &token).balance(&admin);
    let last_payout = TokenClient::new(&env, &token).balance(&last);

    assert_eq!(admin_payout, 9_998);
    assert_eq!(last_payout, 1);
    assert_eq!(admin_payout + last_payout, amount);
}

/// Issue #116 — distribute uses specific mock_auths so the test fails if
/// admin.require_auth() is removed from the contract.
#[test]
fn test_distribute_requires_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths();
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "distribute",
            args: (&token,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.distribute(&token);

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
}

/// TTL — advancing the ledger past MIN_TTL and calling a read function must
/// still succeed because every public function extends the TTL on entry.
#[test]
fn test_ttl_extended_after_ledger_advance() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, a.clone(), b.clone()], &vec![&env, 6000_u32, 4000_u32]);

    // Advance ledger sequence past MIN_TTL (17_280 ledgers).
    env.ledger().set_sequence_number(env.ledger().sequence() + 17_281);

    // Both read functions must still return correct data (TTL was extended).
    let collaborators = client.get_collaborators();
    assert_eq!(collaborators.len(), 2);
    assert_eq!(client.get_share(&a), 6000);
    assert_eq!(client.get_share(&b), 4000);
}
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths();
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    mint(&env, &token, &contract_id, 1000);

    env.mock_auths(&[]);
    client.distribute(&token);
}

/// TTL — advancing the ledger past MIN_TTL and calling a read function must
/// still succeed because every public function extends the TTL on entry.
#[test]
fn test_ttl_extended_after_ledger_advance() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, a.clone(), b.clone()], &vec![&env, 6000_u32, 4000_u32]);

    env.ledger().set_sequence_number(env.ledger().sequence() + 17_281);

    let collaborators = client.get_collaborators();
    assert_eq!(collaborators.len(), 2);
    assert_eq!(client.get_share(&a), 6000);
    assert_eq!(client.get_share(&b), 4000);
}

/// Events — distribute emits a ("royalty", "dist_all") event with (token, amount).
#[test]
fn test_distribute_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);
    client.distribute(&token);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("dist_all").into_val(&env),
                ]
            && data == (token.clone(), amount).into_val(&env)
    });
    assert!(found, "dist_all event not emitted");
}

/// Events — set_royalty_rate emits a ("royalty", "rate_set") event with the new rate.
#[test]
fn test_set_royalty_rate_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    let rate: u32 = 250;
    client.set_royalty_rate(&rate);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("rate_set").into_val(&env),
                ]
            && data == rate.into_val(&env)
    });
    assert!(found, "rate_set event not emitted");
}

/// Events — distribute_secondary_royalties emits a ("royalty", "sec_dist") event.
#[test]
fn test_distribute_secondary_royalties_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    let pool_amount: i128 = 500;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);
    client.distribute_secondary_royalties();

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("sec_dist").into_val(&env),
                ]
            && data == (token.clone(), pool_amount).into_val(&env)
    });
    assert!(found, "sec_dist event not emitted");
}

#[test]
#[should_panic(expected = "share cannot be zero")]
fn test_zero_share_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    // b has a zero share — must panic
    client.initialize(&vec![&env, a, b], &vec![&env, 10000_u32, 0_u32]);
}

#[test]
fn test_collaborator_count() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    client.initialize(
        &vec![&env, a, b, c],
        &vec![&env, 5000_u32, 3000_u32, 2000_u32],
    );
    assert_eq!(client.collaborator_count(), 3);
}

#[test]
#[should_panic]
fn test_unauthorized_init_rejected() {
    let env = Env::default();
    // No mock_all_auths — require_auth() on the admin must reject the call.
    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, admin, b], &vec![&env, 5000_u32, 5000_u32]);
}

/// Issue #160 — pause blocks distribute.
#[test]
#[should_panic(expected = "contract is paused")]
fn test_distribute_blocked_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
    mint(&env, &token, &contract_id, 1000);

    client.pause();
    // Must panic with "contract is paused"
    client.distribute(&token);
}

/// Issue #160 — pause blocks distribute_secondary_royalties.
#[test]
#[should_panic(expected = "contract is paused")]
fn test_distribute_secondary_blocked_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    let pool_amount: i128 = 500;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);

    client.pause();
    // Must panic with "contract is paused"
    client.distribute_secondary_royalties();
}

/// Issue #160 — unpause re-enables distribute.
#[test]
fn test_distribute_succeeds_after_unpause() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
    mint(&env, &token, &contract_id, 1000);

    client.pause();
    assert!(client.is_paused());

    client.unpause();
    assert!(!client.is_paused());

    // Should succeed now
    client.distribute(&token);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
}

/// Issue #160 — pause and unpause require admin auth.
#[test]
#[should_panic]
fn test_pause_requires_admin_auth() {
    let env = Env::default();
    // No mock_all_auths — require_auth() must reject non-admin callers.
    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
    // Clear auths so the next call has no authorization
    env.mock_auths(&[]);
    client.pause();
}
