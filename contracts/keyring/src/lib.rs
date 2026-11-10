//! # Keyring
//!
//! Policy-enforced wallet infrastructure for AI agents.
//!
//! An owner registers a Keyring, registers one or more agent public keys, and
//! attaches a spending policy to each. An agent holding a registered key may
//! *request* a transfer; this contract decides whether that request is within
//! policy. Only a request that passes every rule may proceed to signing.
//!
//! ## The enforcement boundary
//!
//! This contract is the policy enforcement boundary (CLAUDE.md §4). The agent
//! runtime above it is untrusted, and the SDK/MCP layer between them is
//! semi-trusted: neither may increase authorised spend or redirect funds.
//!
//! The method surface here is what makes that true. There is no method that
//! signs a caller-supplied hash, no method that accepts calldata or a
//! transaction preimage, and no method that lets a caller name a derivation
//! path. A transfer request carries only `(chain, destination, amount, fee)` —
//! four validated structured fields. The transaction itself is built by this
//! contract from those fields at Gate D/E, so there is no field in which a
//! caller can smuggle a second recipient or a different amount (invariants 5–8).
//!
//! ## Gate status
//!
//! This is Gate A (CLAUDE.md §12): state, interfaces, the policy engine and a
//! mock signer. `request_transfer` evaluates policy, reserves budget and records
//! the request, then stops at `Created`. It does **not** sign: no MPC call, no
//! transaction construction. `Signing`/`Signed`/`Failed` are declared but
//! unreachable until Gate C verifies the real signer interface.

pub mod events;
pub mod mpc;
pub mod policy;
pub mod signer;
pub mod state;
pub mod types;

use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, require, AccountId, PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey,
};

use policy::{evaluate, validate_policy, Decision, Policy, Refusal, RefusalCode, TransferIntent};
use signer::SignerBackend;
use state::{
    Agent, Keyring, RequestStatus, StoredSignature, TransferRequest, MAX_AGENTS_PER_KEYRING,
};
use types::{normalize_destination, Chain, MAX_IDEMPOTENCY_KEY_LEN, MAX_LABEL_LEN};

/// What a caller gets back from `request_transfer`.
///
/// A refusal is a normal, successful return value, not a panic. This is
/// deliberate: panicking would roll back the state change, discarding the audit
/// record of the refusal, and CLAUDE.md §13 treats the refusal as part of the
/// product. The caller must branch on this enum rather than relying on the
/// call succeeding.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum RequestOutcome {
    /// Passed policy. Budget is reserved and the request is recorded.
    Created { request_id: u64, reserved: U128 },
    /// Denied by policy. No budget was reserved.
    Refused { request_id: u64, refusal: Refusal },
    /// This idempotency key was already used by this agent; the original
    /// request is returned instead of creating a second one.
    Duplicate { request_id: u64 },
    /// Policy passed and the MPC network produced a signature.
    ///
    /// This does not mean the destination-chain transaction was broadcast or
    /// confirmed (invariant 13).
    Signed { request_id: u64 },
    /// Policy passed but signing did not complete.
    ///
    /// The budget reservation is **retained**; see `on_signed`.
    SigningFailed { request_id: u64, reason: String },
}

/// What a caller gets back from the `simulate_transfer` view.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SimulationResult {
    /// Whether an identical request would be allowed right now.
    pub allowed: bool,
    /// The refusal that would be returned, when `allowed` is false.
    pub refusal: Option<Refusal>,
    /// Budget that would be reserved, when `allowed` is true.
    pub would_reserve: Option<U128>,
    /// Spend already committed in the current rolling window, for this chain.
    pub spent_24h: U128,
    /// The configured 24h cap for this chain, if the chain is allowed at all.
    pub cap_24h: Option<U128>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// Owner account id -> that owner's Keyring.
    keyrings: IterableMap<AccountId, Keyring>,
    /// Agent public key -> owning account.
    ///
    /// This index makes agent public keys globally unique across the contract.
    /// Without it, the same key could be registered under two keyrings and the
    /// contract could not say unambiguously which agent is calling, which would
    /// undermine invariant 1.
    agent_owner: IterableMap<PublicKey, AccountId>,
    /// Request id -> request. Bounded per keyring; see [`state::MAX_HISTORY_IDS`].
    requests: IterableMap<u64, TransferRequest>,
    next_request_id: u64,
    signer: SignerBackend,
}

