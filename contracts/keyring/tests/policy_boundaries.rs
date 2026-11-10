//! Policy evaluator boundary tests (CLAUDE.md §10, Gate B).
//!
//! Every numeric rule is tested exactly at its cap and exactly one base unit
//! above it. These tests call the pure evaluator directly, so they exercise the
//! real enforcement logic with no VM, no mocks and no network.

mod common;
use common::*;

use keyring_contract::policy::{
    evaluate, is_expired, spend_in_window, validate_aggregate, validate_policy, AssetPolicy,
    ChainPolicy, Decision, Evaluation, Policy, PolicyError, RefusalCode, SpendEntry, TimeWindow,
    MAX_OWNER_SPEND_ENTRIES, MAX_SPEND_ENTRIES, ROLLING_WINDOW_MS,
};
use keyring_contract::types::{normalize_destination, Asset, Chain};
use near_sdk::json_types::U128;

fn intent(amount: u128, fee: u128) -> keyring_contract::policy::TransferIntent {
    keyring_contract::policy::TransferIntent {
        chain: Chain::BaseSepolia,
        asset: Asset::Native,
        destination: DEST_A.to_string(),
        amount,
        fee,
    }
}

/// Evaluates with no owner-wide cap, which is the default for a keyring.
///
/// Keeps the per-agent boundary tests readable: the owner-wide rule has its own
/// section below, where the cap is set explicitly.
fn ev(
    enabled: bool,
    policy: &Policy,
    entries: &[SpendEntry],
    intent: &keyring_contract::policy::TransferIntent,
    now: u64,
) -> Decision {
    evaluate(&Evaluation {
        enabled,
        policy,
        agent_entries: entries,
        owner_cap: None,
        owner_entries: &[],
        intent,
        now_ms: now,
    })
}

fn refusal_code(d: &Decision) -> RefusalCode {
    match d {
        Decision::Refuse(r) => r.code,
        Decision::Allow { .. } => panic!("expected a refusal, got Allow"),
    }
}

// ---------------------------------------------------------------- kill switch

#[test]
fn disabled_agent_is_refused() {
    let d = ev(false, &evm_policy(), &[], &intent(1, 1), at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::AgentDisabled);
}

#[test]
fn disabled_takes_precedence_over_every_other_rule() {
    // A request that violates chain, destination, amount and fee as well must
    // still report the kill switch, because evaluation order is fixed.
    let bad = keyring_contract::policy::TransferIntent {
        chain: Chain::BitcoinTestnet4,
        asset: Asset::Native,
        destination: DEST_EVIL.to_string(),
        amount: u128::MAX,
        fee: u128::MAX,
    };
    let d = ev(false, &evm_policy(), &[], &bad, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::AgentDisabled);
}

// ------------------------------------------------------------ chain allowlist

#[test]
fn chain_absent_from_policy_is_refused() {
    let btc = keyring_contract::policy::TransferIntent {
        chain: Chain::BitcoinTestnet4,
        asset: Asset::Native,
        destination: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".to_string(),
        amount: 1_000,
        fee: 100,
    };
    let d = ev(true, &evm_policy(), &[], &btc, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::ChainNotAllowed);
}

#[test]
fn chain_check_precedes_destination_check() {
    let btc = keyring_contract::policy::TransferIntent {
        chain: Chain::BitcoinTestnet4,
        asset: Asset::Native,
        destination: DEST_EVIL.to_string(),
        amount: 1,
        fee: 1,
    };
    let d = ev(true, &evm_policy(), &[], &btc, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::ChainNotAllowed);
}

// ------------------------------------------------------ destination allowlist

#[test]
fn allowlisted_destination_is_permitted() {
    let d = ev(true, &evm_policy(), &[], &intent(1, 1), at_utc(12, 0));
    assert!(matches!(d, Decision::Allow { .. }));
}

#[test]
fn non_allowlisted_destination_is_refused() {
    let mut i = intent(1, 1);
    i.destination = DEST_EVIL.to_string();
    let d = ev(true, &evm_policy(), &[], &i, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::DestinationNotAllowed);
}

