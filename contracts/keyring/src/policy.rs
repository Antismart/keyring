//! Policy model, refusal taxonomy and the deterministic policy evaluator.
//!
//! This module is the policy enforcement boundary described in CLAUDE.md §4. It
//! is deliberately free of NEAR cross-contract machinery and of signing logic:
//! it is pure integer logic over validated structured fields, so every rule can
//! be tested on both sides of its boundary (§10) without a blockchain.

use crate::types::{normalize_destination, Asset, Chain, MAX_DESTINATION_LEN};
use near_sdk::json_types::U128;
use near_sdk::near;

/// Maximum number of per-chain policy entries on one agent. Bounds state growth.
pub const MAX_CHAIN_POLICIES: usize = 4;
/// Maximum number of allowlisted destinations per asset. Bounds state growth.
pub const MAX_DESTINATIONS: usize = 32;
/// Maximum number of assets per chain on one agent. Bounds state growth.
pub const MAX_ASSETS_PER_CHAIN: usize = 8;
/// Rolling spending window length. CLAUDE.md §3 fixes this at 24 hours.
pub const ROLLING_WINDOW_MS: u64 = 24 * 60 * 60 * 1_000;
/// Minutes in a day, for time-window validation.
pub const MINUTES_PER_DAY: u32 = 24 * 60;

/// A UTC time-of-day window during which an agent may transact.
///
/// Expressed in minutes from UTC midnight. The window is half-open:
/// `[start_minute, end_minute)`.
///
/// When `start_minute > end_minute` the window wraps midnight (an "overnight"
/// window, e.g. 22:00–06:00), which CLAUDE.md §10 requires us to support and
/// test explicitly. `start_minute == end_minute` is rejected at validation time
/// as ambiguous rather than being silently read as "always" or "never".
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TimeWindow {
    pub start_minute: u32,
    pub end_minute: u32,
}

impl TimeWindow {
    /// Whether this window is syntactically valid.
    pub fn is_valid(&self) -> bool {
        self.start_minute < MINUTES_PER_DAY
            && self.end_minute < MINUTES_PER_DAY
            && self.start_minute != self.end_minute
    }

    /// Whether the window wraps past midnight.
    pub fn is_overnight(&self) -> bool {
        self.start_minute > self.end_minute
    }

    /// Whether `minute_of_day` falls inside the window.
    pub fn contains(&self, minute_of_day: u32) -> bool {
        if self.is_overnight() {
            minute_of_day >= self.start_minute || minute_of_day < self.end_minute
        } else {
            minute_of_day >= self.start_minute && minute_of_day < self.end_minute
        }
    }
}

/// Limits for one asset on one chain.
///
/// Amount limits are per asset, not merely per chain, because amounts are in
/// the asset's own base units: a cap shared between ETH (18 decimals) and a
/// USDC-like token (6) would be meaningless. The presence of an `AssetPolicy`
/// *is* the asset allowlist — an agent with no entry for an asset cannot move
/// it, and an agent with no entry for the native coin cannot send native value
/// even if it may move tokens.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AssetPolicy {
    pub asset: Asset,
    /// Largest single transfer, in the asset's base units.
    pub max_per_request: U128,
    /// Largest total spend in any rolling 24-hour window, in base units.
    pub max_per_24h: U128,
    /// Addresses this agent may pay with this asset. Empty permits nobody; it
    /// is never read as "anyone".
    pub allowed_destinations: Vec<String>,
}

/// Per-chain policy: the fee ceiling plus the assets this agent may move.
///
/// The presence of a `ChainPolicy` for a chain *is* the chain allowlist. The
/// fee cap lives here rather than on an asset because a fee is always paid in
/// the chain's native coin, whatever asset is being transferred — an ERC-20
/// transfer still costs ETH.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ChainPolicy {
    pub chain: Chain,
    /// Largest acceptable network fee for one transaction, in the chain's
    /// native base units.
    pub max_fee: U128,
    pub assets: Vec<AssetPolicy>,
}

impl ChainPolicy {
    pub fn asset_policy(&self, asset: &Asset) -> Option<&AssetPolicy> {
        self.assets.iter().find(|a| &a.asset == asset)
    }
}

