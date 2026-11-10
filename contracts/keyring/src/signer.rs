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

/// Builds the 32-byte payload sent to the MPC signer at **Gate C**.
///
/// # This is not a transaction
///
/// Gate C proves the MPC round trip, the callback lifecycle and signature
/// verification. Foreign-chain transaction construction is Gate D (EVM) and
/// Gate E (Bitcoin). Until then the signed payload is a *commitment* to the
/// policy-approved transfer fields, not a broadcastable transaction.
///
/// Two properties make that safe:
///
/// 1. **It is contract-derived.** Every input comes from state the contract
///    validated. No caller supplies or influences the bytes, so this is not a
///    method that signs an arbitrary caller-supplied hash (CLAUDE.md §4).
/// 2. **It cannot be a valid transaction.** The domain-separator prefix means
///    the preimage can never coincide with an Ethereum RLP transaction hash or
///    a Bitcoin sighash, so a signature over it is not replayable as a payment
///    on any chain.
///
/// At Gate D this function is replaced by the real EIP-1559 transaction hash,
/// built by the contract from the same validated fields.
pub fn gate_c_commitment(
    contract: &AccountId,
    request_id: u64,
    chain: &str,
    destination: &str,
    amount: u128,
    fee: u128,
) -> [u8; 32] {
    let preimage = format!(
        "keyring-v1:gate-c-commitment:{contract}:{request_id}:{chain}:{destination}:{amount}:{fee}"
    );
    let digest = near_sdk::env::sha256(preimage.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}