#[near]
impl Contract {
    /// Initialises the contract with its signing backend.
    #[init]
    pub fn new(signer: SignerBackend) -> Self {
        Self {
            keyrings: IterableMap::new(b"k".to_vec()),
            agent_owner: IterableMap::new(b"o".to_vec()),
            requests: IterableMap::new(b"r".to_vec()),
            next_request_id: 1,
            signer,
        }
    }

    // ---------------------------------------------------------------- owner API

    /// Registers the calling account as a Keyring owner.
    ///
    /// The owner is always `predecessor_account_id()`. There is no parameter for
    /// it, so no caller can register a keyring on another account's behalf.
    pub fn register_keyring(&mut self) {
        let owner = env::predecessor_account_id();
        require!(
            !self.keyrings.contains_key(&owner),
            "keyring already registered"
        );
        self.keyrings.insert(
            owner.clone(),
            Keyring::new(owner.clone(), env::block_timestamp_ms()),
        );
        events::keyring_created(&owner);
    }

    /// Registers an agent public key with a policy. Owner only.
    pub fn register_agent(&mut self, public_key: PublicKey, label: String, policy: Policy) {
        let owner = env::predecessor_account_id();
        require!(label.len() <= MAX_LABEL_LEN, "label too long");
        require!(!label.is_empty(), "label must not be empty");
        require!(
            !self.agent_owner.contains_key(&public_key),
            "this public key is already registered as an agent"
        );

        let policy = match validate_policy(policy) {
            Ok(p) => p,
            Err(e) => env::panic_str(&format!("invalid policy: {}", e.message())),
        };

        let keyring = self.require_keyring_mut(&owner);
        require!(
            keyring.agents.len() < MAX_AGENTS_PER_KEYRING,
            "agent limit reached"
        );
        require!(
            !keyring.agents.iter().any(|a| a.label == label),
            "an agent with this label already exists"
        );

        keyring.agents.push(Agent {
            public_key: public_key.clone(),
            label: label.clone(),
            enabled: true,
            policy: policy.clone(),
            ledgers: Vec::new(),
            created_at_ms: env::block_timestamp_ms(),
            requests_made: 0,
            recent_keys: Vec::new(),
        });

        self.agent_owner.insert(public_key.clone(), owner.clone());
        events::agent_added(&owner, &public_key, &label, &policy);
    }

    /// Replaces an agent's policy. Owner only.
    pub fn set_policy(&mut self, public_key: PublicKey, policy: Policy) {
        let owner = env::predecessor_account_id();
        let policy = match validate_policy(policy) {
            Ok(p) => p,
            Err(e) => env::panic_str(&format!("invalid policy: {}", e.message())),
        };
        let keyring = self.require_keyring_mut(&owner);
        let agent = keyring
            .agent_mut(&public_key)
            .unwrap_or_else(|| env::panic_str("no such agent for this owner"));
        agent.policy = policy.clone();
        events::policy_changed(&owner, &public_key, &policy);
    }

    /// Flips an agent's kill switch. Owner only.
    pub fn set_agent_enabled(&mut self, public_key: PublicKey, enabled: bool) {
        let owner = env::predecessor_account_id();
        let keyring = self.require_keyring_mut(&owner);
        let agent = keyring
            .agent_mut(&public_key)
            .unwrap_or_else(|| env::panic_str("no such agent for this owner"));
        agent.enabled = enabled;
        events::agent_enabled_changed(&owner, &public_key, enabled);
    }