/// An owner-wide 24-hour ceiling for one asset on one chain.
///
/// Agent caps bound a single agent. This bounds the whole keyring: the sum
/// across every agent the owner has registered. Without it, an owner running N
/// agents each capped at C is exposed to N times C, which is easy to miss when
/// reading a policy that says "2 ETH per 24h".
///
/// It is optional. An owner who wants per-agent limits only can leave it unset,
/// and nothing changes.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AggregateCap {
    pub chain: Chain,
    pub asset: Asset,
    /// Largest total spend across all of this owner's agents in any rolling
    /// 24-hour window, in the asset's base units.
    pub max_per_24h: U128,
}

/// The owner-wide budget attached to a keyring.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct AggregateBudget {
    pub caps: Vec<AggregateCap>,
}

impl AggregateBudget {
    pub fn cap_for(&self, chain: Chain, asset: &Asset) -> Option<u128> {
        self.caps
            .iter()
            .find(|c| c.chain == chain && &c.asset == asset)
            .map(|c| c.max_per_24h.0)
    }
}

/// Maximum owner-wide caps one keyring may define. Bounds state growth.
pub const MAX_AGGREGATE_CAPS: usize = 8;

/// The complete policy attached to one agent.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Policy {
    pub chains: Vec<ChainPolicy>,
    /// Optional UTC time-of-day restriction. `None` means no time restriction.
    pub time_window: Option<TimeWindow>,
}

impl Policy {
    pub fn chain_policy(&self, chain: Chain) -> Option<&ChainPolicy> {
        self.chains.iter().find(|c| c.chain == chain)
    }

    pub fn asset_policy(&self, chain: Chain, asset: &Asset) -> Option<&AssetPolicy> {
        self.chain_policy(chain)?.asset_policy(asset)
    }
}

/// Why a policy was rejected as malformed, when an owner tries to set it.
///
/// This is distinct from a refusal: a refusal is a well-formed request denied by
/// a valid policy, whereas this is an invalid policy that is never stored.
#[derive(Debug, PartialEq, Eq)]
pub enum PolicyError {
    TooManyChainPolicies,
    DuplicateChain,
    TooManyDestinations,
    InvalidDestination(String),
    DestinationTooLong,
    InvalidTimeWindow,
    TooManyAssets,
    DuplicateAsset,
    /// An asset that cannot exist on the chain it was attached to, e.g. an
    /// ERC-20 on Bitcoin.
    AssetNotValidForChain,
    /// A token address that is not a well-formed contract address.
    InvalidTokenAddress(String),
    TooManyAggregateCaps,
    DuplicateAggregateCap,
    /// A per-request cap above the 24h cap can never bind, which is almost
    /// always an owner mistake. Reject it rather than store a misleading policy.
    PerRequestCapAboveDailyCap,
    ZeroCap,
}

impl PolicyError {
    pub fn message(&self) -> String {
        match self {
            PolicyError::TooManyChainPolicies => {
                format!("at most {MAX_CHAIN_POLICIES} chain policies are allowed")
            }
            PolicyError::DuplicateChain => "each chain may appear at most once".to_string(),
            PolicyError::TooManyDestinations => {
                format!("at most {MAX_DESTINATIONS} destinations per chain are allowed")
            }
            PolicyError::InvalidDestination(d) => {
                format!("destination is not a valid address for its chain: {d}")
            }
            PolicyError::DestinationTooLong => {
                format!("destination exceeds {MAX_DESTINATION_LEN} characters")
            }
            PolicyError::TooManyAssets => {
                format!("at most {MAX_ASSETS_PER_CHAIN} assets per chain are allowed")
            }
            PolicyError::DuplicateAsset => {
                "each asset may appear at most once per chain".to_string()
            }
            PolicyError::AssetNotValidForChain => {
                "this asset cannot exist on that chain".to_string()
            }
            PolicyError::InvalidTokenAddress(t) => {
                format!("token is not a valid contract address: {t}")
            }
            PolicyError::TooManyAggregateCaps => {
                format!("at most {MAX_AGGREGATE_CAPS} owner-wide caps are allowed")
            }
            PolicyError::DuplicateAggregateCap => {
                "each chain/asset pair may have at most one owner-wide cap".to_string()
            }
            PolicyError::InvalidTimeWindow => {
                "time window minutes must be < 1440 and start must differ from end".to_string()
            }
            PolicyError::PerRequestCapAboveDailyCap => {
                "max_per_request must not exceed max_per_24h".to_string()
            }
            PolicyError::ZeroCap => {
                "caps must be greater than zero; disable the agent instead".to_string()
            }
        }
    }
}

