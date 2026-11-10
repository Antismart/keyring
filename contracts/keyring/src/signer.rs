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
