//! Contract-level access control, identity and budget tests.
//!
//! These run against the real contract methods in the near-sdk test VM, so they
//! exercise `predecessor_account_id` / `signer_account_pk` identity checks that
//! the pure evaluator tests cannot reach. Covers CLAUDE.md invariants 1, 2, 3,
//! 10, 14 and the §10 access-control test list.

mod common;
use common::*;

use keyring_contract::policy::RefusalCode;
use keyring_contract::signer::SignerBackend;
use keyring_contract::state::RequestStatus;
use keyring_contract::types::Chain;
use keyring_contract::{Contract, RequestOutcome};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PublicKey};

const OWNER: &str = "owner.testnet";
const STRANGER: &str = "stranger.testnet";

/// Sets the VM context: who called, which key signed, and what time it is.
fn ctx(predecessor: &str, signer_pk: PublicKey, now_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(account("keyring.testnet"))
        .predecessor_account_id(account(predecessor))
        .signer_account_id(account(predecessor))
        .signer_account_pk(signer_pk)
        .block_timestamp(now_ms * 1_000_000); // the VM takes nanoseconds
    testing_env!(b.build());
}

/// A contract with one owner and one enabled agent (key seed 1).
fn setup() -> Contract {
    ctx(OWNER, pk(0), at_utc(12, 0));
    let mut c = Contract::new(SignerBackend::Mock);
    c.register_keyring();
    c.register_agent(pk(1), "agent-one".to_string(), evm_policy());
    c
}

fn transfer(
    c: &mut Contract,
    signer_pk: PublicKey,
    amount: u128,
    key: &str,
    now_ms: u64,
) -> RequestOutcome {
    ctx(STRANGER, signer_pk, now_ms);
    c.request_transfer(
        Chain::BaseSepolia,
        DEST_A.to_string(),
        U128(amount),
        U128(1_000),
        key.to_string(),
    )
}

fn created_id(o: &RequestOutcome) -> u64 {
    match o {
        RequestOutcome::Created { request_id, .. } => *request_id,
        other => panic!("expected Created, got {other:?}"),
    }
}

fn refusal(o: &RequestOutcome) -> RefusalCode {
    match o {
        RequestOutcome::Refused { refusal, .. } => refusal.code,
        other => panic!("expected Refused, got {other:?}"),
    }
}

// -------------------------------------------------- owner-only mutation (inv. 2)

#[test]
fn owner_can_register_an_agent() {
    let c = setup();
    let agent = c
        .get_agent(account(OWNER), pk(1))
        .expect("agent should exist");
    assert!(agent.enabled);
    assert_eq!(agent.label, "agent-one");
}

#[test]
#[should_panic(expected = "no keyring registered for this account")]
fn non_owner_cannot_register_an_agent_under_another_keyring() {
    let mut c = setup();
    ctx(STRANGER, pk(0), at_utc(12, 0));
    c.register_agent(pk(2), "intruder".to_string(), evm_policy());
}

#[test]
#[should_panic(expected = "no keyring registered for this account")]
fn non_owner_cannot_change_policy() {
    let mut c = setup();
    ctx(STRANGER, pk(0), at_utc(12, 0));
    c.set_policy(pk(1), evm_policy());
}

#[test]
#[should_panic(expected = "no keyring registered for this account")]
fn non_owner_cannot_disable_an_agent() {
    let mut c = setup();
    ctx(STRANGER, pk(0), at_utc(12, 0));
    c.set_agent_enabled(pk(1), false);
}

#[test]
#[should_panic(expected = "no keyring registered for this account")]
fn non_owner_cannot_revoke_an_agent() {
    let mut c = setup();
    ctx(STRANGER, pk(0), at_utc(12, 0));
    c.revoke_agent(pk(1));
}

#[test]
#[should_panic(expected = "no such agent for this owner")]
fn a_second_owner_cannot_touch_the_first_owners_agent() {
    // The second owner has a keyring of their own, so they clear the keyring
    // check, but must still not reach another owner's agent.
    let mut c = setup();
    ctx(STRANGER, pk(0), at_utc(12, 0));
    c.register_keyring();
    c.set_agent_enabled(pk(1), false);
}