/// Validates and canonicalises an owner-supplied policy.
///
/// Returns the policy with every destination normalised, so that stored policy
/// and request-time comparison use exactly the same representation.
pub fn validate_policy(mut policy: Policy) -> Result<Policy, PolicyError> {
    if policy.chains.len() > MAX_CHAIN_POLICIES {
        return Err(PolicyError::TooManyChainPolicies);
    }
    if let Some(w) = policy.time_window {
        if !w.is_valid() {
            return Err(PolicyError::InvalidTimeWindow);
        }
    }

    let mut seen_chains: Vec<Chain> = Vec::new();
    for cp in policy.chains.iter_mut() {
        if seen_chains.contains(&cp.chain) {
            return Err(PolicyError::DuplicateChain);
        }
        seen_chains.push(cp.chain);

        if cp.assets.len() > MAX_ASSETS_PER_CHAIN {
            return Err(PolicyError::TooManyAssets);
        }

        let mut seen_assets: Vec<Asset> = Vec::new();
        for ap in cp.assets.iter_mut() {
            if seen_assets.contains(&ap.asset) {
                return Err(PolicyError::DuplicateAsset);
            }
            if !ap.asset.is_valid_for(cp.chain) {
                return Err(PolicyError::AssetNotValidForChain);
            }

            // A token is identified by its contract address, which must be
            // canonicalised exactly like a destination: otherwise a policy for
            // `0xABC…` would not match a request naming `0xabc…`.
            if let Asset::Erc20 { token } = &ap.asset {
                let canon = normalize_destination(cp.chain, token)
                    .ok_or_else(|| PolicyError::InvalidTokenAddress(token.clone()))?;
                ap.asset = Asset::Erc20 { token: canon };
            }
            seen_assets.push(ap.asset.clone());

            if ap.allowed_destinations.len() > MAX_DESTINATIONS {
                return Err(PolicyError::TooManyDestinations);
            }
            if ap.max_per_request.0 == 0 || ap.max_per_24h.0 == 0 {
                return Err(PolicyError::ZeroCap);
            }
            if ap.max_per_request.0 > ap.max_per_24h.0 {
                return Err(PolicyError::PerRequestCapAboveDailyCap);
            }

            let mut normalized = Vec::with_capacity(ap.allowed_destinations.len());
            for dest in ap.allowed_destinations.iter() {
                if dest.len() > MAX_DESTINATION_LEN {
                    return Err(PolicyError::DestinationTooLong);
                }
                let canon = normalize_destination(cp.chain, dest)
                    .ok_or_else(|| PolicyError::InvalidDestination(dest.clone()))?;
                if !normalized.contains(&canon) {
                    normalized.push(canon);
                }
            }
            ap.allowed_destinations = normalized;
        }
    }
    Ok(policy)
}

/// Validates and canonicalises an owner-wide budget.
pub fn validate_aggregate(mut budget: AggregateBudget) -> Result<AggregateBudget, PolicyError> {
    if budget.caps.len() > MAX_AGGREGATE_CAPS {
        return Err(PolicyError::TooManyAggregateCaps);
    }
    let mut seen: Vec<(Chain, Asset)> = Vec::new();
    for cap in budget.caps.iter_mut() {
        if !cap.asset.is_valid_for(cap.chain) {
            return Err(PolicyError::AssetNotValidForChain);
        }
        if let Asset::Erc20 { token } = &cap.asset {
            let canon = normalize_destination(cap.chain, token)
                .ok_or_else(|| PolicyError::InvalidTokenAddress(token.clone()))?;
            cap.asset = Asset::Erc20 { token: canon };
        }
        let key = (cap.chain, cap.asset.clone());
        if seen.contains(&key) {
            return Err(PolicyError::DuplicateAggregateCap);
        }
        seen.push(key);
        if cap.max_per_24h.0 == 0 {
            return Err(PolicyError::ZeroCap);
        }
    }
    Ok(budget)
}

/// Stable machine-readable refusal codes.
///
/// These are part of the public API: the SDK, the MCP server and the demo all
/// branch on them, so the string forms must not change casually. CLAUDE.md §13
/// treats the refusal as a product feature, not an error to hide.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum RefusalCode {
    AgentNotRegistered,
    AgentDisabled,
    ChainNotAllowed,
    AssetNotAllowed,
    MalformedDestination,
    DestinationNotAllowed,
    OutsideTimeWindow,
    AmountZero,
    PerRequestCapExceeded,
    FeeCapExceeded,
    DailyCapExceeded,
    OwnerDailyCapExceeded,
    BudgetLedgerFull,
    OwnerBudgetLedgerFull,
    DuplicateRequest,
}