#[test]
fn empty_allowlist_permits_nobody() {
    // An empty destination list must never be read as "any destination".
    let mut p = evm_policy();
    p.chains[0].assets[0].allowed_destinations.clear();
    let d = ev(true, &p, &[], &intent(1, 1), at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::DestinationNotAllowed);
}

#[test]
fn evm_destination_comparison_is_case_insensitive() {
    // An allowlist bypass via mixed-case hex would be a fund-redirection bug.
    let upper = DEST_A.to_ascii_uppercase().replace("0X", "0x");
    let canon = normalize_destination(Chain::BaseSepolia, &upper).expect("valid address");
    assert_eq!(canon, DEST_A);
}

// ----------------------------------------------------------- per-request cap

#[test]
fn amount_exactly_at_per_request_cap_is_allowed() {
    let d = ev(true, &evm_policy(), &[], &intent(ONE_ETH, 0), at_utc(12, 0));
    assert!(matches!(d, Decision::Allow { reserve } if reserve == ONE_ETH));
}

#[test]
fn amount_one_base_unit_over_per_request_cap_is_refused() {
    let d = ev(
        true,
        &evm_policy(),
        &[],
        &intent(ONE_ETH + 1, 0),
        at_utc(12, 0),
    );
    match d {
        Decision::Refuse(r) => {
            assert_eq!(r.code, RefusalCode::PerRequestCapExceeded);
            assert_eq!(r.rule, "per_request_cap");
            assert_eq!(r.limit, Some(U128(ONE_ETH)));
            assert_eq!(r.observed, Some(U128(ONE_ETH + 1)));
        }
        Decision::Allow { .. } => panic!("cap + 1 must be refused"),
    }
}

#[test]
fn zero_amount_is_refused() {
    let d = ev(true, &evm_policy(), &[], &intent(0, 0), at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::AmountZero);
}

// ------------------------------------------------------------------- fee cap

#[test]
fn fee_exactly_at_cap_is_allowed() {
    let d = ev(
        true,
        &evm_policy(),
        &[],
        &intent(1, ONE_ETH / 100),
        at_utc(12, 0),
    );
    assert!(matches!(d, Decision::Allow { .. }));
}

#[test]
fn fee_one_base_unit_over_cap_is_refused() {
    let d = ev(
        true,
        &evm_policy(),
        &[],
        &intent(1, ONE_ETH / 100 + 1),
        at_utc(12, 0),
    );
    match d {
        Decision::Refuse(r) => {
            assert_eq!(r.code, RefusalCode::FeeCapExceeded);
            assert_eq!(r.limit, Some(U128(ONE_ETH / 100)));
            assert_eq!(r.observed, Some(U128(ONE_ETH / 100 + 1)));
        }
        Decision::Allow { .. } => panic!("fee cap + 1 must be refused"),
    }
}

#[test]
fn per_request_cap_is_checked_before_fee_cap() {
    // Both violated: the narrower rule must win, deterministically.
    let d = ev(
        true,
        &evm_policy(),
        &[],
        &intent(ONE_ETH + 1, ONE_ETH),
        at_utc(12, 0),
    );
    assert_eq!(refusal_code(&d), RefusalCode::PerRequestCapExceeded);
}

// ------------------------------------------------------- rolling 24-hour cap

fn entry(at_ms: u64, amount: u128) -> SpendEntry {
    SpendEntry {
        at_ms,
        amount: U128(amount),
        request_id: 1,
    }
}

#[test]
fn spend_exactly_reaching_daily_cap_is_allowed() {
    let now = at_utc(12, 0);
    let ledger = vec![entry(now - 1_000, ONE_ETH)];
    // 1 ETH already spent, cap is 2 ETH, this request is exactly 1 ETH.
    let d = ev(true, &evm_policy(), &ledger, &intent(ONE_ETH, 0), now);
    assert!(matches!(d, Decision::Allow { .. }));
}

