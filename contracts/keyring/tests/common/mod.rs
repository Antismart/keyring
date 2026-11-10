//! Shared fixtures for the contract test suites.
//!
//! Each test binary links this module separately and uses a different subset of
//! it, so unused-item warnings here are expected rather than meaningful.
#![allow(dead_code)]

use keyring_contract::bitcoin::BitcoinParams;
use keyring_contract::evm::EvmParams;
use keyring_contract::policy::{
    AggregateBudget, AggregateCap, AssetPolicy, ChainPolicy, Policy, TimeWindow,
};
use keyring_contract::types::{Asset, Chain, ChainParams};
use near_sdk::json_types::{U128, U64};
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

/// An ERC-20 token contract used by the token tests.
pub const TOKEN: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/// A second token, deliberately not in any policy.
pub const TOKEN_OTHER: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/// 1 unit of a 6-decimal token, for readable token caps.
pub const ONE_USDC: u128 = 1_000_000;

/// A Base Sepolia policy for native ETH: 1 ETH per request, 2 ETH per 24h,
/// 0.01 ETH fee cap.
pub fn evm_policy() -> Policy {
    Policy {
        chains: vec![ChainPolicy {
            chain: Chain::BaseSepolia,
            max_fee: U128(ONE_ETH / 100),
            assets: vec![AssetPolicy {
                asset: Asset::Native,
                max_per_request: U128(ONE_ETH),
                max_per_24h: U128(2 * ONE_ETH),
                allowed_destinations: vec![DEST_A.to_string(), DEST_B.to_string()],
            }],
        }],
        time_window: None,
    }
}

/// The native policy plus an ERC-20 asset: 100 tokens per request, 200 per 24h.
pub fn evm_policy_with_token() -> Policy {
    let mut p = evm_policy();
    p.chains[0].assets.push(AssetPolicy {
        asset: Asset::Erc20 {
            token: TOKEN.to_string(),
        },
        max_per_request: U128(100 * ONE_USDC),
        max_per_24h: U128(200 * ONE_USDC),
        allowed_destinations: vec![DEST_A.to_string()],
    });
    p
}

/// Shorthand for the native asset policy inside [`evm_policy`].
pub fn native_limits(p: &mut Policy) -> &mut AssetPolicy {
    &mut p.chains[0].assets[0]
}

/// An owner-wide cap on native ETH.
pub fn aggregate_native(max_per_24h: u128) -> AggregateBudget {
    AggregateBudget {
        caps: vec![AggregateCap {
            chain: Chain::BaseSepolia,
            asset: Asset::Native,
            max_per_24h: U128(max_per_24h),
        }],
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

/// Realistic Base Sepolia gas parameters.
///
/// 21000 gas at 1 gwei gives a 21000 gwei (2.1e13 wei) fee ceiling, comfortably
/// under the 0.01 ETH fee cap in [`evm_policy`].
pub fn evm_params() -> ChainParams {
    ChainParams::Evm(EvmParams {
        nonce: U64(0),
        gas_limit: U64(21_000),
        max_fee_per_gas: U128(1_000_000_000),
        max_priority_fee_per_gas: U128(1_000_000),
    })
}

/// Gas parameters with an explicit fee ceiling, for fee-cap tests.
pub fn evm_params_with_fee(gas_limit: u64, max_fee_per_gas: u128) -> ChainParams {
    ChainParams::Evm(EvmParams {
        nonce: U64(0),
        gas_limit: U64(gas_limit),
        max_fee_per_gas: U128(max_fee_per_gas),
        max_priority_fee_per_gas: U128(0),
    })
}

/// The well-known test key used by the Bitcoin fixtures, compressed.
pub const BTC_PUBKEY: &str = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
/// A testnet P2WPKH destination, derived from a different key.
pub const BTC_DEST: &str = "tb1qq6hag67dl53wl99vzg42z8eyzfz2xlkvvlryfj";

/// A Bitcoin testnet4 policy: 70k sat per request, 150k per 24h, 5k fee cap.
pub fn btc_policy() -> Policy {
    Policy {
        chains: vec![ChainPolicy {
            chain: Chain::BitcoinTestnet4,
            max_fee: U128(5_000),
            assets: vec![AssetPolicy {
                asset: Asset::Native,
                max_per_request: U128(70_000),
                max_per_24h: U128(150_000),
                allowed_destinations: vec![BTC_DEST.to_string()],
            }],
        }],
        time_window: None,
    }
}

/// Bitcoin spend parameters against a 100k sat UTXO.
pub fn btc_params(fee: u128) -> ChainParams {
    ChainParams::Bitcoin(BitcoinParams {
        txid: "7f3e2a1b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7".to_string(),
        vout: 1,
        input_value: U128(100_000),
        fee: U128(fee),
    })
}