impl RefusalCode {
    pub const fn as_str(&self) -> &'static str {
        match self {
            RefusalCode::AgentNotRegistered => "agent_not_registered",
            RefusalCode::AgentDisabled => "agent_disabled",
            RefusalCode::ChainNotAllowed => "chain_not_allowed",
            RefusalCode::AssetNotAllowed => "asset_not_allowed",
            RefusalCode::MalformedDestination => "malformed_destination",
            RefusalCode::DestinationNotAllowed => "destination_not_allowed",
            RefusalCode::OutsideTimeWindow => "outside_time_window",
            RefusalCode::AmountZero => "amount_zero",
            RefusalCode::PerRequestCapExceeded => "per_request_cap_exceeded",
            RefusalCode::FeeCapExceeded => "fee_cap_exceeded",
            RefusalCode::DailyCapExceeded => "daily_cap_exceeded",
            RefusalCode::OwnerDailyCapExceeded => "owner_daily_cap_exceeded",
            RefusalCode::BudgetLedgerFull => "budget_ledger_full",
            RefusalCode::OwnerBudgetLedgerFull => "owner_budget_ledger_full",
            RefusalCode::DuplicateRequest => "duplicate_request",
        }
    }

    /// The policy rule this refusal came from, for audit and dashboard grouping.
    pub const fn rule(&self) -> &'static str {
        match self {
            RefusalCode::AgentNotRegistered | RefusalCode::AgentDisabled => "agent_state",
            RefusalCode::ChainNotAllowed => "chain_allowlist",
            RefusalCode::AssetNotAllowed => "asset_allowlist",
            RefusalCode::MalformedDestination | RefusalCode::DestinationNotAllowed => {
                "destination_allowlist"
            }
            RefusalCode::OutsideTimeWindow => "time_window",
            RefusalCode::AmountZero | RefusalCode::PerRequestCapExceeded => "per_request_cap",
            RefusalCode::FeeCapExceeded => "fee_cap",
            RefusalCode::DailyCapExceeded | RefusalCode::BudgetLedgerFull => "rolling_24h_cap",
            RefusalCode::OwnerDailyCapExceeded | RefusalCode::OwnerBudgetLedgerFull => {
                "owner_rolling_24h_cap"
            }
            RefusalCode::DuplicateRequest => "idempotency",
        }
    }
}

/// A structured refusal, as required by CLAUDE.md §6.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Refusal {
    pub code: RefusalCode,
    pub rule: String,
    pub message: String,
    /// The configured limit that was violated, where the rule has a numeric limit.
    pub limit: Option<U128>,
    /// The value actually observed, where the rule has a numeric limit.
    pub observed: Option<U128>,
}

impl Refusal {
    pub fn new(code: RefusalCode, message: String) -> Self {
        Self {
            code,
            rule: code.rule().to_string(),
            message,
            limit: None,
            observed: None,
        }
    }

    pub fn with_numbers(code: RefusalCode, message: String, limit: u128, observed: u128) -> Self {
        Self {
            code,
            rule: code.rule().to_string(),
            message,
            limit: Some(U128(limit)),
            observed: Some(U128(observed)),
        }
    }
}

/// The validated, structured description of what an agent is asking to do.
///
/// The evaluator sees only this. Note what is absent: there is no calldata, no
/// transaction preimage, no output list and no raw hash. That absence is the
/// enforcement of CLAUDE.md §4 and invariants 5–8 — a caller has no field in
/// which to smuggle an extra recipient or a different amount, because the
/// transaction is later built by the contract from exactly these fields.
#[derive(Clone, Debug)]
pub struct TransferIntent {
    pub chain: Chain,
    /// What is being moved: the native coin, or a token.
    pub asset: Asset,
    /// Already normalised by the caller of the evaluator.
    pub destination: String,
    /// Transfer value in the asset's base units.
    pub amount: u128,
    /// The fee the transaction will actually pay, in the chain's native units.
    pub fee: u128,
}

/// A single recorded spend in the rolling window.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SpendEntry {
    pub at_ms: u64,
    pub amount: U128,
    pub request_id: u64,
}

/// Maximum spend entries retained per chain in the rolling ledger.
///
/// When the ledger is full of entries that are all still inside the window, the
/// evaluator refuses with [`RefusalCode::BudgetLedgerFull`] rather than evicting
/// an entry. Evicting would under-count spend and let the 24h cap be exceeded,
/// so refusing is the conservative choice required by invariant 11.
pub const MAX_SPEND_ENTRIES: usize = 64;