#[test]
fn spend_one_base_unit_over_daily_cap_is_refused() {
    let now = at_utc(12, 0);
    let ledger = vec![entry(now - 1_000, ONE_ETH)];
    let d = ev(true, &evm_policy(), &ledger, &intent(ONE_ETH + 1, 0), now);
    // cap+1 on a single request trips the per-request rule first, so to isolate
    // the daily rule we raise the per-request cap to the daily cap.
    assert_eq!(refusal_code(&d), RefusalCode::PerRequestCapExceeded);

    let mut p = evm_policy();
    p.chains[0].assets[0].max_per_request = U128(2 * ONE_ETH);
    let d = ev(true, &p, &ledger, &intent(ONE_ETH + 1, 0), now);
    match d {
        Decision::Refuse(r) => {
            assert_eq!(r.code, RefusalCode::DailyCapExceeded);
            assert_eq!(r.limit, Some(U128(2 * ONE_ETH)));
            assert_eq!(r.observed, Some(U128(2 * ONE_ETH + 1)));
        }
        Decision::Allow { .. } => panic!("exceeding the daily cap must be refused"),
    }
}

#[test]
fn daily_cap_accumulates_across_several_requests() {
    let now = at_utc(12, 0);
    let half = ONE_ETH / 2;
    // Four half-ETH spends reach the 2 ETH cap exactly.
    let ledger: Vec<SpendEntry> = (0..4).map(|i| entry(now - (i + 1) * 1_000, half)).collect();
    assert_eq!(spend_in_window(&ledger, now), 2 * ONE_ETH);
    // A fifth of any size must now be refused.
    let d = ev(true, &evm_policy(), &ledger, &intent(1, 0), now);
    assert_eq!(refusal_code(&d), RefusalCode::DailyCapExceeded);
}

#[test]
fn entry_exactly_at_window_edge_has_expired() {
    let now = at_utc(12, 0);
    // The window is half-open: an entry exactly ROLLING_WINDOW_MS old is out.
    let edge = entry(now - ROLLING_WINDOW_MS, ONE_ETH);
    assert!(is_expired(&edge, now));
    assert_eq!(spend_in_window(&[edge], now), 0);

    // One millisecond newer is still inside the window.
    let inside = entry(now - ROLLING_WINDOW_MS + 1, ONE_ETH);
    assert!(!is_expired(&inside, now));
    assert_eq!(spend_in_window(&[inside], now), ONE_ETH);
}

#[test]
fn budget_frees_up_once_old_spend_ages_out() {
    let t0 = at_utc(0, 0);
    let ledger = vec![entry(t0, 2 * ONE_ETH)];
    // At the cap, nothing more is allowed.
    assert_eq!(
        refusal_code(&ev(true, &evm_policy(), &ledger, &intent(1, 0), t0 + 1_000)),
        RefusalCode::DailyCapExceeded
    );
    // Just past 24 hours, the old spend no longer counts.
    let later = t0 + ROLLING_WINDOW_MS + 1;
    assert!(matches!(
        ev(true, &evm_policy(), &ledger, &intent(ONE_ETH, 0), later),
        Decision::Allow { .. }
    ));
}

#[test]
fn full_spend_ledger_refuses_rather_than_evicting() {
    let now = at_utc(12, 0);
    // A full ledger of live, tiny entries. Evicting one to make room would
    // under-count spend, so the contract must refuse instead.
    let ledger: Vec<SpendEntry> = (0..MAX_SPEND_ENTRIES as u64)
        .map(|i| entry(now - i - 1, 1))
        .collect();
    let d = ev(true, &evm_policy(), &ledger, &intent(1, 0), now);
    assert_eq!(refusal_code(&d), RefusalCode::BudgetLedgerFull);
}

// --------------------------------------------------------------- time window

#[test]
fn time_window_start_is_inclusive_and_end_is_exclusive() {
    // 09:00 (540) .. 17:00 (1020)
    let p = evm_policy_windowed(TimeWindow {
        start_minute: 540,
        end_minute: 1020,
    });

    assert!(matches!(
        ev(true, &p, &[], &intent(1, 0), at_utc(9, 0)),
        Decision::Allow { .. }
    ));
    assert!(matches!(
        ev(true, &p, &[], &intent(1, 0), at_utc(16, 59)),
        Decision::Allow { .. }
    ));
    assert_eq!(
        refusal_code(&ev(true, &p, &[], &intent(1, 0), at_utc(17, 0))),
        RefusalCode::OutsideTimeWindow
    );
    assert_eq!(
        refusal_code(&ev(true, &p, &[], &intent(1, 0), at_utc(8, 59))),
        RefusalCode::OutsideTimeWindow
    );
}

