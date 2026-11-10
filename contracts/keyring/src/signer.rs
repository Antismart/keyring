//! Signing backend abstraction and the deterministic mock signer.
//!
//! # What this module is not
//!
//! It is **not** an implementation of the NEAR Chain Signatures interface. The
//! real MPC signer is a cross-contract call whose exact method signature,
//! argument shape and response format are verified against the deployed testnet
//! signer contract at Gate C (CLAUDE.md §12) rather than written from memory
//! here, which CLAUDE.md §2 forbids.
//!
//! What this module provides now is the *seam*: a backend selector carried in
//! contract config, plus a deterministic mock that lets the policy engine and
//! the request lifecycle be tested end to end without a network. Mock results
//! must never be presented as evidence of MPC integration (CLAUDE.md §10).

use near_sdk::{near, AccountId};

/// Which signing backend the contract is configured to use.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SignerBackend {
    /// Real NEAR Chain Signatures MPC contract. Wired at Gate C.
    Mpc { contract_id: AccountId },
    /// Deterministic local stand-in. Test and local-demo use only.
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

/// A deterministic 64-byte pseudo-signature for tests.
///
/// Derived from the payload and path by hashing, so tests can assert that the
/// value the contract would sign is exactly the value policy approved. It is not
/// a valid signature on any curve and will not verify anywhere.
pub fn mock_signature(payload: &[u8], path: &str) -> [u8; 64] {
    let mut out = [0u8; 64];
    let a = near_sdk::env::sha256(&[payload, path.as_bytes()].concat()[..]);
    let b = near_sdk::env::sha256(&[path.as_bytes(), payload].concat()[..]);
    out[..32].copy_from_slice(&a);
    out[32..].copy_from_slice(&b);
    out
}
