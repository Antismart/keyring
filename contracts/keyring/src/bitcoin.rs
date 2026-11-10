//! Bitcoin testnet4 transaction construction: single-input P2WPKH spends.
//!
//! # Why this is enforceable at all
//!
//! The obvious objection to a Bitcoin fee cap is that a transaction's fee is
//! `sum(inputs) - sum(outputs)`, and the input values come from UTXO data
//! supplied by the semi-trusted relayer. The contract cannot look up a UTXO, so
//! at first sight a relayer could understate an input, have a small fee
//! approved, and produce a transaction that actually pays a much larger one.
//!
//! **BIP143 closes that.** A segwit v0 sighash commits the `amount` of the
//! input being spent. A relayer that misreports it gets a signature over the
//! wrong preimage: the signature fails verification against the real UTXO and
//! the network rejects the transaction. So the value the contract computes the
//! fee from is the same value the signature is bound to, and the fee cap is
//! sound. This is verified by a fixture, not merely argued:
//! `amount_sensitivity` in `tests/fixtures/bitcoin.json` shows the sighash
//! changing when the claimed input value changes by one satoshi.
//!
//! # Scope
//!
//! Exactly one input, native segwit (P2WPKH), one payment output and at most
//! one change output back to the Keyring's own address. CLAUDE.md §7 asks for
//! the simplest spend type that can be verified safely, and says not to claim
//! multi-input support until it is tested end to end — so multi-input is
//! refused rather than half-implemented.
//!
//! Outputs are constrained by construction: the payment goes to the
//! policy-approved destination and the change to the contract's own derived
//! address. There is no field in which a caller could add a third output
//! (invariant 8).

use near_sdk::{env, near};

/// Transaction version. Fixed so the encoding is deterministic.
pub const TX_VERSION: i32 = 2;
/// Sequence for the single input: final, no RBF.
pub const SEQUENCE: u32 = 0xffff_ffff;
/// `SIGHASH_ALL`: commits to every input and output.
pub const SIGHASH_ALL: u32 = 1;
/// Locktime. Fixed at zero.
pub const LOCKTIME: u32 = 0;

/// Below this, a P2WPKH change output costs more to spend than it is worth.
///
/// Bitcoin Core's dust threshold for a P2WPKH output. Change below it is
/// omitted, which means the remainder becomes fee — and that larger fee is
/// what the cap is then checked against, so omitting change cannot smuggle a
/// fee past the limit.
pub const DUST_THRESHOLD: u64 = 294;

/// The UTXO being spent, supplied by the relayer.
///
/// `value` is untrusted in the sense that the contract cannot verify it, but
/// it is *committed* by the BIP143 sighash, so misreporting it yields an
/// unusable signature rather than an oversized fee.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct BitcoinParams {
    /// Previous transaction id, in the usual big-endian display form.
    pub txid: String,
    pub vout: u32,
    /// The UTXO's value in satoshis.
    pub input_value: near_sdk::json_types::U128,
    /// The fee to target, in satoshis. Used to size the change output; the
    /// contract then recomputes the actual fee from the outputs it built and
    /// checks *that* against the cap.
    pub fee: near_sdk::json_types::U128,
}

/// Why a Bitcoin spend could not be constructed.
#[derive(Debug, PartialEq, Eq)]
pub enum BitcoinError {
    InvalidTxid,
    /// Inputs do not cover the payment plus the requested fee.
    InsufficientInput,
    /// The payment itself exceeds the input.
    PaymentExceedsInput,
    InvalidDestination,
    InvalidKeyringAddress,
    /// The agent has no registered Bitcoin public key, so change has nowhere
    /// safe to go.
    NoKeyringKey,
    AmountTooLarge,
}

impl BitcoinError {
    pub fn message(&self) -> String {
        match self {
            BitcoinError::InvalidTxid => "txid must be 32 bytes of hex".to_string(),
            BitcoinError::InsufficientInput => {
                "the input does not cover the payment plus the fee".to_string()
            }
            BitcoinError::PaymentExceedsInput => {
                "the payment exceeds the value of the input".to_string()
            }
            BitcoinError::InvalidDestination => {
                "destination is not a supported testnet P2WPKH address".to_string()
            }
            BitcoinError::InvalidKeyringAddress => {
                "the registered Keyring Bitcoin key is not a 33-byte compressed key".to_string()
            }
            BitcoinError::NoKeyringKey => {
                "no Bitcoin public key is registered for this agent, so change has nowhere to go"
                    .to_string()
            }
            BitcoinError::AmountTooLarge => "amount does not fit in 8 bytes".to_string(),
        }
    }
}

