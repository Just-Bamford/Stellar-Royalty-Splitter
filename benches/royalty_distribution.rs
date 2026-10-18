use criterion::{criterion_group, criterion_main};

// Benchmarks are currently disabled due to architectural incompatibility with criterion's iter_batched
// pattern when using Soroban SDK types that borrow the Env context.
// These benchmarks should be refactored to use a custom harness or inline measurements.

fn bench_placeholder(_c: &mut criterion::Criterion) {
    // Placeholder to allow the bench target to compile
}

criterion_group!(benches, bench_placeholder);
criterion_main!(benches);