#[test]
#[should_panic(expected = "already registered as an agent")]
fn the_same_public_key_cannot_be_registered_twice() {
    // Global key uniqueness is what keeps agent identification unambiguous.
    let mut c = setup();
    ctx(STRANGER, pk(0), at_utc(12, 0));
    c.register_keyring();
    c.register_agent(pk(1), "copycat".to_string(), evm_policy());
}

#[test]
#[should_panic(expected = "invalid policy")]
fn an_invalid_policy_is_never_stored() {
    let mut c = setup();
    ctx(OWNER, pk(0), at_utc(12, 0));
    let mut bad = evm_policy();
    bad.chains[0].allowed_destinations = vec!["nonsense".to_string()];
    c.set_policy(pk(1), bad);
}

// ----------------------------------------------- agent identity (inv. 1 and 3)

#[test]
#[should_panic(expected = "calling key is not a registered agent")]
fn an_unregistered_key_cannot_request_a_transfer() {
    let mut c = setup();
    transfer(&mut c, pk(99), 1, "k1", at_utc(12, 0));
}

#[test]
fn a_registered_agent_key_can_request_a_transfer() {
    let mut c = setup();
    let out = transfer(&mut c, pk(1), ONE_ETH / 2, "k1", at_utc(12, 0));
    let id = created_id(&out);
    let req = c.get_request(id).expect("request should be recorded");
    assert_eq!(req.status, RequestStatus::Created);
    assert_eq!(req.reserved, U128(ONE_ETH / 2));
    assert_eq!(req.destination, DEST_A);
    // The agent's own key is recorded, not the calling account.
    assert_eq!(req.agent_public_key, pk(1));
}

#[test]
fn a_disabled_agent_cannot_obtain_a_new_request() {
    let mut c = setup();
    ctx(OWNER, pk(0), at_utc(12, 0));
    c.set_agent_enabled(pk(1), false);

    let out = transfer(&mut c, pk(1), 1, "k1", at_utc(12, 0));
    assert_eq!(refusal(&out), RefusalCode::AgentDisabled);
    // No budget may be reserved by a refused request.
    let req = c.get_request(1).expect("refusal is recorded for audit");
    assert_eq!(req.reserved, U128(0));
    assert_eq!(req.status, RequestStatus::Refused);
}

#[test]
#[should_panic(expected = "calling key is not a registered agent")]
fn a_revoked_agent_cannot_request_a_transfer() {
    let mut c = setup();
    ctx(OWNER, pk(0), at_utc(12, 0));
    c.revoke_agent(pk(1));
    transfer(&mut c, pk(1), 1, "k1", at_utc(12, 0));
}

#[test]
fn re_enabling_an_agent_restores_its_ability_to_transact() {
    let mut c = setup();
    ctx(OWNER, pk(0), at_utc(12, 0));
    c.set_agent_enabled(pk(1), false);
    assert_eq!(
        refusal(&transfer(&mut c, pk(1), 1, "k1", at_utc(12, 0))),
        RefusalCode::AgentDisabled
    );

    ctx(OWNER, pk(0), at_utc(12, 0));
    c.set_agent_enabled(pk(1), true);
    created_id(&transfer(&mut c, pk(1), 1, "k2", at_utc(12, 0)));
}

// ------------------------------------------------------- idempotency (inv. 14)

#[test]
fn a_repeated_idempotency_key_does_not_create_a_second_request() {
    let mut c = setup();
    let first = created_id(&transfer(
        &mut c,
        pk(1),
        ONE_ETH / 2,
        "same-key",
        at_utc(12, 0),
    ));

    let again = transfer(&mut c, pk(1), ONE_ETH / 2, "same-key", at_utc(12, 1));
    match again {
        RequestOutcome::Duplicate { request_id } => assert_eq!(request_id, first),
        other => panic!("expected Duplicate, got {other:?}"),
    }

    // Critically, the replay must not have reserved budget a second time.
    let agent = c.get_agent(account(OWNER), pk(1)).unwrap();
    let total: u128 = agent
        .ledgers
        .iter()
        .flat_map(|l| &l.entries)
        .map(|e| e.amount.0)
        .sum();
    assert_eq!(
        total,
        ONE_ETH / 2,
        "a duplicate must not double-reserve budget"
    );
}