#[test]
fn overnight_time_window_wraps_midnight() {
    // 22:00 (1320) .. 06:00 (360)
    let p = evm_policy_windowed(TimeWindow {
        start_minute: 1320,
        end_minute: 360,
    });

    for (h, m) in [(22, 0), (23, 59), (0, 0), (5, 59)] {
        assert!(
            matches!(
                ev(true, &p, &[], &intent(1, 0), at_utc(h, m)),
                Decision::Allow { .. }
            ),
            "{h:02}:{m:02} should be inside an overnight window"
        );
    }
    for (h, m) in [(6, 0), (12, 0), (21, 59)] {
        assert_eq!(
            refusal_code(&ev(true, &p, &[], &intent(1, 0), at_utc(h, m))),
            RefusalCode::OutsideTimeWindow,
            "{h:02}:{m:02} should be outside an overnight window"
        );
    }
}

#[test]
fn time_window_is_checked_before_numeric_caps() {
    let p = evm_policy_windowed(TimeWindow {
        start_minute: 540,
        end_minute: 1020,
    });
    let d = ev(true, &p, &[], &intent(u128::MAX, u128::MAX), at_utc(3, 0));
    assert_eq!(refusal_code(&d), RefusalCode::OutsideTimeWindow);
}

// --------------------------------------------------------- policy validation

#[test]
fn policy_destinations_are_normalized_on_store() {
    let mut p = evm_policy();
    p.chains[0].assets[0].allowed_destinations =
        vec![DEST_A.to_ascii_uppercase().replace("0X", "0x")];
    let stored = validate_policy(p).expect("policy should be valid");
    assert_eq!(
        stored.chains[0].assets[0].allowed_destinations,
        vec![DEST_A.to_string()]
    );
}

#[test]
fn policy_rejects_malformed_destination() {
    let mut p = evm_policy();
    p.chains[0].assets[0].allowed_destinations = vec!["not-an-address".to_string()];
    assert!(matches!(
        validate_policy(p),
        Err(PolicyError::InvalidDestination(_))
    ));
}

#[test]
fn policy_rejects_per_request_cap_above_daily_cap() {
    let mut p = evm_policy();
    p.chains[0].assets[0].max_per_request = U128(3 * ONE_ETH);
    assert_eq!(
        validate_policy(p),
        Err(PolicyError::PerRequestCapAboveDailyCap)
    );
}

#[test]
fn policy_rejects_zero_caps_and_duplicate_chains() {
    let mut p = evm_policy();
    p.chains[0].assets[0].max_per_request = U128(0);
    assert_eq!(validate_policy(p), Err(PolicyError::ZeroCap));

    let dup = Policy {
        chains: vec![
            ChainPolicy {
                chain: Chain::BaseSepolia,
                max_fee: U128(1),
                assets: vec![],
            },
            ChainPolicy {
                chain: Chain::BaseSepolia,
                max_fee: U128(1),
                assets: vec![],
            },
        ],
        time_window: None,
    };
    assert_eq!(validate_policy(dup), Err(PolicyError::DuplicateChain));
}

#[test]
fn policy_rejects_ambiguous_and_out_of_range_time_windows() {
    // start == end is ambiguous (always, or never?) and must be rejected.
    let p = evm_policy_windowed(TimeWindow {
        start_minute: 600,
        end_minute: 600,
    });
    assert_eq!(validate_policy(p), Err(PolicyError::InvalidTimeWindow));

    let p = evm_policy_windowed(TimeWindow {
        start_minute: 0,
        end_minute: 1440,
    });
    assert_eq!(validate_policy(p), Err(PolicyError::InvalidTimeWindow));
}

// ------------------------------------------------------ address normalisation

