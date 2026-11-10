//! Core value types shared across the contract.
//!
//! Money rule (CLAUDE.md §3): every amount in this module is an **integer in the
//! smallest base unit of its chain** (wei for Base Sepolia, satoshi for Bitcoin
//! testnet4). There is no floating point anywhere in this crate, and there is no
//! cross-chain conversion: a limit expressed for one chain is never compared
//! against an amount on another.

use near_sdk::near;

/// A chain Keyring can be asked to sign for.
///
/// Only the two priority chains from CLAUDE.md §3 exist. Solana is deliberately
/// absent rather than stubbed, so that an unsupported chain cannot be named in a
/// policy or a request at all.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Chain {
    BaseSepolia,
    BitcoinTestnet4,
}

impl Chain {
    /// Stable short identifier, used in events, derivation paths and errors.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Chain::BaseSepolia => "base-sepolia",
            Chain::BitcoinTestnet4 => "bitcoin-testnet4",
        }
    }

    /// The name of the base unit, for human-readable refusal messages only.
    pub const fn base_unit(&self) -> &'static str {
        match self {
            Chain::BaseSepolia => "wei",
            Chain::BitcoinTestnet4 => "satoshi",
        }
    }
}

/// Maximum accepted length of a destination address string.
///
/// Bounds storage and stops a caller from paying to inflate contract state
/// through a policy allowlist or a request.
pub const MAX_DESTINATION_LEN: usize = 128;

/// Maximum accepted length of an idempotency key.
pub const MAX_IDEMPOTENCY_KEY_LEN: usize = 64;

/// Maximum accepted length of an agent label.
pub const MAX_LABEL_LEN: usize = 64;

/// Normalises and validates a destination address for a given chain.
///
/// Returns the canonical form to store and compare, or `None` if the address is
/// not well formed for that chain. Normalisation matters for security, not just
/// tidiness: EVM addresses are case-insensitive, so comparing them raw would let
/// `0xABC…` bypass an allowlist containing `0xabc…`.
pub fn normalize_destination(chain: Chain, raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > MAX_DESTINATION_LEN {
        return None;
    }
    match chain {
        Chain::BaseSepolia => {
            // 0x-prefixed 20-byte hex address.
            let hex = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X"))?;
            if hex.len() != 40 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            Some(format!("0x{}", hex.to_ascii_lowercase()))
        }
        Chain::BitcoinTestnet4 => {
            // Conservative syntactic check only. Full address-type validation
            // (and which spend types are actually supported) is deliberately
            // deferred to Gate E, where it is verified against a pinned Bitcoin
            // library rather than guessed here.
            let ok_len = (14..=90).contains(&raw.len());
            let ok_charset = raw.bytes().all(|b| b.is_ascii_alphanumeric());
            if !ok_len || !ok_charset {
                return None;
            }
            // Bech32 testnet addresses are case-insensitive and canonically
            // lowercase; base58 addresses are case-sensitive and must be kept
            // verbatim.
            let lower = raw.to_ascii_lowercase();
            if lower.starts_with("tb1") {
                Some(lower)
            } else {
                Some(raw.to_string())
            }
        }
    }
}