#[test]
#[should_panic(expected = "idempotency_key must be")]
fn an_empty_idempotency_key_is_rejected() {
    let mut c = setup();
    transfer(&mut c, pk(1), 1, "", at_utc(12, 0));
}

// --------------------------------------------- aggregate budget safety (inv. 10)

#[test]
fn successive_requests_cannot_exceed_the_rolling_cap_in_aggregate() {
    let mut c = setup();
    // Cap is 2 ETH per 24h, 1 ETH per request.
    created_id(&transfer(&mut c, pk(1), ONE_ETH, "a", at_utc(12, 0)));
    created_id(&transfer(&mut c, pk(1), ONE_ETH, "b", at_utc(12, 1)));

    // The third request sees both reservations and must be refused.
    let third = transfer(&mut c, pk(1), 1, "c", at_utc(12, 2));
    assert_eq!(refusal(&third), RefusalCode::DailyCapExceeded);

    let agent = c.get_agent(account(OWNER), pk(1)).unwrap();
    let total: u128 = agent
        .ledgers
        .iter()
        .flat_map(|l| &l.entries)
        .map(|e| e.amount.0)
        .sum();
    assert_eq!(
        total,
        2 * ONE_ETH,
        "reserved total must never exceed the 24h cap"
    );
}

#[test]
fn budget_is_reserved_at_authorisation_not_after_signing() {
    // Gate A does not sign at all, so the request stays Created. The budget must
    // already be committed at that point: a signature that is produced but never
    // broadcast must not be refundable (invariant 13).
    let mut c = setup();
    created_id(&transfer(&mut c, pk(1), ONE_ETH, "a", at_utc(12, 0)));
    let req = c.get_request(1).unwrap();
    assert_eq!(req.status, RequestStatus::Created);
    assert_eq!(req.reserved, U128(ONE_ETH));
}

#[test]
fn spend_ages_out_of_the_rolling_window() {
    let mut c = setup();
    created_id(&transfer(&mut c, pk(1), ONE_ETH, "a", at_utc(12, 0)));
    created_id(&transfer(&mut c, pk(1), ONE_ETH, "b", at_utc(12, 1)));
    assert_eq!(
        refusal(&transfer(&mut c, pk(1), 1, "c", at_utc(12, 2))),
        RefusalCode::DailyCapExceeded
    );

    // 25 hours later the earlier spends have expired.
    let next_day = at_utc(12, 0) + 25 * 3_600_000;
    created_id(&transfer(&mut c, pk(1), ONE_ETH, "d", next_day));
}

// ------------------------------------------------------- views do not mutate

#[test]
fn simulate_transfer_does_not_consume_budget() {
    let c = setup();
    let before = c.get_agent(account(OWNER), pk(1)).unwrap();

    for _ in 0..5 {
        let sim = c.simulate_transfer(
            account(OWNER),
            pk(1),
            Chain::BaseSepolia,
            DEST_A.to_string(),
            U128(ONE_ETH),
            U128(1_000),
        );
        assert!(sim.allowed);
        assert_eq!(sim.would_reserve, Some(U128(ONE_ETH)));
        assert_eq!(sim.spent_24h, U128(0));
        assert_eq!(sim.cap_24h, Some(U128(2 * ONE_ETH)));
    }

    let after = c.get_agent(account(OWNER), pk(1)).unwrap();
    assert_eq!(before, after, "a view must not mutate agent state");
}

#[test]
fn simulate_transfer_reports_the_refusal_a_real_request_would_get() {
    let c = setup();
    let sim = c.simulate_transfer(
        account(OWNER),
        pk(1),
        Chain::BaseSepolia,
        DEST_EVIL.to_string(),
        U128(1),
        U128(1),
    );
    assert!(!sim.allowed);
    assert_eq!(
        sim.refusal.unwrap().code,
        RefusalCode::DestinationNotAllowed
    );
}

