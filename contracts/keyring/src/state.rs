//! Persistent contract state: keyrings, agents and the request lifecycle.

use crate::policy::{AggregateBudget, Policy, Refusal, SpendEntry};
use crate::types::{Asset, Chain, ChainParams};
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, PublicKey};

/// Maximum agents one owner may register. Bounds the cost of loading a keyring.
pub const MAX_AGENTS_PER_KEYRING: usize = 16;
/// Maximum request ids retained in a keyring's on-contract history index.
///
/// CLAUDE.md §6 requires bounded on-contract history. Older activity remains
/// fully reconstructible from the NEP-297 event stream by an external indexer.
pub const MAX_HISTORY_IDS: usize = 128;

/// Maximum idempotency keys retained per agent for duplicate detection.
///
/// Replay protection is therefore bounded, not absolute: an agent that reuses an
/// idempotency key after more than [`MAX_IDEMPOTENCY_RECORDS`] subsequent
/// requests will not be detected as a duplicate. This is a documented
/// limitation of keeping state bounded (CLAUDE.md §6), not an oversight; it is
/// recorded in docs/security-decisions.md.
pub const MAX_IDEMPOTENCY_RECORDS: usize = 32;

/// A remembered idempotency key and the request it produced.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct IdempotencyRecord {
    pub key: String,
    pub request_id: u64,
}

/// The rolling spend ledger for one asset on one chain.
///
/// Keyed by asset, not just chain, because caps are per asset: spending a
/// token must not consume the native coin's budget, and vice versa.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AssetLedger {
    pub chain: Chain,
    pub asset: Asset,
    pub entries: Vec<SpendEntry>,
}

impl AssetLedger {
    pub fn is(&self, chain: Chain, asset: &Asset) -> bool {
        self.chain == chain && &self.asset == asset
    }
}

/// Appends a reservation to the matching ledger in `ledgers`, creating it if
/// absent. Shared by the agent ledger and the keyring-wide ledger.
pub fn reserve_in(
    ledgers: &mut Vec<AssetLedger>,
    chain: Chain,
    asset: &Asset,
    amount: u128,
    at_ms: u64,
    request_id: u64,
) {
    let entry = SpendEntry {
        at_ms,
        amount: U128(amount),
        request_id,
    };
    match ledgers.iter_mut().find(|l| l.is(chain, asset)) {
        Some(ledger) => ledger.entries.push(entry),
        None => ledgers.push(AssetLedger {
            chain,
            asset: asset.clone(),
            entries: vec![entry],
        }),
    }
}

/// The unexpired-and-expired entries for one asset, or an empty slice.
pub fn entries_in<'a>(ledgers: &'a [AssetLedger], chain: Chain, asset: &Asset) -> &'a [SpendEntry] {
    ledgers
        .iter()
        .find(|l| l.is(chain, asset))
        .map(|l| l.entries.as_slice())
        .unwrap_or(&[])
}

/// Drops entries that have aged out of the rolling window.
///
/// Only ever removes *expired* entries, so it can never reduce the spend
/// counted inside the window.
pub fn prune_in(ledgers: &mut Vec<AssetLedger>, now_ms: u64) {
    for ledger in ledgers.iter_mut() {
        ledger
            .entries
            .retain(|e| !crate::policy::is_expired(e, now_ms));
    }
    ledgers.retain(|l| !l.entries.is_empty());
}

/// A registered agent.
///
/// The agent is identified by its NEAR public key, not by an account id. At
/// request time the contract compares `env::signer_account_pk()` against this
/// value, which is what makes invariant 1 enforceable: possession of the
/// registered key is the only way to act as this agent.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Agent {
    pub public_key: PublicKey,
    pub label: String,
    /// The owner's kill switch (CLAUDE.md §3).
    pub enabled: bool,
    pub policy: Policy,
    pub ledgers: Vec<AssetLedger>,
    pub created_at_ms: u64,
    pub requests_made: u64,
    /// Newest-last, bounded by [`MAX_IDEMPOTENCY_RECORDS`].
    pub recent_keys: Vec<IdempotencyRecord>,
}