#[test]
fn evm_address_validation_rejects_wrong_shapes() {
    let c = Chain::BaseSepolia;
    assert!(normalize_destination(c, DEST_A).is_some());
    assert!(normalize_destination(c, "0x111").is_none(), "too short");
    assert!(
        normalize_destination(c, &format!("{DEST_A}00")).is_none(),
        "too long"
    );
    assert!(
        normalize_destination(c, &DEST_A[2..]).is_none(),
        "missing 0x prefix"
    );
    assert!(
        normalize_destination(c, "0x111111111111111111111111111111111111111g").is_none(),
        "non-hex character"
    );
    assert!(normalize_destination(c, "").is_none(), "empty");
}

#[test]
fn bitcoin_bech32_is_lowercased_but_base58_is_preserved() {
    let c = Chain::BitcoinTestnet4;
    let bech32 = "TB1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KXPJZSX";
    assert_eq!(
        normalize_destination(c, bech32),
        Some(bech32.to_ascii_lowercase())
    );

    // Base58 is case-sensitive; altering case would change the address.
    let base58 = "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn";
    assert_eq!(normalize_destination(c, base58), Some(base58.to_string()));
}

// ---------------------------------------------------------- asset allowlist

fn token_intent(amount: u128, fee: u128) -> keyring_contract::policy::TransferIntent {
    keyring_contract::policy::TransferIntent {
        chain: Chain::BaseSepolia,
        asset: Asset::Erc20 {
            token: TOKEN.to_string(),
        },
        destination: DEST_A.to_string(),
        amount,
        fee,
    }
}

#[test]
fn an_asset_absent_from_policy_is_refused() {
    // A native-only policy must not permit token transfers.
    let d = ev(true, &evm_policy(), &[], &token_intent(1, 0), at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::AssetNotAllowed);
}

#[test]
fn permission_for_one_token_is_not_permission_for_another() {
    let mut i = token_intent(1, 0);
    i.asset = Asset::Erc20 {
        token: TOKEN_OTHER.to_string(),
    };
    let d = ev(true, &evm_policy_with_token(), &[], &i, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::AssetNotAllowed);
}

#[test]
fn permission_to_move_a_token_is_not_permission_to_send_native_value() {
    // The reverse direction matters just as much: an agent allowed to move
    // USDC must not thereby be able to send ETH.
    let mut p = evm_policy_with_token();
    p.chains[0].assets.retain(|a| a.asset != Asset::Native);
    let d = ev(true, &p, &[], &intent(1, 0), at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::AssetNotAllowed);
}

#[test]
fn an_allowed_token_transfer_is_permitted() {
    let d = ev(
        true,
        &evm_policy_with_token(),
        &[],
        &token_intent(ONE_USDC, 0),
        at_utc(12, 0),
    );
    assert!(matches!(d, Decision::Allow { reserve } if reserve == ONE_USDC));
}

#[test]
fn chain_is_checked_before_asset() {
    let mut i = token_intent(1, 0);
    i.chain = Chain::BitcoinTestnet4;
    let d = ev(true, &evm_policy_with_token(), &[], &i, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::ChainNotAllowed);
}

#[test]
fn asset_is_checked_before_destination() {
    let mut i = token_intent(1, 0);
    i.destination = DEST_EVIL.to_string();
    // The asset is not allowed at all, so that is what must be reported.
    let d = ev(true, &evm_policy(), &[], &i, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::AssetNotAllowed);
}

#[test]
fn each_asset_has_its_own_destination_allowlist() {
    // DEST_B is allowlisted for native ETH but not for the token.
    let mut i = token_intent(1, 0);
    i.destination = DEST_B.to_string();
    let d = ev(true, &evm_policy_with_token(), &[], &i, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::DestinationNotAllowed);
}

#[test]
fn token_caps_are_independent_of_native_caps() {
    // 100 tokens is the token per-request cap; it is nowhere near the 1 ETH
    // native cap, and the two must not be compared.
    let p = evm_policy_with_token();
    assert!(matches!(
        ev(
            true,
            &p,
            &[],
            &token_intent(100 * ONE_USDC, 0),
            at_utc(12, 0)
        ),
        Decision::Allow { .. }
    ));
    assert_eq!(
        refusal_code(&ev(
            true,
            &p,
            &[],
            &token_intent(100 * ONE_USDC + 1, 0),
            at_utc(12, 0)
        )),
        RefusalCode::PerRequestCapExceeded
    );
}