/// Maximum spend entries retained per asset in the keyring-wide ledger.
///
/// Larger than the per-agent bound because every agent's authorised spend
/// appends here, so it fills faster. Still bounded, and it still refuses
/// rather than evicting a live entry, for the same reason.
pub const MAX_OWNER_SPEND_ENTRIES: usize = 256;

/// Sums the spend entries that still fall inside the rolling window ending at `now_ms`.
///
/// Entries at exactly `now_ms - ROLLING_WINDOW_MS` have expired (the window is
/// half-open), which is the boundary CLAUDE.md §10 requires to be tested.
pub fn spend_in_window(entries: &[SpendEntry], now_ms: u64) -> u128 {
    let cutoff = now_ms.saturating_sub(ROLLING_WINDOW_MS);
    entries
        .iter()
        .filter(|e| e.at_ms > cutoff)
        .fold(0u128, |acc, e| acc.saturating_add(e.amount.0))
}

/// Whether an entry has aged out of the window ending at `now_ms`.
pub fn is_expired(entry: &SpendEntry, now_ms: u64) -> bool {
    entry.at_ms <= now_ms.saturating_sub(ROLLING_WINDOW_MS)
}

/// The outcome of evaluating one intent against one policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// The request passed every rule. The carried value is the spend that must
    /// be reserved against the rolling budget before any signing may begin.
    Allow {
        reserve: u128,
    },
    Refuse(Refusal),
}
/// Everything the evaluator needs.
///
/// Supplied by the caller, which keeps the evaluator a pure function of its
/// inputs and so directly unit-testable without a VM.
pub struct Evaluation<'a> {
    pub enabled: bool,
    pub policy: &'a Policy,
    /// This agent's spend entries for the chain and asset being requested.
    pub agent_entries: &'a [SpendEntry],
    /// The owner-wide cap for this chain and asset, if the owner set one.
    pub owner_cap: Option<u128>,
    /// The keyring-wide spend entries for this chain and asset.
    pub owner_entries: &'a [SpendEntry],
    pub intent: &'a TransferIntent,
    pub now_ms: u64,
}

