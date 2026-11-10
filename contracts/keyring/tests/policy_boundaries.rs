//! Policy evaluator boundary tests (CLAUDE.md §10, Gate B).
//!
//! Every numeric rule is tested exactly at its cap and exactly one base unit
//! above it. These tests call the pure evaluator directly, so they exercise the
//! real enforcement logic with no VM, no mocks and no network.

mod common;
use common::*;

use keyring_contract::policy::{
    evaluate, is_expired, spend_in_window, validate_policy, ChainPolicy, Decision, Policy,
    PolicyError, RefusalCode, SpendEntry, TimeWindow, MAX_SPEND_ENTRIES, ROLLING_WINDOW_MS,
};
use keyring_contract::types::{normalize_destination, Chain};
use near_sdk::json_types::U128;

fn intent(amount: u128, fee: u128) -> keyring_contract::policy::TransferIntent {
    keyring_contract::policy::TransferIntent {
        chain: Chain::BaseSepolia,
        destination: DEST_A.to_string(),
        amount,
        fee,
    }
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
    let d = evaluate(false, &evm_policy(), &[], &intent(1, 1), at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::AgentDisabled);
}

#[test]
fn disabled_takes_precedence_over_every_other_rule() {
    // A request that violates chain, destination, amount and fee as well must
    // still report the kill switch, because evaluation order is fixed.
    let bad = keyring_contract::policy::TransferIntent {
        chain: Chain::BitcoinTestnet4,
        destination: DEST_EVIL.to_string(),
        amount: u128::MAX,
        fee: u128::MAX,
    };
    let d = evaluate(false, &evm_policy(), &[], &bad, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::AgentDisabled);
}

// ------------------------------------------------------------ chain allowlist

#[test]
fn chain_absent_from_policy_is_refused() {
    let btc = keyring_contract::policy::TransferIntent {
        chain: Chain::BitcoinTestnet4,
        destination: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".to_string(),
        amount: 1_000,
        fee: 100,
    };
    let d = evaluate(true, &evm_policy(), &[], &btc, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::ChainNotAllowed);
}

#[test]
fn chain_check_precedes_destination_check() {
    let btc = keyring_contract::policy::TransferIntent {
        chain: Chain::BitcoinTestnet4,
        destination: DEST_EVIL.to_string(),
        amount: 1,
        fee: 1,
    };
    let d = evaluate(true, &evm_policy(), &[], &btc, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::ChainNotAllowed);
}

// ------------------------------------------------------ destination allowlist

#[test]
fn allowlisted_destination_is_permitted() {
    let d = evaluate(true, &evm_policy(), &[], &intent(1, 1), at_utc(12, 0));
    assert!(matches!(d, Decision::Allow { .. }));
}

#[test]
fn non_allowlisted_destination_is_refused() {
    let mut i = intent(1, 1);
    i.destination = DEST_EVIL.to_string();
    let d = evaluate(true, &evm_policy(), &[], &i, at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::DestinationNotAllowed);
}

#[test]
fn empty_allowlist_permits_nobody() {
    // An empty destination list must never be read as "any destination".
    let mut p = evm_policy();
    p.chains[0].allowed_destinations.clear();
    let d = evaluate(true, &p, &[], &intent(1, 1), at_utc(12, 0));
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
    let d = evaluate(true, &evm_policy(), &[], &intent(ONE_ETH, 0), at_utc(12, 0));
    assert!(matches!(d, Decision::Allow { reserve } if reserve == ONE_ETH));
}