    /// Removes an agent entirely. Owner only.
    ///
    /// The spend ledger is destroyed along with the agent. Re-registering the
    /// same key therefore starts with a fresh 24h budget — see
    /// docs/security-decisions.md, which records this as an accepted owner
    /// capability rather than a bypass, since only the owner can do it and the
    /// owner can raise caps directly anyway.
    pub fn revoke_agent(&mut self, public_key: PublicKey) {
        let owner = env::predecessor_account_id();
        let keyring = self.require_keyring_mut(&owner);
        let before = keyring.agents.len();
        keyring.agents.retain(|a| a.public_key != public_key);
        require!(
            keyring.agents.len() < before,
            "no such agent for this owner"
        );
        self.agent_owner.remove(&public_key);
        events::agent_revoked(&owner, &public_key);
    }

    // ---------------------------------------------------------------- agent API

    /// Requests a transfer. Called by an agent holding a registered key.
    ///
    /// The agent is identified by `env::signer_account_pk()` — the key that
    /// actually signed the transaction — not by any parameter. An agent cannot
    /// name a different agent, and a caller without a registered key cannot act
    /// at all.
    ///
    /// Returns a [`RequestOutcome`]; a policy refusal is a normal return value.
    ///
    /// **Gate A scope:** on success this reserves budget and records the request
    /// as `Created`. Signing is not performed.
    pub fn request_transfer(
        &mut self,
        chain: Chain,
        destination: String,
        amount: U128,
        fee: U128,
        idempotency_key: String,
    ) -> PromiseOrValue<RequestOutcome> {
        require!(
            idempotency_key.len() <= MAX_IDEMPOTENCY_KEY_LEN && !idempotency_key.is_empty(),
            "idempotency_key must be 1..=64 characters"
        );

        let agent_pk = env::signer_account_pk();
        let owner = self
            .agent_owner
            .get(&agent_pk)
            .cloned()
            .unwrap_or_else(|| env::panic_str("calling key is not a registered agent"));

        let now = env::block_timestamp_ms();
        let request_id = self.next_request_id;

        // Normalising before evaluation means the allowlist comparison and the
        // stored destination are the same bytes the transaction will later be
        // built from.
        let normalized = normalize_destination(chain, &destination);

        let keyring = self
            .keyrings
            .get_mut(&owner)
            .unwrap_or_else(|| env::panic_str("owner keyring missing"));
        let agent = keyring
            .agent_mut(&agent_pk)
            .unwrap_or_else(|| env::panic_str("agent missing from owner keyring"));

        // Replay protection before anything else is recorded.
        if let Some(existing) = agent.find_idempotency(&idempotency_key) {
            return PromiseOrValue::Value(RequestOutcome::Duplicate {
                request_id: existing,
            });
        }

        // Captured before the mutable borrow ends; the derivation path is built
        // from contract state, never from a caller parameter.
        let agent_label = agent.label.clone();

        agent.prune_expired(now);

        let decision = match &normalized {
            None => Decision::Refuse(Refusal::new(
                RefusalCode::MalformedDestination,
                format!("destination is not a valid {} address", chain.as_str()),
            )),
            Some(dest) => {
                let intent = TransferIntent {
                    chain,
                    destination: dest.clone(),
                    amount: amount.0,
                    fee: fee.0,
                };
                evaluate(
                    agent.enabled,
                    &agent.policy,
                    agent.entries(chain),
                    &intent,
                    now,
                )
            }
        };

        let stored_destination = normalized.unwrap_or_else(|| destination.clone());
        agent.requests_made += 1;
        agent.remember_idempotency(idempotency_key.clone(), request_id);

        let (status, reserved, refusal) = match decision {
            Decision::Allow { reserve } => {
                // Budget is committed here, before any asynchronous signing can
                // begin. Two concurrent requests are serialised by the NEAR
                // runtime, so the second sees the first's reservation and the
                // aggregate can never exceed the cap (invariant 10).
                agent.reserve(chain, reserve, now, request_id);
                (RequestStatus::Created, reserve, None)
            }
            Decision::Refuse(r) => (RequestStatus::Refused, 0u128, Some(r)),
        };

        let evicted = keyring.push_history(request_id);

        let request = TransferRequest {
            id: request_id,
            owner: owner.clone(),
            agent_public_key: agent_pk.clone(),
            chain,
            destination: stored_destination.clone(),
            amount,
            fee,
            status: status.clone(),
            reserved: U128(reserved),
            idempotency_key,
            created_at_ms: now,
            updated_at_ms: now,
            refusal: refusal.clone(),
            signature: None,
            failure_reason: None,
            payload_hex: None,
        };

        self.requests.insert(request_id, request);
        if let Some(old) = evicted {
            self.requests.remove(&old);
        }
        self.next_request_id += 1;

        if let Some(r) = refusal {
            events::request_refused(
                request_id,
                &owner,
                &agent_pk,
                chain,
                &stored_destination,
                amount,
                fee,
                &r,
            );
            return PromiseOrValue::Value(RequestOutcome::Refused {
                request_id,
                refusal: r,
            });
        }

        events::request_created(
            request_id,
            &owner,
            &agent_pk,
            chain,
            &stored_destination,
            amount,
            fee,
            U128(reserved),
        );
        events::request_status_changed(request_id, &status);

        // The payload is derived here, from fields policy has already approved.
        // The caller contributed no bytes to it.
        let payload = signer::gate_c_commitment(
            &env::current_account_id(),
            request_id,
            chain.as_str(),
            &stored_destination,
            amount.0,
            fee.0,
        );
        let payload_hex = mpc::to_hex(&payload);
        let path = signer::derivation_path(&owner, &agent_label, chain.as_str());

        if let Some(req) = self.requests.get_mut(&request_id) {
            req.payload_hex = Some(payload_hex.clone());
        }

        match self.signer.clone() {
            SignerBackend::Mock => {
                // Completes the lifecycle synchronously so local tests cover
                // the Signed state. The stored signature is flagged mock.
                let sig = signer::mock_signature(&payload, &path);
                let stored = StoredSignature {
                    scheme: "Secp256k1".to_string(),
                    big_r: mpc::to_hex(sig[..32].try_into().expect("32 bytes")),
                    s: mpc::to_hex(sig[32..].try_into().expect("32 bytes")),
                    recovery_id: 0,
                    mock: true,
                };
                self.finish_signed(request_id, stored);
                PromiseOrValue::Value(RequestOutcome::Signed { request_id })
            }
            SignerBackend::Mpc { contract_id } => {
                self.set_status(request_id, RequestStatus::Signing);
                let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
                    "request": mpc::sign_args(path, payload_hex),
                }))
                .expect("sign args serialise");

