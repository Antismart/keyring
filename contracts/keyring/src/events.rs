//! NEP-297 structured events.
//!
//! Every policy decision and lifecycle transition is logged so that an external
//! indexer can reconstruct an agent's complete history without reading contract
//! state (CLAUDE.md §6). Events are the durable audit trail; on-contract history
//! is a bounded convenience.

use crate::policy::{Policy, Refusal};
use crate::state::RequestStatus;
use crate::types::Chain;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, AccountId, PublicKey};

const STANDARD: &str = "keyring";
const VERSION: &str = "1.0.0";

/// Emits one NEP-297 event. The `EVENT_JSON:` prefix is what makes a log line a
/// NEP-297 event rather than ordinary output.
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let payload = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

pub fn keyring_created(owner: &AccountId) {
    emit("keyring_created", json!({ "owner": owner }));
}

pub fn agent_added(owner: &AccountId, public_key: &PublicKey, label: &str, policy: &Policy) {
    emit(
        "agent_added",
        json!({ "owner": owner, "public_key": public_key, "label": label, "policy": policy }),
    );
}

pub fn agent_enabled_changed(owner: &AccountId, public_key: &PublicKey, enabled: bool) {
    emit(
        if enabled {
            "agent_enabled"
        } else {
            "agent_disabled"
        },
        json!({ "owner": owner, "public_key": public_key, "enabled": enabled }),
    );
}

pub fn agent_revoked(owner: &AccountId, public_key: &PublicKey) {
    emit(
        "agent_revoked",
        json!({ "owner": owner, "public_key": public_key }),
    );
}

pub fn policy_changed(owner: &AccountId, public_key: &PublicKey, policy: &Policy) {
    emit(
        "policy_changed",
        json!({ "owner": owner, "public_key": public_key, "policy": policy }),
    );
}

#[allow(clippy::too_many_arguments)]
pub fn request_refused(
    request_id: u64,
    owner: &AccountId,
    public_key: &PublicKey,
    chain: Chain,
    destination: &str,
    amount: U128,
    fee: U128,
    refusal: &Refusal,
) {
    emit(
        "request_refused",
        json!({
            "request_id": request_id,
            "owner": owner,
            "public_key": public_key,
            "chain": chain.as_str(),
            "destination": destination,
            "amount": amount,
            "fee": fee,
            "refusal": refusal,
        }),
    );
}

#[allow(clippy::too_many_arguments)]
pub fn request_created(
    request_id: u64,
    owner: &AccountId,
    public_key: &PublicKey,
    chain: Chain,
    destination: &str,
    amount: U128,
    fee: U128,
    reserved: U128,
) {
    emit(
        "request_created",
        json!({
            "request_id": request_id,
            "owner": owner,
            "public_key": public_key,
            "chain": chain.as_str(),
            "destination": destination,
            "amount": amount,
            "fee": fee,
            "reserved": reserved,
        }),
    );
}

pub fn request_status_changed(request_id: u64, status: &RequestStatus) {
    emit(
        "request_status_changed",
        json!({ "request_id": request_id, "status": status }),
    );
}

/// Emitted when the owner changes the keyring-wide budget.
pub fn aggregate_budget_changed(owner: &AccountId, budget: &crate::policy::AggregateBudget) {
    emit(
        "aggregate_budget_changed",
        json!({ "owner": owner, "aggregate": budget }),
    );
}

/// Emitted when the owner registers an agent's Bitcoin public key.
pub fn agent_btc_key_set(owner: &AccountId, public_key: &PublicKey, compressed_hex: &str) {
    emit(
        "agent_btc_key_set",
        json!({ "owner": owner, "public_key": public_key, "btc_pubkey": compressed_hex }),
    );
}