#[test]
fn amount_one_base_unit_over_per_request_cap_is_refused() {
    let d = evaluate(
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
    let d = evaluate(true, &evm_policy(), &[], &intent(0, 0), at_utc(12, 0));
    assert_eq!(refusal_code(&d), RefusalCode::AmountZero);
}

// ------------------------------------------------------------------- fee cap

#[test]
fn fee_exactly_at_cap_is_allowed() {
    let d = evaluate(
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
    let d = evaluate(
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
    let d = evaluate(
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
    let d = evaluate(true, &evm_policy(), &ledger, &intent(ONE_ETH, 0), now);
    assert!(matches!(d, Decision::Allow { .. }));
}

#[test]
fn spend_one_base_unit_over_daily_cap_is_refused() {
    let now = at_utc(12, 0);
    let ledger = vec![entry(now - 1_000, ONE_ETH)];
    let d = evaluate(true, &evm_policy(), &ledger, &intent(ONE_ETH + 1, 0), now);
    // cap+1 on a single request trips the per-request rule first, so to isolate
    // the daily rule we raise the per-request cap to the daily cap.
    assert_eq!(refusal_code(&d), RefusalCode::PerRequestCapExceeded);

    let mut p = evm_policy();
    p.chains[0].max_per_request = U128(2 * ONE_ETH);
    let d = evaluate(true, &p, &ledger, &intent(ONE_ETH + 1, 0), now);
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
    let d = evaluate(true, &evm_policy(), &ledger, &intent(1, 0), now);
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
        refusal_code(&evaluate(
            true,
            &evm_policy(),
            &ledger,
            &intent(1, 0),
            t0 + 1_000
        )),
        RefusalCode::DailyCapExceeded
    );
    // Just past 24 hours, the old spend no longer counts.
    let later = t0 + ROLLING_WINDOW_MS + 1;
    assert!(matches!(
        evaluate(true, &evm_policy(), &ledger, &intent(ONE_ETH, 0), later),
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
    let d = evaluate(true, &evm_policy(), &ledger, &intent(1, 0), now);
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
        evaluate(true, &p, &[], &intent(1, 0), at_utc(9, 0)),
        Decision::Allow { .. }
    ));
    assert!(matches!(
        evaluate(true, &p, &[], &intent(1, 0), at_utc(16, 59)),
        Decision::Allow { .. }
    ));
    assert_eq!(
        refusal_code(&evaluate(true, &p, &[], &intent(1, 0), at_utc(17, 0))),
        RefusalCode::OutsideTimeWindow
    );
    assert_eq!(
        refusal_code(&evaluate(true, &p, &[], &intent(1, 0), at_utc(8, 59))),
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
                evaluate(true, &p, &[], &intent(1, 0), at_utc(h, m)),
                Decision::Allow { .. }
            ),
            "{h:02}:{m:02} should be inside an overnight window"
        );
    }
    for (h, m) in [(6, 0), (12, 0), (21, 59)] {
        assert_eq!(
            refusal_code(&evaluate(true, &p, &[], &intent(1, 0), at_utc(h, m))),
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
    let d = evaluate(true, &p, &[], &intent(u128::MAX, u128::MAX), at_utc(3, 0));
    assert_eq!(refusal_code(&d), RefusalCode::OutsideTimeWindow);
}

// --------------------------------------------------------- policy validation

#[test]
fn policy_destinations_are_normalized_on_store() {
    let mut p = evm_policy();
    p.chains[0].allowed_destinations = vec![DEST_A.to_ascii_uppercase().replace("0X", "0x")];
    let stored = validate_policy(p).expect("policy should be valid");
    assert_eq!(
        stored.chains[0].allowed_destinations,
        vec![DEST_A.to_string()]
    );
}

#[test]
fn policy_rejects_malformed_destination() {
    let mut p = evm_policy();
    p.chains[0].allowed_destinations = vec!["not-an-address".to_string()];
    assert!(matches!(
        validate_policy(p),
        Err(PolicyError::InvalidDestination(_))
    ));
}

#[test]
fn policy_rejects_per_request_cap_above_daily_cap() {
    let mut p = evm_policy();
    p.chains[0].max_per_request = U128(3 * ONE_ETH);
    assert_eq!(
        validate_policy(p),
        Err(PolicyError::PerRequestCapAboveDailyCap)
    );
}

#[test]
fn policy_rejects_zero_caps_and_duplicate_chains() {
    let mut p = evm_policy();
    p.chains[0].max_per_request = U128(0);
    assert_eq!(validate_policy(p), Err(PolicyError::ZeroCap));

    let dup = Policy {
        chains: vec![
            ChainPolicy {
                chain: Chain::BaseSepolia,
                max_per_request: U128(1),
                max_per_24h: U128(1),
                max_fee: U128(1),
                allowed_destinations: vec![],
            },
            ChainPolicy {
                chain: Chain::BaseSepolia,
                max_per_request: U128(1),
                max_per_24h: U128(1),
                max_fee: U128(1),
                allowed_destinations: vec![],
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
