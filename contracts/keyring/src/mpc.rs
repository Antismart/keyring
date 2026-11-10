//! Wire types for the NEAR Chain Signatures MPC contract.
//!
//! # Provenance
//!
//! Every type and constant here was verified against the **deployed testnet
//! signer**, not written from memory and not copied from documentation:
//!
//! - Account: `v1.signer-prod.testnet`
//! - Contract version: `3.18.0`
//! - Source: `github.com/near/mpc` @ `e691bdb98d68dcf74653da58d043453a6318765f`
//! - Schemas: read from the contract's own embedded ABI, fetched by calling its
//!   `__contract_abi` export over RPC and zstd-decompressing the result.
//!
//! # Why these types are mirrored rather than imported
//!
//! The official `near-mpc-sdk` / `near-mpc-contract-interface` crates exist at
//! version 0.0.1, but their transitive dependency `near-mpc-crypto-types`
//! 0.0.1 does not compile against near-sdk 5.30.1: near-sdk added
//! `CurveType::MLDSA65` and the crate has a non-exhaustive match over it. No
//! newer release exists.
//!
//! The boundary to the signer is JSON, so mirroring the verified wire schema is
//! both sufficient and preferable for a security-sensitive contract: it keeps
//! the dependency surface minimal. The trade-off is that these definitions must
//! be re-checked against the ABI when the signer contract is upgraded; that
//! check is written down in `docs/security-decisions.md`.
//!
//! # A note on `payload_v2`
//!
//! The Rust field is named `payload`, but it serialises as `payload_v2` on the
//! wire. Sending `payload` instead would be accepted by the contract's
//! backward-compatible deserialiser, but as a raw `[u8; 32]` array rather than
//! a hex string. We send the current form.

use near_sdk::{near, Gas, NearToken};

/// The signer's signing entrypoint.
pub const SIGN_METHOD: &str = "sign";

/// Deposit the signer requires on a `sign` call, in yoctoNEAR.
///
/// The **contract** attaches this from its own balance. It is never taken from
/// the caller, so an agent cannot influence it and `request_transfer` is not
/// `#[payable]` (CLAUDE.md §4).
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

/// Domain 0 on the deployed testnet signer: protocol CaitSith, purpose Sign.
///
/// This is the secp256k1 domain, which is what Base Sepolia and Bitcoin
/// testnet4 both need. Domain 1 is Frost/Ed25519 and is not used here. The live
/// domain list was read from the contract's `state` view.
pub const ECDSA_DOMAIN_ID: u64 = 0;

/// Gas forwarded to the signer's `sign` call.
///
/// The deployed config requires at least 15 TGas
/// (`sign_call_gas_attachment_requirement_tera_gas`). More is attached because
/// `sign` enqueues a yield-resume and must cover its own internal callback.
pub const SIGN_GAS: Gas = Gas::from_tgas(100);

/// Gas reserved for our own `on_signed` callback.
pub const CALLBACK_GAS: Gas = Gas::from_tgas(20);

/// A 32-byte ECDSA payload, hex-encoded on the wire.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Payload {
    /// Exactly 32 bytes as 64 lowercase hex characters.
    Ecdsa(String),
}

/// Arguments to the signer's `sign` method.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignRequestArgs {
    /// Derivation path. Together with the **predecessor** — this contract —
    /// it selects the signing key. Computed by the contract; never a caller
    /// parameter.
    pub path: String,
    /// Note the wire name: `payload_v2`, not `payload`.
    pub payload_v2: Payload,
    pub domain_id: u64,
}

/// A secp256k1 curve point, hex-encoded.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AffinePoint {
    pub affine_point: String,
}

/// A secp256k1 scalar, hex-encoded.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scalar {
    pub scalar: String,
}

/// What the signer's `sign` promise resolves with.
///
/// Internally tagged on `scheme`. Only `Secp256k1` is reachable for Keyring,
/// since requests always target the secp256k1 domain; `Ed25519` is modelled so
/// that an unexpected response deserialises and is rejected explicitly rather
/// than failing to parse.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1 {
        big_r: AffinePoint,
        s: Scalar,
        recovery_id: u8,
    },
    Ed25519 {
        signature: near_sdk::serde_json::Value,
    },
}

/// Builds the `sign` arguments for a secp256k1 request.
pub fn sign_args(path: String, payload_hex: String) -> SignRequestArgs {
    SignRequestArgs {
        path,
        payload_v2: Payload::Ecdsa(payload_hex),
        domain_id: ECDSA_DOMAIN_ID,
    }
}

/// Lowercase hex for a 32-byte payload.
pub fn to_hex(bytes: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push(char::from_digit(u32::from(b >> 4), 16).unwrap());
        s.push(char::from_digit(u32::from(b & 0x0f), 16).unwrap());
    }
    s
}