#[test]
fn a_token_fee_is_still_checked_in_native_units() {
    // Fees are always paid in the chain's native coin, whatever is being
    // transferred, so the fee cap is the native one.
    let p = evm_policy_with_token();
    let over_fee = ONE_ETH / 100 + 1;
    let d = ev(
        true,
        &p,
        &[],
        &token_intent(ONE_USDC, over_fee),
        at_utc(12, 0),
    );
    match d {
        Decision::Refuse(r) => {
            assert_eq!(r.code, RefusalCode::FeeCapExceeded);
            assert_eq!(r.limit, Some(U128(ONE_ETH / 100)));
        }
        Decision::Allow { .. } => panic!("fee above the native cap must be refused"),
    }
}

// ----------------------------------------------------- owner-wide 24h cap

fn ev_owner(
    policy: &Policy,
    agent_entries: &[SpendEntry],
    owner_cap: u128,
    owner_entries: &[SpendEntry],
    intent: &keyring_contract::policy::TransferIntent,
    now: u64,
) -> Decision {
    evaluate(&Evaluation {
        enabled: true,
        policy,
        agent_entries,
        owner_cap: Some(owner_cap),
        owner_entries,
        intent,
        now_ms: now,
    })
}

#[test]
fn spend_exactly_reaching_the_owner_cap_is_allowed() {
    let now = at_utc(12, 0);
    let others = vec![entry(now - 1_000, ONE_ETH)];
    // 1 ETH already spent by other agents, owner cap 2 ETH, this request 1 ETH.
    let d = ev_owner(
        &evm_policy(),
        &[],
        2 * ONE_ETH,
        &others,
        &intent(ONE_ETH, 0),
        now,
    );
    assert!(matches!(d, Decision::Allow { .. }));
}

#[test]
fn one_base_unit_over_the_owner_cap_is_refused() {
    let now = at_utc(12, 0);
    let others = vec![entry(now - 1_000, ONE_ETH)];
    let mut p = evm_policy();
    // Raise the agent's own caps so the owner rule is the one that binds.
    p.chains[0].assets[0].max_per_request = U128(2 * ONE_ETH);
    p.chains[0].assets[0].max_per_24h = U128(4 * ONE_ETH);

    let d = ev_owner(&p, &[], 2 * ONE_ETH, &others, &intent(ONE_ETH + 1, 0), now);
    match d {
        Decision::Refuse(r) => {
            assert_eq!(r.code, RefusalCode::OwnerDailyCapExceeded);
            assert_eq!(r.rule, "owner_rolling_24h_cap");
            assert_eq!(r.limit, Some(U128(2 * ONE_ETH)));
            assert_eq!(r.observed, Some(U128(2 * ONE_ETH + 1)));
        }
        Decision::Allow { .. } => panic!("exceeding the owner-wide cap must be refused"),
    }
}

#[test]
fn the_owner_cap_counts_spending_this_agent_never_did() {
    // The whole point: an agent with an empty ledger of its own can still be
    // refused because of what other agents have spent.
    let now = at_utc(12, 0);
    let others = vec![entry(now - 1_000, 2 * ONE_ETH)];
    let d = ev_owner(&evm_policy(), &[], 2 * ONE_ETH, &others, &intent(1, 0), now);
    assert_eq!(refusal_code(&d), RefusalCode::OwnerDailyCapExceeded);
}

