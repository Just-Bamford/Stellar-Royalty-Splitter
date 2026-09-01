use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use soroban_sdk::{testutils::Address as _, Address, Env, Vec as SorobanVec};
use stellar_royalty_splitter::{Recipient, RoyaltySplitterClient};

fn make_env() -> Env {
    Env::default()
}

fn deploy_contract(env: &Env) -> (soroban_sdk::Address, RoyaltySplitterClient) {
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(env, &contract_id);
    (contract_id, client)
}

fn make_collaborators(env: &Env, n: usize) -> (SorobanVec<Address>, SorobanVec<u32>) {
    let mut addrs: SorobanVec<Address> = SorobanVec::new(env);
    let mut shares: SorobanVec<u32> = SorobanVec::new(env);

    let base = 10_000u32 / n as u32;
    let remainder = 10_000u32 - base * n as u32;

    for i in 0..n {
        let addr = Address::generate(env);
        addrs.push_back(addr);
        let share = if i == n - 1 { base + remainder } else { base };
        shares.push_back(share);
    }
    (addrs, shares)
}

fn bench_initialize(c: &mut Criterion) {
    let mut group = c.benchmark_group("initialize");

    for n in [1usize, 3, 5, 10] {
        group.bench_with_input(BenchmarkId::new("collaborators", n), &n, |b, &n| {
            b.iter_batched(
                || {
                    let env = make_env();
                    let (_, client) = deploy_contract(&env);
                    let (addrs, shares) = make_collaborators(&env, n);
                    env.mock_all_auths();
                    (env, client, addrs, shares)
                },
                |(_, client, addrs, shares)| {
                    client.initialize(black_box(&addrs), black_box(&shares));
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

fn bench_distribute(c: &mut Criterion) {
    let mut group = c.benchmark_group("distribute");

    for n in [2usize, 5, 10] {
        group.bench_with_input(BenchmarkId::new("collaborators", n), &n, |b, &n| {
            b.iter_batched(
                || {
                    let env = make_env();
                    let (contract_id, client) = deploy_contract(&env);
                    let (addrs, shares) = make_collaborators(&env, n);
                    env.mock_all_auths();
                    client.initialize(&addrs, &shares);

                    // Register and mint a mock token so distribute has a balance to split.
                    let token_id = env.register_stellar_asset_contract_v2(addrs.get(0).unwrap());
                    let token_client =
                        soroban_sdk::token::StellarAssetClient::new(&env, &token_id.address());
                    token_client.mint(&contract_id, &1_000_000_i128);

                    (env, client, token_id.address())
                },
                |(_, client, token_addr)| {
                    client.distribute(black_box(&token_addr));
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

fn bench_distribute_with_override(c: &mut Criterion) {
    let mut group = c.benchmark_group("distribute_with_override");

    for n in [2usize, 5, 10] {
        group.bench_with_input(BenchmarkId::new("recipients", n), &n, |b, &n| {
            b.iter_batched(
                || {
                    let env = make_env();
                    let (contract_id, client) = deploy_contract(&env);
                    let (addrs, shares) = make_collaborators(&env, 2);
                    env.mock_all_auths();
                    client.initialize(&addrs, &shares);

                    let token_id = env.register_stellar_asset_contract_v2(addrs.get(0).unwrap());
                    let token_client =
                        soroban_sdk::token::StellarAssetClient::new(&env, &token_id.address());
                    token_client.mint(&contract_id, &5_000_000_i128);

                    // Build override recipient list
                    let (override_addrs, override_shares) = make_collaborators(&env, n);
                    let mut recipients: SorobanVec<Recipient> = SorobanVec::new(&env);
                    for i in 0..n {
                        recipients.push_back(Recipient {
                            address: override_addrs.get(i as u32).unwrap(),
                            share: override_shares.get(i as u32).unwrap(),
                        });
                    }

                    (env, client, token_id.address(), recipients)
                },
                |(_, client, token_addr, recipients)| {
                    client.distribute_with_override(black_box(&token_addr), black_box(&recipients));
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

fn bench_record_secondary_royalty(c: &mut Criterion) {
    c.bench_function("record_secondary_royalty", |b| {
        b.iter_batched(
            || {
                let env = make_env();
                let (contract_id, client) = deploy_contract(&env);
                let (addrs, shares) = make_collaborators(&env, 3);
                env.mock_all_auths();
                client.initialize(&addrs, &shares);

                let payer = addrs.get(0).unwrap();
                let token_id = env.register_stellar_asset_contract_v2(payer.clone());
                let token_client =
                    soroban_sdk::token::StellarAssetClient::new(&env, &token_id.address());
                token_client.mint(&payer, &100_000_i128);

                let _ = contract_id;
                (env, client, token_id.address(), payer)
            },
            |(_, client, token_addr, payer)| {
                client.record_secondary_royalty(
                    black_box(&token_addr),
                    black_box(&payer),
                    black_box(&10_000_i128),
                );
            },
            criterion::BatchSize::SmallInput,
        );
    });
}

fn bench_distribute_secondary_royalties(c: &mut Criterion) {
    let mut group = c.benchmark_group("distribute_secondary_royalties");

    for n in [2usize, 5, 10] {
        group.bench_with_input(BenchmarkId::new("collaborators", n), &n, |b, &n| {
            b.iter_batched(
                || {
                    let env = make_env();
                    let (contract_id, client) = deploy_contract(&env);
                    let (addrs, shares) = make_collaborators(&env, n);
                    env.mock_all_auths();
                    client.initialize(&addrs, &shares);

                    let payer = addrs.get(0).unwrap();
                    let token_id = env.register_stellar_asset_contract_v2(payer.clone());
                    let token_client =
                        soroban_sdk::token::StellarAssetClient::new(&env, &token_id.address());
                    token_client.mint(&payer, &1_000_000_i128);
                    // Approve contract to pull from payer
                    token_client.mint(&contract_id, &0_i128);

                    client.record_secondary_royalty(&token_id.address(), &payer, &500_000_i128);

                    (env, client)
                },
                |(_, client)| {
                    client.distribute_secondary_royalties();
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

fn bench_get_recipients(c: &mut Criterion) {
    let mut group = c.benchmark_group("get_recipients");

    for n in [1usize, 5, 10] {
        group.bench_with_input(BenchmarkId::new("collaborators", n), &n, |b, &n| {
            b.iter_batched(
                || {
                    let env = make_env();
                    let (_, client) = deploy_contract(&env);
                    let (addrs, shares) = make_collaborators(&env, n);
                    env.mock_all_auths();
                    client.initialize(&addrs, &shares);
                    (env, client)
                },
                |(_, client)| {
                    black_box(client.get_recipients());
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

fn bench_update_share(c: &mut Criterion) {
    c.bench_function("update_share", |b| {
        b.iter_batched(
            || {
                let env = make_env();
                let (_, client) = deploy_contract(&env);
                let (addrs, shares) = make_collaborators(&env, 2);
                env.mock_all_auths();
                client.initialize(&addrs, &shares);
                let collab = addrs.get(0).unwrap();
                (env, client, collab)
            },
            |(_, client, collab)| {
                // Swap allocations: collab gets 4000, leaving 6000 for the other.
                // To keep total = 10000 we flip-flop between two valid states.
                client.update_share(black_box(&collab), black_box(&4_000_u32));
                client.update_share(black_box(&collab), black_box(&5_000_u32));
            },
            criterion::BatchSize::SmallInput,
        );
    });
}

fn bench_is_initialized(c: &mut Criterion) {
    let mut group = c.benchmark_group("is_initialized");

    group.bench_function("before_init", |b| {
        b.iter_batched(
            || {
                let env = make_env();
                let (_, client) = deploy_contract(&env);
                (env, client)
            },
            |(_, client)| {
                black_box(client.is_initialized());
            },
            criterion::BatchSize::SmallInput,
        );
    });

    group.bench_function("after_init", |b| {
        b.iter_batched(
            || {
                let env = make_env();
                let (_, client) = deploy_contract(&env);
                let (addrs, shares) = make_collaborators(&env, 3);
                env.mock_all_auths();
                client.initialize(&addrs, &shares);
                (env, client)
            },
            |(_, client)| {
                black_box(client.is_initialized());
            },
            criterion::BatchSize::SmallInput,
        );
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_initialize,
    bench_distribute,
    bench_distribute_with_override,
    bench_record_secondary_royalty,
    bench_distribute_secondary_royalties,
    bench_get_recipients,
    bench_update_share,
    bench_is_initialized,
);
criterion_main!(benches);