#[test]
fn simulate_reports_unregistered_agents_without_panicking() {
    let c = setup();
    let sim = c.simulate_transfer(
        account(OWNER),
        pk(77),
        Chain::BaseSepolia,
        DEST_A.to_string(),
        U128(1),
        U128(1),
    );
    assert!(!sim.allowed);
    assert_eq!(sim.refusal.unwrap().code, RefusalCode::AgentNotRegistered);
}

// ------------------------------------------------------------------- history

#[test]
fn history_returns_newest_first_and_respects_its_limit() {
    let mut c = setup();
    for i in 0..5u8 {
        transfer(&mut c, pk(1), 1, &format!("k{i}"), at_utc(12, u64::from(i)));
    }
    let page = c.get_history(account(OWNER), None, Some(2));
    assert_eq!(page.len(), 2);
    assert!(page[0].id > page[1].id, "newest request must come first");

    let all = c.get_history(account(OWNER), None, None);
    assert_eq!(all.len(), 5);

    let skipped = c.get_history(account(OWNER), Some(4), Some(10));
    assert_eq!(skipped.len(), 1, "paging past the end must not panic");
}

#[test]
fn history_of_an_unknown_owner_is_empty_rather_than_an_error() {
    let c = setup();
    assert!(c
        .get_history(account("nobody.testnet"), None, None)
        .is_empty());
}

// -------------------------------------------------------------- signer wiring

#[test]
fn the_mock_signer_is_advertised_as_mock() {
    // A demo or dashboard must be able to tell that signing is not real.
    let c = setup();
    assert!(c.is_mock_signer());
    assert_eq!(c.get_signer_backend(), SignerBackend::Mock);
}

#[test]
fn the_derivation_path_is_derived_from_contract_state() {
    let c = setup();
    let path = c
        .get_derivation_path(account(OWNER), pk(1), Chain::BaseSepolia)
        .expect("path for a registered agent");
    assert_eq!(path, "keyring-v1,owner.testnet,agent-one,base-sepolia");

    // Two agents under one owner must never share a path.
    let other: Option<String> = c.get_derivation_path(account(OWNER), pk(2), Chain::BaseSepolia);
    assert!(other.is_none(), "unregistered agent has no path");
}

#[test]
fn an_agents_path_differs_per_chain() {
    let mut c = setup();
    ctx(OWNER, pk(0), at_utc(12, 0));
    let mut p = evm_policy();
    p.chains.push(keyring_contract::policy::ChainPolicy {
        chain: Chain::BitcoinTestnet4,
        max_per_request: U128(100_000),
        max_per_24h: U128(200_000),
        max_fee: U128(5_000),
        allowed_destinations: vec!["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".to_string()],
    });
    c.set_policy(pk(1), p);

    let evm = c
        .get_derivation_path(account(OWNER), pk(1), Chain::BaseSepolia)
        .unwrap();
    let btc = c
        .get_derivation_path(account(OWNER), pk(1), Chain::BitcoinTestnet4)
        .unwrap();
    assert_ne!(evm, btc);
}

// --------------------------------------------------------- keyring registration

#[test]
#[should_panic(expected = "keyring already registered")]
fn a_keyring_cannot_be_registered_twice() {
    let mut c = setup();
    ctx(OWNER, pk(0), at_utc(12, 0));
    c.register_keyring();
}

#[test]
fn an_owner_id_cannot_be_spoofed_by_a_parameter() {
    // register_keyring takes no owner parameter at all; the owner is always the
    // predecessor. This test documents that property as a regression guard.
    ctx(STRANGER, pk(0), at_utc(12, 0));
    let mut c = Contract::new(SignerBackend::Mock);
    c.register_keyring();
    let k = c
        .get_keyring(account(STRANGER))
        .expect("keyring for the caller");
    assert_eq!(k.owner, account(STRANGER));
    assert!(c.get_keyring(account(OWNER)).is_none());
}