#[test]
fn owner_entries_expire_on_the_same_half_open_window() {
    let now = at_utc(12, 0);
    let edge = vec![entry(now - ROLLING_WINDOW_MS, 2 * ONE_ETH)];
    // Exactly 24h old: expired, so it does not count against the owner cap.
    assert!(matches!(
        ev_owner(
            &evm_policy(),
            &[],
            2 * ONE_ETH,
            &edge,
            &intent(ONE_ETH, 0),
            now
        ),
        Decision::Allow { .. }
    ));
    let inside = vec![entry(now - ROLLING_WINDOW_MS + 1, 2 * ONE_ETH)];
    assert_eq!(
        refusal_code(&ev_owner(
            &evm_policy(),
            &[],
            2 * ONE_ETH,
            &inside,
            &intent(1, 0),
            now
        )),
        RefusalCode::OwnerDailyCapExceeded
    );
}

#[test]
fn a_full_owner_ledger_refuses_rather_than_evicting() {
    let now = at_utc(12, 0);
    let full: Vec<SpendEntry> = (0..MAX_OWNER_SPEND_ENTRIES as u64)
        .map(|i| entry(now - i - 1, 1))
        .collect();
    let d = ev_owner(&evm_policy(), &[], 2 * ONE_ETH, &full, &intent(1, 0), now);
    assert_eq!(refusal_code(&d), RefusalCode::OwnerBudgetLedgerFull);
}

#[test]
fn the_owner_ledger_is_larger_than_an_agents() {
    // Every agent's authorised spend appends here, so it must hold more.
    const { assert!(MAX_OWNER_SPEND_ENTRIES > MAX_SPEND_ENTRIES) };
}

// ------------------------------------------- validation of the new shapes

#[test]
fn policy_rejects_a_duplicate_asset_on_one_chain() {
    let mut p = evm_policy_with_token();
    let dup = p.chains[0].assets[1].clone();
    p.chains[0].assets.push(dup);
    assert_eq!(validate_policy(p), Err(PolicyError::DuplicateAsset));
}

#[test]
fn policy_rejects_a_token_on_a_chain_that_cannot_have_one() {
    let p = Policy {
        chains: vec![ChainPolicy {
            chain: Chain::BitcoinTestnet4,
            max_fee: U128(1_000),
            assets: vec![AssetPolicy {
                asset: Asset::Erc20 {
                    token: TOKEN.to_string(),
                },
                max_per_request: U128(1),
                max_per_24h: U128(1),
                allowed_destinations: vec![],
            }],
        }],
        time_window: None,
    };
    assert_eq!(validate_policy(p), Err(PolicyError::AssetNotValidForChain));
}

#[test]
fn policy_rejects_a_malformed_token_address() {
    let mut p = evm_policy_with_token();
    p.chains[0].assets[1].asset = Asset::Erc20 {
        token: "not-an-address".to_string(),
    };
    assert!(matches!(
        validate_policy(p),
        Err(PolicyError::InvalidTokenAddress(_))
    ));
}

#[test]
fn a_token_address_is_normalised_so_case_cannot_split_an_asset() {
    // Without this, a policy for 0xAAA… would not match a request naming
    // 0xaaa…, and the agent would be refused for an asset it was granted.
    let mut p = evm_policy_with_token();
    p.chains[0].assets[1].asset = Asset::Erc20 {
        token: TOKEN.to_ascii_uppercase().replace("0X", "0x"),
    };
    let stored = validate_policy(p).expect("valid");
    assert_eq!(
        stored.chains[0].assets[1].asset,
        Asset::Erc20 {
            token: TOKEN.to_string()
        }
    );
}

#[test]
fn aggregate_validation_rejects_duplicates_zero_caps_and_bad_assets() {
    let mut b = aggregate_native(ONE_ETH);
    let dup = b.caps[0].clone();
    b.caps.push(dup);
    assert_eq!(
        validate_aggregate(b),
        Err(PolicyError::DuplicateAggregateCap)
    );

    assert_eq!(
        validate_aggregate(aggregate_native(0)),
        Err(PolicyError::ZeroCap)
    );

    let bad = keyring_contract::policy::AggregateBudget {
        caps: vec![keyring_contract::policy::AggregateCap {
            chain: Chain::BitcoinTestnet4,
            asset: Asset::Erc20 {
                token: TOKEN.to_string(),
            },
            max_per_24h: U128(1),
        }],
    };
    assert_eq!(
        validate_aggregate(bad),
        Err(PolicyError::AssetNotValidForChain)
    );
}