/// Evaluates a transfer intent against an agent's policy.
///
/// **Evaluation order is fixed and deterministic** (CLAUDE.md §6). Cheap
/// identity and state checks come first, then allowlists, then the time
/// window, then numeric caps from narrowest to widest scope:
///
///  1. agent enabled          -> `agent_disabled`
///  2. chain allowlist        -> `chain_not_allowed`
///  3. asset allowlist        -> `asset_not_allowed`
///  4. destination allowlist  -> `destination_not_allowed`
///  5. time window            -> `outside_time_window`
///  6. non-zero amount        -> `amount_zero`
///  7. per-request cap        -> `per_request_cap_exceeded`
///  8. fee cap                -> `fee_cap_exceeded`
///  9. agent 24h cap          -> `daily_cap_exceeded`
/// 10. owner-wide 24h cap     -> `owner_daily_cap_exceeded`
///
/// A request violating several rules always reports the first in this order, so
/// refusals are reproducible and an agent cannot learn a different limit by
/// re-ordering its own request fields.
///
/// The owner-wide cap is checked **last** among the numeric rules, deliberately.
/// The narrower limit is the more useful one to report, and an agent should not
/// be told about other agents' spending until its own limits are satisfied.
pub fn evaluate(input: &Evaluation) -> Decision {
    let intent = input.intent;
    let now_ms = input.now_ms;

    // 1. Kill switch.
    if !input.enabled {
        return Decision::Refuse(Refusal::new(
            RefusalCode::AgentDisabled,
            "agent is disabled by its owner".to_string(),
        ));
    }

    // 2. Chain allowlist: the absence of a ChainPolicy is the denial.
    let Some(cp) = input.policy.chain_policy(intent.chain) else {
        return Decision::Refuse(Refusal::new(
            RefusalCode::ChainNotAllowed,
            format!(
                "chain {} is not in this agent's policy",
                intent.chain.as_str()
            ),
        ));
    };

    // 3. Asset allowlist. An agent permitted to move a token is not thereby
    //    permitted to send native value, and the reverse.
    let Some(ap) = cp.asset_policy(&intent.asset) else {
        return Decision::Refuse(Refusal::new(
            RefusalCode::AssetNotAllowed,
            format!(
                "asset {} is not permitted on {}",
                intent.asset.label(),
                intent.chain.as_str()
            ),
        ));
    };

    // 4. Destination allowlist, scoped to this asset.
    if !ap
        .allowed_destinations
        .iter()
        .any(|d| d == &intent.destination)
    {
        return Decision::Refuse(Refusal::new(
            RefusalCode::DestinationNotAllowed,
            format!(
                "destination {} is not allowlisted for {}",
                intent.destination,
                intent.asset.label()
            ),
        ));
    }

    // 5. Time window, in UTC minutes of day.
    if let Some(window) = input.policy.time_window {
        let minute_of_day = ((now_ms / 60_000) % u64::from(MINUTES_PER_DAY)) as u32;
        if !window.contains(minute_of_day) {
            return Decision::Refuse(Refusal::new(
                RefusalCode::OutsideTimeWindow,
                format!(
                    "current UTC minute {} is outside the permitted window {}..{}",
                    minute_of_day, window.start_minute, window.end_minute
                ),
            ));
        }
    }

    // 6. A zero-value transfer is never useful and would consume a slot.
    if intent.amount == 0 {
        return Decision::Refuse(Refusal::new(
            RefusalCode::AmountZero,
            "transfer amount must be greater than zero".to_string(),
        ));
    }

    let unit = intent.asset.base_unit(intent.chain);

    // 7. Per-request cap. Boundary: amount == cap allowed, cap + 1 is not.
    if intent.amount > ap.max_per_request.0 {
        return Decision::Refuse(Refusal::with_numbers(
            RefusalCode::PerRequestCapExceeded,
            format!(
                "amount {} {} exceeds the per-request cap of {} {}",
                intent.amount, unit, ap.max_per_request.0, unit
            ),
            ap.max_per_request.0,
            intent.amount,
        ));
    }

    // 8. Fee cap, against the fee this transaction will actually pay
    //    (invariant 9). Always in the chain's native units.
    if intent.fee > cp.max_fee.0 {
        return Decision::Refuse(Refusal::with_numbers(
            RefusalCode::FeeCapExceeded,
            format!(
                "fee {} {} exceeds the fee cap of {} {}",
                intent.fee,
                intent.chain.base_unit(),
                cp.max_fee.0,
                intent.chain.base_unit()
            ),
            cp.max_fee.0,
            intent.fee,
        ));
    }

    // 9. This agent's rolling 24-hour cap.
    let agent_live = input
        .agent_entries
        .iter()
        .filter(|e| !is_expired(e, now_ms))
        .count();
    let agent_already = spend_in_window(input.agent_entries, now_ms);
    let agent_projected = agent_already.saturating_add(intent.amount);
    if agent_projected > ap.max_per_24h.0 {
        return Decision::Refuse(Refusal::with_numbers(
            RefusalCode::DailyCapExceeded,
            format!(
                "this would bring the agent's 24h spend to {} {}, over its cap of {} {} ({} already committed)",
                agent_projected, unit, ap.max_per_24h.0, unit, agent_already
            ),
            ap.max_per_24h.0,
            agent_projected,
        ));
    }
    if agent_live >= MAX_SPEND_ENTRIES {
        return Decision::Refuse(Refusal::new(
            RefusalCode::BudgetLedgerFull,
            format!(
                "the agent's spend ledger holds {MAX_SPEND_ENTRIES} live entries for this asset; wait for older entries to age out"
            ),
        ));
    }

    // 10. The owner-wide cap across every agent in the keyring, when set.
    if let Some(owner_cap) = input.owner_cap {
        let owner_already = spend_in_window(input.owner_entries, now_ms);
        let owner_projected = owner_already.saturating_add(intent.amount);
        if owner_projected > owner_cap {
            return Decision::Refuse(Refusal::with_numbers(
                RefusalCode::OwnerDailyCapExceeded,
                format!(
                    "this would bring the keyring's total 24h spend to {} {}, over the owner-wide cap of {} {} ({} already committed across all agents)",
                    owner_projected, unit, owner_cap, unit, owner_already
                ),
                owner_cap,
                owner_projected,
            ));
        }
        let owner_live = input
            .owner_entries
            .iter()
            .filter(|e| !is_expired(e, now_ms))
            .count();
        if owner_live >= MAX_OWNER_SPEND_ENTRIES {
            return Decision::Refuse(Refusal::new(
                RefusalCode::OwnerBudgetLedgerFull,
                format!(
                    "the keyring's spend ledger holds {MAX_OWNER_SPEND_ENTRIES} live entries for this asset; wait for older entries to age out"
                ),
            ));
        }
    }

    Decision::Allow {
        reserve: intent.amount,
    }
}