// --------------------------------------------------------------------- bech32

const BECH32_CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
/// Human-readable part for Bitcoin testnet and testnet4.
pub const TESTNET_HRP: &str = "tb";

fn bech32_polymod(values: &[u8]) -> u32 {
    const GEN: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    let mut chk: u32 = 1;
    for v in values {
        let b = chk >> 25;
        chk = ((chk & 0x1ff_ffff) << 5) ^ u32::from(*v);
        for (i, g) in GEN.iter().enumerate() {
            if (b >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

fn hrp_expand(hrp: &str) -> Vec<u8> {
    let mut v: Vec<u8> = hrp.bytes().map(|c| c >> 5).collect();
    v.push(0);
    v.extend(hrp.bytes().map(|c| c & 31));
    v
}

/// Decodes a bech32 string into its HRP and 5-bit data, verifying the checksum.
///
/// Only bech32 (checksum constant 1) is accepted, which is correct for witness
/// version 0. Bech32m addresses — witness v1 and later, such as Taproot — use a
/// different constant and are rejected, because Keyring does not construct
/// those spends.
fn bech32_decode(s: &str) -> Option<(String, Vec<u8>)> {
    if s.len() < 8 || s.len() > 90 {
        return None;
    }
    // Mixed case is explicitly invalid in BIP173.
    let has_lower = s.bytes().any(|c| c.is_ascii_lowercase());
    let has_upper = s.bytes().any(|c| c.is_ascii_uppercase());
    if has_lower && has_upper {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    let sep = lower.rfind('1')?;
    if sep == 0 || sep + 7 > lower.len() {
        return None;
    }
    let hrp = &lower[..sep];
    let mut data = Vec::with_capacity(lower.len() - sep - 1);
    for c in lower[sep + 1..].bytes() {
        let idx = BECH32_CHARSET.iter().position(|x| *x == c)?;
        data.push(idx as u8);
    }
    let mut combined = hrp_expand(hrp);
    combined.extend_from_slice(&data);
    if bech32_polymod(&combined) != 1 {
        return None;
    }
    data.truncate(data.len() - 6); // drop the checksum
    Some((hrp.to_string(), data))
}

/// Regroups 5-bit values into 8-bit bytes, rejecting invalid padding.
fn convert_bits_5_to_8(data: &[u8]) -> Option<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::new();
    for v in data {
        if *v > 31 {
            return None;
        }
        acc = (acc << 5) | u32::from(*v);
        bits += 5;
        while bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    // Leftover bits must be zero padding of fewer than 5 bits.
    if bits >= 5 || ((acc << (8 - bits)) & 0xff) != 0 {
        return None;
    }
    Some(out)
}

/// The `scriptPubKey` for a testnet P2WPKH address.
///
/// Returns `None` for anything else: a bad checksum, a mainnet address, a
/// non-zero witness version, or a program that is not 20 bytes. Deriving the
/// script here rather than accepting one from the caller is what stops a
/// payment being redirected (invariant 8).
pub fn p2wpkh_script_from_address(address: &str) -> Option<Vec<u8>> {
    let (hrp, data) = bech32_decode(address)?;
    if hrp != TESTNET_HRP {
        return None;
    }
    let (version, program_bits) = data.split_first()?;
    if *version != 0 {
        return None;
    }
    let program = convert_bits_5_to_8(program_bits)?;
    if program.len() != 20 {
        return None;
    }
    let mut script = Vec::with_capacity(22);
    script.push(0x00); // OP_0
    script.push(0x14); // push 20 bytes
    script.extend_from_slice(&program);
    Some(script)
}

/// `hash160(x) = ripemd160(sha256(x))`.
pub fn hash160(bytes: &[u8]) -> [u8; 20] {
    let sha = env::sha256(bytes);
    env::ripemd160_array(&sha)
}

/// The `scriptPubKey` for a compressed public key, as 33 bytes of hex.
pub fn p2wpkh_script_from_pubkey(compressed_hex: &str) -> Option<Vec<u8>> {
    let key = decode_hex(compressed_hex)?;
    if key.len() != 33 || (key[0] != 0x02 && key[0] != 0x03) {
        return None;
    }
    let h = hash160(&key);
    let mut script = Vec::with_capacity(22);
    script.push(0x00);
    script.push(0x14);
    script.extend_from_slice(&h);
    Some(script)
}

/// The BIP143 `scriptCode` for a P2WPKH input.
///
/// It is the *P2PKH* script over the same key hash, not the witness program —
/// a detail that is easy to get wrong, so it is pinned by a fixture.
fn p2wpkh_script_code(key_hash: &[u8; 20]) -> Vec<u8> {
    let mut s = Vec::with_capacity(25);
    s.push(0x76); // OP_DUP
    s.push(0xa9); // OP_HASH160
    s.push(0x14); // push 20
    s.extend_from_slice(key_hash);
    s.push(0x88); // OP_EQUALVERIFY
    s.push(0xac); // OP_CHECKSIG
    s
}

pub fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    for c in s.as_bytes().chunks(2) {
        let hi = (c[0] as char).to_digit(16)?;
        let lo = (c[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

// ----------------------------------------------------------------- encoding

fn write_varint(out: &mut Vec<u8>, n: u64) {
    if n < 0xfd {
        out.push(n as u8);
    } else if n <= 0xffff {
        out.push(0xfd);
        out.extend_from_slice(&(n as u16).to_le_bytes());
    } else if n <= 0xffff_ffff {
        out.push(0xfe);
        out.extend_from_slice(&(n as u32).to_le_bytes());
    } else {
        out.push(0xff);
        out.extend_from_slice(&n.to_le_bytes());
    }
}

fn dsha256(bytes: &[u8]) -> [u8; 32] {
    let once = env::sha256(bytes);
    let twice = env::sha256(&once);
    let mut out = [0u8; 32];
    out.copy_from_slice(&twice);
    out
}

/// One transaction output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxOut {
    pub value: u64,
    pub script_pubkey: Vec<u8>,
}

impl TxOut {
    fn serialize(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.value.to_le_bytes());
        write_varint(out, self.script_pubkey.len() as u64);
        out.extend_from_slice(&self.script_pubkey);
    }
}

/// A fully determined single-input P2WPKH spend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct P2wpkhSpend {
    /// Previous txid in internal byte order (reversed from display form).
    pub prev_txid_le: [u8; 32],
    pub vout: u32,
    /// The input's value, which BIP143 commits to.
    pub input_value: u64,
    /// hash160 of the Keyring public key that signs this input.
    pub key_hash: [u8; 20],
    /// The payment output, then change if any. Never more than these two.
    pub outputs: Vec<TxOut>,
}

impl P2wpkhSpend {
    /// The fee this transaction pays: inputs minus outputs.
    ///
    /// Computed from the same `input_value` the sighash commits to, so the
    /// number the fee cap is checked against is the number the signature is
    /// bound to (invariant 9).
    pub fn fee(&self) -> u64 {
        let out: u64 = self.outputs.iter().map(|o| o.value).sum();
        self.input_value.saturating_sub(out)
    }

    /// The BIP143 signing preimage for input 0.
    pub fn sighash_preimage(&self) -> Vec<u8> {
        let mut outpoint = Vec::with_capacity(36);
        outpoint.extend_from_slice(&self.prev_txid_le);
        outpoint.extend_from_slice(&self.vout.to_le_bytes());

        // With a single input these are each the hash of one element.
        let hash_prevouts = dsha256(&outpoint);
        let hash_sequence = dsha256(&SEQUENCE.to_le_bytes());

        let mut outputs_ser = Vec::new();
        for o in &self.outputs {
            o.serialize(&mut outputs_ser);
        }
        let hash_outputs = dsha256(&outputs_ser);

        let script_code = p2wpkh_script_code(&self.key_hash);

        let mut p = Vec::with_capacity(256);
        p.extend_from_slice(&TX_VERSION.to_le_bytes());
        p.extend_from_slice(&hash_prevouts);
        p.extend_from_slice(&hash_sequence);
        p.extend_from_slice(&outpoint);
        write_varint(&mut p, script_code.len() as u64);
        p.extend_from_slice(&script_code);
        p.extend_from_slice(&self.input_value.to_le_bytes());
        p.extend_from_slice(&SEQUENCE.to_le_bytes());
        p.extend_from_slice(&hash_outputs);
        p.extend_from_slice(&LOCKTIME.to_le_bytes());
        p.extend_from_slice(&SIGHASH_ALL.to_le_bytes());
        p
    }

    /// The 32 bytes the MPC signer signs.
    pub fn sighash(&self) -> [u8; 32] {
        dsha256(&self.sighash_preimage())
    }
}

/// Builds the spend from validated fields.
///
/// `destination` is the policy-approved address and `keyring_pubkey` the
/// contract's own registered key. Neither the script nor the output set comes
/// from the caller, so there is no way to add an output or redirect one.
pub fn build_spend(
    params: &BitcoinParams,
    destination: &str,
    amount: u128,
    keyring_pubkey: Option<&String>,
) -> Result<P2wpkhSpend, BitcoinError> {
    let txid_be = decode_hex(&params.txid).ok_or(BitcoinError::InvalidTxid)?;
    if txid_be.len() != 32 {
        return Err(BitcoinError::InvalidTxid);
    }
    // Outpoints use internal (reversed) byte order, not the display form.
    let mut prev_txid_le = [0u8; 32];
    for (i, b) in txid_be.iter().rev().enumerate() {
        prev_txid_le[i] = *b;
    }

    let amount_sat = u64::try_from(amount).map_err(|_| BitcoinError::AmountTooLarge)?;
    let input_value =
        u64::try_from(params.input_value.0).map_err(|_| BitcoinError::AmountTooLarge)?;
    let target_fee = u64::try_from(params.fee.0).map_err(|_| BitcoinError::AmountTooLarge)?;

    if amount_sat > input_value {
        return Err(BitcoinError::PaymentExceedsInput);
    }
    let after_payment = input_value - amount_sat;
    let change = after_payment
        .checked_sub(target_fee)
        .ok_or(BitcoinError::InsufficientInput)?;

    let pay_script =
        p2wpkh_script_from_address(destination).ok_or(BitcoinError::InvalidDestination)?;
    let keyring_key = keyring_pubkey.ok_or(BitcoinError::NoKeyringKey)?;
    let change_script =
        p2wpkh_script_from_pubkey(keyring_key).ok_or(BitcoinError::InvalidKeyringAddress)?;
    let key_bytes = decode_hex(keyring_key).ok_or(BitcoinError::InvalidKeyringAddress)?;
    let key_hash = hash160(&key_bytes);

    let mut outputs = vec![TxOut {
        value: amount_sat,
        script_pubkey: pay_script,
    }];
    // Change below the dust threshold is not worth an output; the remainder
    // becomes fee, and the caller's fee cap is checked against that larger
    // number rather than the requested one.
    if change >= DUST_THRESHOLD {
        outputs.push(TxOut {
            value: change,
            script_pubkey: change_script,
        });
    }

    Ok(P2wpkhSpend {
        prev_txid_le,
        vout: params.vout,
        input_value,
        key_hash,
        outputs,
    })
}

/// The fee the built transaction will actually pay, without building it.
///
/// Needed because policy must check the fee *before* the transaction is
/// constructed, and the full build also needs the destination and the
/// Keyring's key. The result is the same number [`P2wpkhSpend::fee`] reports:
/// the requested fee normally, or the whole remainder when change would fall
/// below the dust threshold and is therefore omitted.
pub fn effective_fee(params: &BitcoinParams, amount: u128) -> Result<u64, BitcoinError> {
    let amount_sat = u64::try_from(amount).map_err(|_| BitcoinError::AmountTooLarge)?;
    let input_value =
        u64::try_from(params.input_value.0).map_err(|_| BitcoinError::AmountTooLarge)?;
    let target_fee = u64::try_from(params.fee.0).map_err(|_| BitcoinError::AmountTooLarge)?;

    let after_payment = input_value
        .checked_sub(amount_sat)
        .ok_or(BitcoinError::PaymentExceedsInput)?;
    let change = after_payment
        .checked_sub(target_fee)
        .ok_or(BitcoinError::InsufficientInput)?;

    Ok(if change >= DUST_THRESHOLD {
        target_fee
    } else {
        // Change is dust, so it is dropped and becomes fee. Policy sees the
        // larger number, which is what the transaction really pays.
        after_payment
    })
}