impl Agent {
    /// This agent's spend entries for one asset.
    pub fn entries(&self, chain: Chain, asset: &Asset) -> &[SpendEntry] {
        entries_in(&self.ledgers, chain, asset)
    }

    /// Records a reservation against this agent's rolling budget.
    ///
    /// Called *before* any asynchronous signing begins, per CLAUDE.md §6:
    /// budget is committed at authorisation time, never after a signature
    /// returns.
    pub fn reserve(
        &mut self,
        chain: Chain,
        asset: &Asset,
        amount: u128,
        at_ms: u64,
        request_id: u64,
    ) {
        reserve_in(&mut self.ledgers, chain, asset, amount, at_ms, request_id);
    }

    /// Looks up a previously seen idempotency key.
    pub fn find_idempotency(&self, key: &str) -> Option<u64> {
        self.recent_keys
            .iter()
            .find(|r| r.key == key)
            .map(|r| r.request_id)
    }

    /// Remembers an idempotency key, evicting the oldest when full.
    pub fn remember_idempotency(&mut self, key: String, request_id: u64) {
        if self.recent_keys.len() >= MAX_IDEMPOTENCY_RECORDS {
            self.recent_keys.remove(0);
        }
        self.recent_keys.push(IdempotencyRecord { key, request_id });
    }

    /// Drops entries that have aged out of the rolling window.
    ///
    /// Pruning only ever removes *expired* entries, so it can never reduce the
    /// spend counted inside the window.
    pub fn prune_expired(&mut self, now_ms: u64) {
        for ledger in self.ledgers.iter_mut() {
            ledger
                .entries
                .retain(|e| !crate::policy::is_expired(e, now_ms));
        }
        self.ledgers.retain(|l| !l.entries.is_empty());
    }
}

/// One owner's Keyring.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Keyring {
    pub owner: AccountId,
    pub created_at_ms: u64,
    pub agents: Vec<Agent>,
    /// Newest-last index of recent request ids, bounded by [`MAX_HISTORY_IDS`].
    pub history: Vec<u64>,
    /// Optional owner-wide 24-hour ceilings, across every agent.
    pub aggregate: AggregateBudget,
    /// Keyring-wide spend ledger, one entry per authorised request.
    ///
    /// This is the rolled-up counter the owner-wide cap is checked against.
    /// Maintained alongside the agent ledger rather than computed by scanning
    /// every agent, which would be O(agents * entries) on every request.
    ///
    /// It is deliberately **not** touched by `revoke_agent`. Destroying an
    /// agent clears that agent's own ledger, but must not reduce the keyring
    /// total, or revoke-and-re-register would reset the owner-wide budget.
    pub ledgers: Vec<AssetLedger>,
}

impl Keyring {
    pub fn new(owner: AccountId, created_at_ms: u64) -> Self {
        Self {
            owner,
            created_at_ms,
            agents: Vec::new(),
            history: Vec::new(),
            aggregate: AggregateBudget::default(),
            ledgers: Vec::new(),
        }
    }

    /// The keyring-wide entries for one asset.
    pub fn entries(&self, chain: Chain, asset: &Asset) -> &[SpendEntry] {
        entries_in(&self.ledgers, chain, asset)
    }

    /// Records a reservation against the keyring-wide budget.
    pub fn reserve(
        &mut self,
        chain: Chain,
        asset: &Asset,
        amount: u128,
        at_ms: u64,
        request_id: u64,
    ) {
        reserve_in(&mut self.ledgers, chain, asset, amount, at_ms, request_id);
    }

    /// Drops keyring-wide entries that have aged out of the window.
    pub fn prune_expired(&mut self, now_ms: u64) {
        prune_in(&mut self.ledgers, now_ms);
    }

    pub fn agent(&self, public_key: &PublicKey) -> Option<&Agent> {
        self.agents.iter().find(|a| &a.public_key == public_key)
    }

    pub fn agent_mut(&mut self, public_key: &PublicKey) -> Option<&mut Agent> {
        self.agents.iter_mut().find(|a| &a.public_key == public_key)
    }

