#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec,
    xdr::ToXdr,
    Address, Env, Vec,
};
use stellar_royalty_splitter::{RoyaltySplitter, RoyaltySplitterClient};

fn setup(env: &Env) -> RoyaltySplitterClient {
    let contract_id = env.register_contract(None, RoyaltySplitter);
    RoyaltySplitterClient::new(env, &contract_id)
}

fn commitment(
    env: &Env,
    collaborators: &Vec<Address>,
    shares: &Vec<u32>,
) -> (soroban_sdk::BytesN<32>, soroban_sdk::BytesN<32>) {
    let collaborator_hash = env.crypto().sha256(&collaborators.clone().to_xdr(env));
    let share_hash = env.crypto().sha256(&shares.clone().to_xdr(env));
    (collaborator_hash, share_hash)
}

fn inputs(env: &Env) -> (Vec<Address>, Vec<u32>) {
    (
        vec![env, Address::generate(env), Address::generate(env)],
        vec![env, 5000_u32, 5000_u32],
    )
}

#[test]
fn commit_reveal_initializes_after_one_ledger() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);
    let (collaborator_hash, share_hash) = commitment(&env, &collaborators, &shares);

    client.commit_initialize(&collaborator_hash, &share_hash);
    env.ledger().with_mut(|ledger| ledger.sequence_number += 1);
    client.reveal_initialize(&collaborators, &shares);

    assert!(client.is_initialized());
    assert_eq!(client.get_admin(), collaborators.get(0).unwrap());
}

#[test]
fn reveal_before_next_ledger_fails() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);
    let (collaborator_hash, share_hash) = commitment(&env, &collaborators, &shares);
    client.commit_initialize(&collaborator_hash, &share_hash);

    assert_eq!(
        client.try_reveal_initialize(&collaborators, &shares),
        Err(Ok(
            stellar_royalty_splitter::ContractError::InitRevealTooEarly.into()
        ))
    );
    println!("TEST PASSED SUCCESSFULLY");
}

#[test]
fn collaborator_hash_mismatch_fails() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);
    let (collaborator_hash, share_hash) = commitment(&env, &collaborators, &shares);
    client.commit_initialize(&collaborator_hash, &share_hash);
    env.ledger().with_mut(|ledger| ledger.sequence_number += 1);
    let (mut changed, _) = inputs(&env);
    changed.set(0, Address::generate(&env));

    assert_eq!(
        client.try_reveal_initialize(&changed, &shares),
        Err(Ok(
            stellar_royalty_splitter::ContractError::InitCommitmentMismatch.into()
        ))
    );
}

#[test]
fn shares_hash_mismatch_fails() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);
    let (collaborator_hash, share_hash) = commitment(&env, &collaborators, &shares);
    client.commit_initialize(&collaborator_hash, &share_hash);
    env.ledger().with_mut(|ledger| ledger.sequence_number += 1);
    let changed_shares = vec![&env, 6000_u32, 4000_u32];

    assert_eq!(
        client.try_reveal_initialize(&collaborators, &changed_shares),
        Err(Ok(
            stellar_royalty_splitter::ContractError::InitCommitmentMismatch.into()
        ))
    );
}

#[test]
fn reveal_without_commitment_fails() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);

    assert_eq!(
        client.try_reveal_initialize(&collaborators, &shares),
        Err(Ok(
            stellar_royalty_splitter::ContractError::NoInitializationCommitment.into()
        ))
    );
}

#[test]
fn commitment_is_consumed_after_successful_reveal() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);
    let (collaborator_hash, share_hash) = commitment(&env, &collaborators, &shares);
    client.commit_initialize(&collaborator_hash, &share_hash);
    env.ledger().with_mut(|ledger| ledger.sequence_number += 1);
    client.reveal_initialize(&collaborators, &shares);

    assert_eq!(
        client.try_reveal_initialize(&collaborators, &shares),
        Err(Ok(
            stellar_royalty_splitter::ContractError::AlreadyInitialized.into()
        ))
    );
}