                // The contract attaches the signer's deposit from its own
                // balance. request_transfer is not #[payable], so an agent
                // neither supplies nor influences it (CLAUDE.md section 4).
                PromiseOrValue::Promise(
                    Promise::new(contract_id)
                        .function_call(
                            mpc::SIGN_METHOD.to_string(),
                            args,
                            mpc::SIGN_DEPOSIT,
                            mpc::SIGN_GAS,
                        )
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(mpc::CALLBACK_GAS)
                                .on_signed(request_id),
                        ),
                )
            }
        }
    }

    /// Callback for the MPC signer's response.
    ///
    /// # Access control
    ///
    /// `#[private]` makes the near-sdk wrapper reject any predecessor other
    /// than this contract. That wrapper check only exists in the compiled wasm
    /// export, so an explicit `require!` is kept as well: the same guarantee,
    /// but one a unit test can actually exercise (invariant 16).
    ///
    /// # Budget on failure
    ///
    /// The reservation is **retained** when signing fails. The contract cannot
    /// establish that no usable signature was produced -- a yield that timed
    /// out locally does not prove the MPC network never assembled one -- and
    /// CLAUDE.md section 6 requires the conservative reservation in exactly
    /// that case. The consequence is that a failed signing consumes budget
    /// until the 24-hour window rolls.
    #[private]
    pub fn on_signed(
        &mut self,
        request_id: u64,
        #[callback_result] result: Result<mpc::SignatureResponse, PromiseError>,
    ) -> RequestOutcome {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "on_signed is a private callback"
        );

        match result {
            Ok(mpc::SignatureResponse::Secp256k1 {
                big_r,
                s,
                recovery_id,
            }) => {
                let stored = StoredSignature {
                    scheme: "Secp256k1".to_string(),
                    big_r: big_r.affine_point,
                    s: s.scalar,
                    recovery_id,
                    mock: false,
                };
                self.finish_signed(request_id, stored);
                RequestOutcome::Signed { request_id }
            }
            Ok(mpc::SignatureResponse::Ed25519 { .. }) => {
                // Unreachable for Keyring: requests always target the
                // secp256k1 domain. Rejected rather than stored as valid.
                let reason = "signer returned an Ed25519 signature for a secp256k1 request";
                self.finish_failed(request_id, reason.to_string());
                RequestOutcome::SigningFailed {
                    request_id,
                    reason: reason.to_string(),
                }
            }
            Err(_) => {
                let reason = "mpc signing failed or timed out";
                self.finish_failed(request_id, reason.to_string());
                RequestOutcome::SigningFailed {
                    request_id,
                    reason: reason.to_string(),
                }
            }
        }
    }

    // --------------------------------------------------------------------- views

    /// Evaluates a hypothetical transfer without touching state.
    ///
    /// This is a `&self` view: it cannot mutate state, record a request or
    /// consume budget (CLAUDE.md §6). It takes the agent key as a parameter
    /// rather than reading the signer, so it works as a plain RPC query.
    pub fn simulate_transfer(
        &self,
        owner: AccountId,
        agent_public_key: PublicKey,
        chain: Chain,
        destination: String,
        amount: U128,
        fee: U128,
    ) -> SimulationResult {
        let now = env::block_timestamp_ms();
        let keyring = self
            .keyrings
            .get(&owner)
            .unwrap_or_else(|| env::panic_str("no such keyring"));
        let Some(agent) = keyring.agent(&agent_public_key) else {
            return SimulationResult {
                allowed: false,
                refusal: Some(Refusal::new(
                    RefusalCode::AgentNotRegistered,
                    "no such agent for this owner".to_string(),
                )),
                would_reserve: None,
                spent_24h: U128(0),
                cap_24h: None,
            };
        };

        let cap_24h = agent.policy.chain_policy(chain).map(|c| c.max_per_24h);
        let spent = policy::spend_in_window(agent.entries(chain), now);

        let decision = match normalize_destination(chain, &destination) {
            None => Decision::Refuse(Refusal::new(
                RefusalCode::MalformedDestination,
                format!("destination is not a valid {} address", chain.as_str()),
            )),
            Some(dest) => {
                let intent = TransferIntent {
                    chain,
                    destination: dest,
                    amount: amount.0,
                    fee: fee.0,
                };
                evaluate(
                    agent.enabled,
                    &agent.policy,
                    agent.entries(chain),
                    &intent,
                    now,
                )
            }
        };

        match decision {
            Decision::Allow { reserve } => SimulationResult {
                allowed: true,
                refusal: None,
                would_reserve: Some(U128(reserve)),
                spent_24h: U128(spent),
                cap_24h,
            },
            Decision::Refuse(r) => SimulationResult {
                allowed: false,
                refusal: Some(r),
                would_reserve: None,
                spent_24h: U128(spent),
                cap_24h,
            },
        }
    }

    pub fn get_keyring(&self, owner: AccountId) -> Option<Keyring> {
        self.keyrings.get(&owner).cloned()
    }

    pub fn get_agent(&self, owner: AccountId, public_key: PublicKey) -> Option<Agent> {
        self.keyrings.get(&owner)?.agent(&public_key).cloned()
    }

    pub fn get_policy(&self, owner: AccountId, public_key: PublicKey) -> Option<Policy> {
        Some(
            self.keyrings
                .get(&owner)?
                .agent(&public_key)?
                .policy
                .clone(),
        )
    }

    pub fn get_request(&self, request_id: u64) -> Option<TransferRequest> {
        self.requests.get(&request_id).cloned()
    }

    /// Returns a page of an owner's recent requests, newest first.
    ///
    /// Paginated because history must never be an unbounded single response
    /// (CLAUDE.md §6). Retention is bounded by [`state::MAX_HISTORY_IDS`].
    pub fn get_history(
        &self,
        owner: AccountId,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<TransferRequest> {
        let Some(keyring) = self.keyrings.get(&owner) else {
            return Vec::new();
        };
        let limit = limit.unwrap_or(25).min(100) as usize;
        let skip = from_index.unwrap_or(0) as usize;
        keyring
            .history
            .iter()
            .rev()
            .skip(skip)
            .take(limit)
            .filter_map(|id| self.requests.get(id).cloned())
            .collect()
    }

    /// The MPC derivation path for an agent/chain pair.
    ///
    /// Exposed as a view so the SDK can derive the matching foreign-chain
    /// address off-chain. It is computed from contract state; the caller cannot
    /// influence it.
    pub fn get_derivation_path(
        &self,
        owner: AccountId,
        public_key: PublicKey,
        chain: Chain,
    ) -> Option<String> {
        let agent = self.keyrings.get(&owner)?.agent(&public_key)?;
        Some(signer::derivation_path(
            &owner,
            &agent.label,
            chain.as_str(),
        ))
    }

    pub fn get_signer_backend(&self) -> SignerBackend {
        self.signer.clone()
    }

    /// Whether this deployment signs with the mock backend.
    ///
    /// Exposed deliberately so that no demo, dashboard or report can present
    /// mock output as real MPC signing without the deployment contradicting it
    /// (CLAUDE.md §10).
    pub fn is_mock_signer(&self) -> bool {
        self.signer.is_mock()
    }

    // ------------------------------------------------------------------ internal

    /// Moves a request to a new status and emits the transition.
    fn set_status(&mut self, request_id: u64, status: RequestStatus) {
        if let Some(req) = self.requests.get_mut(&request_id) {
            req.status = status.clone();
            req.updated_at_ms = env::block_timestamp_ms();
        }
        events::request_status_changed(request_id, &status);
    }

    /// Records a signature and moves the request to `Signed`.
    ///
    /// The budget reservation made at authorisation is left untouched.
    fn finish_signed(&mut self, request_id: u64, signature: StoredSignature) {
        if let Some(req) = self.requests.get_mut(&request_id) {
            req.status = RequestStatus::Signed;
            req.signature = Some(signature);
            req.updated_at_ms = env::block_timestamp_ms();
        }
        events::request_status_changed(request_id, &RequestStatus::Signed);
    }

    /// Moves the request to `Failed`, retaining its budget reservation.
    fn finish_failed(&mut self, request_id: u64, reason: String) {
        if let Some(req) = self.requests.get_mut(&request_id) {
            req.status = RequestStatus::Failed;
            req.failure_reason = Some(reason);
            req.updated_at_ms = env::block_timestamp_ms();
        }
        events::request_status_changed(request_id, &RequestStatus::Failed);
    }

    fn require_keyring_mut(&mut self, owner: &AccountId) -> &mut Keyring {
        self.keyrings
            .get_mut(owner)
            .unwrap_or_else(|| env::panic_str("no keyring registered for this account"))
    }
}
