//! Shared fixtures for the contract test suites.
//!
//! Each test binary links this module separately and uses a different subset of
//! it, so unused-item warnings here are expected rather than meaningful.
#![allow(dead_code)]

use keyring_contract::policy::{ChainPolicy, Policy, TimeWindow};
use keyring_contract::types::Chain;
use near_sdk::json_types::U128;
use near_sdk::{AccountId, PublicKey};

/// A distinct, structurally valid ed25519 public key per seed.
///
/// Built from bytes rather than a base58 literal so the tests do not depend on a
/// hand-written key string being well formed.
pub fn pk(seed: u8) -> PublicKey {
    let mut bytes = vec![0u8; 33];
    bytes[0] = 0; // curve type: ed25519
    bytes[1] = seed;
    PublicKey::try_from(bytes).expect("valid ed25519 public key")
}

pub fn account(name: &str) -> AccountId {
    name.parse().expect("valid account id")
}

/// A canonical, lowercase Base Sepolia destination.
pub const DEST_A: &str = "0x1111111111111111111111111111111111111111";
/// A second allowlisted destination.
pub const DEST_B: &str = "0x2222222222222222222222222222222222222222";
/// A well-formed address that is deliberately NOT allowlisted.
pub const DEST_EVIL: &str = "0x9999999999999999999999999999999999999999";

/// 1 ETH in wei, as a readable constant for the EVM caps.
pub const ONE_ETH: u128 = 1_000_000_000_000_000_000;

/// A Base Sepolia policy: 1 ETH per request, 2 ETH per 24h, 0.01 ETH fee cap.
pub fn evm_policy() -> Policy {
    Policy {
        chains: vec![ChainPolicy {
            chain: Chain::BaseSepolia,
            max_per_request: U128(ONE_ETH),
            max_per_24h: U128(2 * ONE_ETH),
            max_fee: U128(ONE_ETH / 100),
            allowed_destinations: vec![DEST_A.to_string(), DEST_B.to_string()],
        }],
        time_window: None,
    }
}

/// The same policy, restricted to a UTC time window.
pub fn evm_policy_windowed(window: TimeWindow) -> Policy {
    let mut p = evm_policy();
    p.time_window = Some(window);
    p
}

/// Milliseconds for a given UTC time of day, on an arbitrary day.
pub fn at_utc(hour: u64, minute: u64) -> u64 {
    // Day 20000 since epoch keeps the value realistic and well clear of zero.
    const DAY_MS: u64 = 24 * 60 * 60 * 1_000;
    20_000 * DAY_MS + hour * 3_600_000 + minute * 60_000
}