    /// Appends to the bounded history index.
    ///
    /// Returns the request id evicted to make room, if any. The caller must
    /// delete that request from the request map, which is what keeps total
    /// storage bounded by [`MAX_HISTORY_IDS`] per keyring rather than growing
    /// without limit as requests accumulate.
    #[must_use]
    pub fn push_history(&mut self, request_id: u64) -> Option<u64> {
        let evicted = if self.history.len() >= MAX_HISTORY_IDS {
            Some(self.history.remove(0))
        } else {
            None
        };
        self.history.push(request_id);
        evicted
    }
}

/// Lifecycle state of a transfer request.
///
/// This models exactly the transitions in CLAUDE.md §6:
///
/// ```text
/// Created -> Refused
/// Created -> Signing -> Signed
/// Created -> Signing -> Failed
/// ```
///
/// Every state is reachable and covered by tests. `Refused`, `Signed` and
/// `Failed` are terminal.
///
/// `Created` is **transient**: `request_transfer` writes it, then moves the
/// request to `Signing` (MPC backend) or straight to `Signed` (mock backend)
/// within the same call. No externally observable committed state is ever
/// `Created`, so a reader polling this contract will not see it.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    /// Passed policy and budget reserved, but not yet handed to the signer.
    ///
    /// Transient — always overwritten later in the same call. See the note on
    /// this enum.
    Created,
    /// Denied by policy. Terminal. No budget was reserved.
    Refused,
    /// Sent to the MPC signer; awaiting callback. Budget remains reserved.
    Signing,
    /// A signature was produced. Terminal on NEAR.
    ///
    /// This does **not** mean the destination-chain transaction was broadcast or
    /// confirmed (invariant 13). The reservation is never released on the basis
    /// of this state.
    Signed,
    /// Signing failed. Terminal.
    ///
    /// Whether the reservation is released depends on whether the contract can
    /// establish that no usable signature was produced; see CLAUDE.md §6.
    Failed,
}

/// A signature recorded against a request.
///
/// `mock` is part of the stored data, not merely a deployment-level flag, so
/// that a mock signature cannot be mistaken for a real one by anything reading
/// a request — a dashboard, an indexer or a demo transcript. A real signature
/// and a mock one are distinguishable at the data level, permanently.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StoredSignature {
    /// Always `Secp256k1` for the chains Keyring supports.
    pub scheme: String,
    /// Hex-encoded curve point `big_r`.
    pub big_r: String,
    /// Hex-encoded scalar `s`.
    pub s: String,
    pub recovery_id: u8,
    /// True when produced by the mock backend. Never a valid signature.
    pub mock: bool,
}

/// A transfer request and its audit record.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TransferRequest {
    pub id: u64,
    pub owner: AccountId,
    pub agent_public_key: PublicKey,
    pub chain: Chain,
    /// What was moved: the native coin, or a token.
    pub asset: Asset,
    /// Normalised destination address.
    pub destination: String,
    pub amount: U128,
    /// The maximum fee the signed transaction can pay, in base units.
    ///
    /// **Derived, never supplied.** For EVM this is
    /// `gas_limit * max_fee_per_gas` computed from [`TransferRequest::params`],
    /// so the value policy checked and the value the transaction can actually
    /// spend are the same number (invariant 9).
    pub fee: U128,
    /// The chain-specific inputs used to build the transaction.
    ///
    /// Recorded so the signed transaction can be reassembled and audited.
    pub params: ChainParams,
    pub status: RequestStatus,
    /// Budget reserved for this request, in base units. Zero when refused.
    pub reserved: U128,
    pub idempotency_key: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    /// Present exactly when `status == Refused`.
    pub refusal: Option<Refusal>,
    /// Present exactly when `status == Signed`.
    ///
    /// A signature here means the MPC network produced one. It does **not**
    /// mean the destination-chain transaction was broadcast or confirmed
    /// (invariant 13), and the reservation is never released on the strength
    /// of it.
    pub signature: Option<StoredSignature>,
    /// Present exactly when `status == Failed`: why signing did not complete.
    pub failure_reason: Option<String>,
    /// The exact payload sent to the MPC signer, hex-encoded.
    ///
    /// Recorded so an auditor can independently verify that what was signed
    /// corresponds to what policy approved (invariant 6).
    pub payload_hex: Option<String>,
}
