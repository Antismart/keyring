//! Backend selection, key derivation paths, the signed payload, and the mock.
//!
//! # Scope of this module
//!
//! The MPC *wire format* is not here — it lives in [`crate::mpc`], whose types
//! were read from the deployed signer's embedded ABI rather than written from
//! memory (CLAUDE.md §2). The cross-contract call itself is issued from
//! `lib.rs`.
//!
//! This module holds what surrounds that call: which backend a deployment uses,
//! the derivation path the contract computes for each agent and chain, the
//! payload that is signed, and a deterministic mock for local use.
//!
//! Mock results must never be presented as evidence of MPC integration
//! (CLAUDE.md §10). `StoredSignature.mock` records the distinction on every
//! request, so it survives into anything that reads the record.

use near_sdk::{near, AccountId};

/// Which signing backend the contract is configured to use.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SignerBackend {
    /// Real NEAR Chain Signatures MPC contract.
    ///
    /// Implemented and verified against `v1.signer-prod.testnet`: the contract
    /// calls `sign`, and [`crate::Contract::on_signed`] handles the response.
    Mpc { contract_id: AccountId },
    /// Deterministic local stand-in.
    ///
    /// Used by the unit tests and by local demos. It completes the lifecycle
    /// synchronously and flags every signature it produces as `mock`. It
    /// produces no valid signature and must never back a deployment that
    /// anyone relies on.
    Mock,
}

impl SignerBackend {
    pub fn is_mock(&self) -> bool {
        matches!(self, SignerBackend::Mock)
    }
}

/// Builds the MPC derivation path for an agent/chain pair.
///
/// The path binds a derived key to the owner, the agent key and the chain, so
/// two agents under one keyring never share an address and an agent's key on one
/// chain is unrelated to its key on another.
///
/// The path is computed by the contract from state it controls. It is never
/// supplied by the caller, because the derivation path selects *which* key signs:
/// letting an agent choose its own path would let it sign for another agent.
pub fn derivation_path(owner: &AccountId, agent_label: &str, chain: &str) -> String {
    format!("keyring-v1,{owner},{agent_label},{chain}")
}

/// A deterministic 64-byte pseudo-signature.
///
/// Used by [`SignerBackend::Mock`], so it is reached by the contract's own code
/// path and not only by tests. Derived from the payload and path by hashing, so
/// a test can assert that the value the contract would sign is exactly the
/// value policy approved.
///
/// It is **not** a valid signature on any curve and will not verify anywhere.
/// Every signature it produces is stored with `mock: true`.
pub fn mock_signature(payload: &[u8], path: &str) -> [u8; 64] {
    let mut out = [0u8; 64];
    let a = near_sdk::env::sha256(&[payload, path.as_bytes()].concat()[..]);
    let b = near_sdk::env::sha256(&[path.as_bytes(), payload].concat()[..]);
    out[..32].copy_from_slice(&a);
    out[32..].copy_from_slice(&b);
    out
}
