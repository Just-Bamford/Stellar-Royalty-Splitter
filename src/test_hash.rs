use soroban_sdk::{Env, Vec, Address, xdr::ToXdr, Bytes};

pub fn test_hash(env: Env, vec: Vec<Address>) {
    let bytes: Bytes = vec.clone().to_xdr(&env);
    let hash = env.crypto().sha256(&bytes);
}
