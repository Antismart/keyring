//! MPC signing lifecycle, callback access control and wire-format tests.
//!
//! The wire-format tests are the important ones. They pin the exact JSON this
//! contract sends to, and accepts from, `v1.signer-prod.testnet`, as read from
//! that contract's own embedded ABI. If a signer upgrade changes the schema,
//! these fail rather than the contract silently sending a request the signer
//! rejects — or worse, one it misinterprets.

mod common;
use common::*;

use keyring_contract::evm::{address_bytes, Eip1559Transfer, BASE_SEPOLIA_CHAIN_ID};
use keyring_contract::mpc;
use keyring_contract::policy::RefusalCode;
use keyring_contract::signer::SignerBackend;
use keyring_contract::state::RequestStatus;
use keyring_contract::types::Chain;
use keyring_contract::{Contract, RequestOutcome};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{serde_json, testing_env, PromiseError, PromiseOrValue, PublicKey};

const OWNER: &str = "owner.testnet";
const CONTRACT: &str = "keyring.testnet";
const SIGNER: &str = "v1.signer-prod.testnet";

fn ctx_from(predecessor: &str, signer_pk: PublicKey, now_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(account(CONTRACT))
        .predecessor_account_id(account(predecessor))
        .signer_account_id(account(predecessor))
        .signer_account_pk(signer_pk)
        .block_timestamp(now_ms * 1_000_000);
    testing_env!(b.build());
}

fn setup(backend: SignerBackend) -> Contract {
    ctx_from(OWNER, pk(0), at_utc(12, 0));
    let mut c = Contract::new(backend);
    c.register_keyring();
    c.register_agent(pk(1), "agent-one".to_string(), evm_policy());
    c
}

fn request(c: &mut Contract, amount: u128, key: &str) -> PromiseOrValue<RequestOutcome> {
    ctx_from("agent-host.testnet", pk(1), at_utc(12, 0));
    c.request_transfer(
        Chain::BaseSepolia,
        DEST_A.to_string(),
        U128(amount),
        evm_params(),
        key.to_string(),
    )
}

// ------------------------------------------------------------ wire format

#[test]
fn sign_args_match_the_deployed_signer_schema() {
    // Verified against the embedded ABI of v1.signer-prod.testnet (3.18.0):
    // SignRequestArgs requires exactly `path`, `payload_v2` and `domain_id`,
    // Payload is an externally tagged `Ecdsa` holding a 64-char hex string,
    // and DomainId is a bare uint64.
    let payload = [0xabu8; 32];
    let args = mpc::sign_args(
        "keyring-v1,o.testnet,a,base-sepolia".to_string(),
        mpc::to_hex(&payload),
    );
    let json = serde_json::to_value(&args).expect("serialises");

    assert_eq!(
        json,
        serde_json::json!({
            "path": "keyring-v1,o.testnet,a,base-sepolia",
            "payload_v2": { "Ecdsa": "ab".repeat(32) },
            "domain_id": 0
        })
    );

    // The field must be payload_v2, not payload. The signer accepts `payload`
    // only as a deprecated raw byte array, which is a different encoding.
    assert!(
        json.get("payload").is_none(),
        "must not send the deprecated field name"
    );
    assert_eq!(json["payload_v2"]["Ecdsa"].as_str().unwrap().len(), 64);
}

#[test]
fn the_ecdsa_domain_is_the_secp256k1_signing_domain() {
    // Read from the live contract's `state` view: domain 0 is CaitSith with
    // purpose Sign. Domain 1 is Frost/Ed25519 and must never be used here.
    assert_eq!(mpc::ECDSA_DOMAIN_ID, 0);
}

#[test]
fn the_signer_response_shape_deserialises() {
    // Exactly the shape the ABI declares for SignatureResponse::Secp256k1.
    let raw = serde_json::json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": "02".to_string() + &"11".repeat(32) },
        "s": { "scalar": "22".repeat(32) },
        "recovery_id": 1
    });
    let parsed: mpc::SignatureResponse = serde_json::from_value(raw).expect("deserialises");
    match parsed {
        mpc::SignatureResponse::Secp256k1 {
            big_r,
            s,
            recovery_id,
        } => {
            assert_eq!(big_r.affine_point.len(), 66);
            assert_eq!(s.scalar, "22".repeat(32));
            assert_eq!(recovery_id, 1);
        }
        mpc::SignatureResponse::Ed25519 { .. } => panic!("wrong variant"),
    }
}

#[test]
fn the_sign_deposit_is_one_yoctonear_and_gas_clears_the_minimum() {
    // SIGN_DEPOSIT_YOCTONEAR = 1 in the signer's deposits module, and the live
    // config requires sign_call_gas_attachment_requirement_tera_gas = 15.
    assert_eq!(mpc::SIGN_DEPOSIT.as_yoctonear(), 1);
    assert!(
        mpc::SIGN_GAS.as_tgas() >= 15,
        "must clear the signer's minimum"
    );
    assert_eq!(mpc::SIGN_METHOD, "sign");
}

// ----------------------------------------------------------------- payload

#[test]
fn the_signed_payload_is_the_real_transaction_hash() {
    // The payload is now an EIP-1559 signing hash, recomputed here from the
    // approved fields. Anyone can repeat this from the stored request and
    // confirm the contract signed the transaction policy authorised.
    let mut c = setup(SignerBackend::Mock);
    let _ = request(&mut c, ONE_ETH, "k1");
    let req = c.get_request(1).expect("request recorded");

    let expected = Eip1559Transfer {
        chain_id: BASE_SEPOLIA_CHAIN_ID,
        nonce: 0,
        max_priority_fee_per_gas: 1_000_000,
        max_fee_per_gas: 1_000_000_000,
        gas_limit: 21_000,
        to: address_bytes(DEST_A).expect("valid destination"),
        value: ONE_ETH,
    }
    .signing_hash();

    assert_eq!(req.payload_hex, Some(mpc::to_hex(&expected)));
}

#[test]
fn the_fee_is_derived_from_gas_and_not_supplied_by_the_caller() {
    // There is no fee parameter any more. The recorded fee must equal
    // gas_limit * max_fee_per_gas, so the value policy checked and the value
    // the transaction can spend are the same number (invariant 9).
    let mut c = setup(SignerBackend::Mock);
    let _ = request(&mut c, ONE_ETH, "k1");
    let req = c.get_request(1).unwrap();
    assert_eq!(req.fee, U128(21_000u128 * 1_000_000_000u128));
}

#[test]
fn inflated_gas_parameters_are_caught_by_the_fee_cap() {
    // A caller cannot buy a huge fee allowance by inflating gas numbers: the
    // derived fee is checked against the policy fee cap like any other.
    let mut c = setup(SignerBackend::Mock);
    ctx_from("agent-host.testnet", pk(1), at_utc(12, 0));
    let out = c.request_transfer(
        Chain::BaseSepolia,
        DEST_A.to_string(),
        U128(1),
        // 200000 gas at 1000 gwei = 2e17 wei, far above the 1e16 fee cap.
        evm_params_with_fee(200_000, 1_000_000_000_000),
        "inflated".to_string(),
    );
    match out {
        PromiseOrValue::Value(RequestOutcome::Refused { refusal, .. }) => {
            assert_eq!(refusal.code, RefusalCode::FeeCapExceeded);
            assert_eq!(
                refusal.observed,
                Some(U128(200_000u128 * 1_000_000_000_000u128))
            );
        }
        _ => panic!("an over-cap fee must be refused"),
    }
}

#[test]
fn parameters_for_the_wrong_chain_are_rejected() {
    let mut c = setup(SignerBackend::Mock);
    ctx_from("agent-host.testnet", pk(1), at_utc(12, 0));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.request_transfer(
            Chain::BitcoinTestnet4,
            "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".to_string(),
            U128(1),
            evm_params(),
            "wrong-chain".to_string(),
        )
    }));
    assert!(
        result.is_err(),
        "EVM parameters must not be accepted for Bitcoin"
    );
}

// --------------------------------------------------------------- mock path

#[test]
fn the_mock_backend_marks_its_signature_as_mock() {
    let mut c = setup(SignerBackend::Mock);
    let _ = request(&mut c, ONE_ETH, "k1");
    let req = c.get_request(1).unwrap();

    assert_eq!(req.status, RequestStatus::Signed);
    let sig = req.signature.expect("mock signature stored");
    assert!(
        sig.mock,
        "a mock signature must be identifiable as such from the data alone"
    );
    assert_eq!(sig.scheme, "Secp256k1");
    assert_eq!(sig.big_r.len(), 64);
}

// ---------------------------------------------------- callback access control

#[test]
#[should_panic(expected = "on_signed is a private callback")]
fn on_signed_rejects_a_foreign_predecessor() {
    // The signer account itself must not be able to call our callback: only
    // this contract's own cross-contract callback may (invariant 16).
    let mut c = setup(SignerBackend::Mpc {
        contract_id: account(SIGNER),
    });
    let _ = request(&mut c, ONE_ETH, "k1");

    ctx_from(SIGNER, pk(0), at_utc(12, 1));
    let _ = c.on_signed(1, Err(PromiseError::Failed));
}

#[test]
#[should_panic(expected = "on_signed is a private callback")]
fn on_signed_rejects_the_owner() {
    let mut c = setup(SignerBackend::Mpc {
        contract_id: account(SIGNER),
    });
    let _ = request(&mut c, ONE_ETH, "k1");

    ctx_from(OWNER, pk(0), at_utc(12, 1));
    let _ = c.on_signed(1, Err(PromiseError::Failed));
}

// -------------------------------------------------------- callback lifecycle

#[test]
fn a_successful_callback_records_a_real_signature() {
    let mut c = setup(SignerBackend::Mpc {
        contract_id: account(SIGNER),
    });
    let _ = request(&mut c, ONE_ETH, "k1");
    assert_eq!(c.get_request(1).unwrap().status, RequestStatus::Signing);

    ctx_from(CONTRACT, pk(0), at_utc(12, 1));
    let out = c.on_signed(
        1,
        Ok(mpc::SignatureResponse::Secp256k1 {
            big_r: mpc::AffinePoint {
                affine_point: "02".to_string() + &"11".repeat(32),
            },
            s: mpc::Scalar {
                scalar: "22".repeat(32),
            },
            recovery_id: 0,
        }),
    );

    assert!(matches!(out, RequestOutcome::Signed { request_id: 1 }));
    let req = c.get_request(1).unwrap();
    assert_eq!(req.status, RequestStatus::Signed);
    let sig = req.signature.expect("signature stored");
    assert!(
        !sig.mock,
        "a signer-produced signature must not be flagged mock"
    );
    assert_eq!(sig.s, "22".repeat(32));
}

#[test]
fn a_failed_callback_retains_the_budget_reservation() {
    let mut c = setup(SignerBackend::Mpc {
        contract_id: account(SIGNER),
    });
    let _ = request(&mut c, ONE_ETH, "k1");

    ctx_from(CONTRACT, pk(0), at_utc(12, 1));
    let out = c.on_signed(1, Err(PromiseError::Failed));
    assert!(matches!(
        out,
        RequestOutcome::SigningFailed { request_id: 1, .. }
    ));

    let req = c.get_request(1).unwrap();
    assert_eq!(req.status, RequestStatus::Failed);
    assert!(req.signature.is_none());
    assert!(req.failure_reason.is_some());

    // The reservation stands. The contract cannot prove no usable signature was
    // produced, so releasing it would risk authorising spend twice.
    assert_eq!(req.reserved, U128(ONE_ETH));
    let agent = c.get_agent(account(OWNER), pk(1)).unwrap();
    let total: u128 = agent
        .ledgers
        .iter()
        .flat_map(|l| &l.entries)
        .map(|e| e.amount.0)
        .sum();
    assert_eq!(total, ONE_ETH, "a failed signing must not release budget");
}

#[test]
fn an_unexpected_ed25519_response_is_rejected_not_stored() {
    let mut c = setup(SignerBackend::Mpc {
        contract_id: account(SIGNER),
    });
    let _ = request(&mut c, ONE_ETH, "k1");

    ctx_from(CONTRACT, pk(0), at_utc(12, 1));
    let out = c.on_signed(
        1,
        Ok(mpc::SignatureResponse::Ed25519 {
            signature: serde_json::json!({ "signature": "00" }),
        }),
    );

    assert!(matches!(out, RequestOutcome::SigningFailed { .. }));
    let req = c.get_request(1).unwrap();
    assert_eq!(req.status, RequestStatus::Failed);
    assert!(req.signature.is_none());
}

#[test]
fn a_refused_request_never_reaches_the_signer() {
    // The kill switch must stop a request before any MPC call is made.
    let mut c = setup(SignerBackend::Mpc {
        contract_id: account(SIGNER),
    });
    ctx_from(OWNER, pk(0), at_utc(12, 0));
    c.set_agent_enabled(pk(1), false);

    match request(&mut c, ONE_ETH, "k1") {
        PromiseOrValue::Value(RequestOutcome::Refused { request_id, .. }) => {
            let req = c.get_request(request_id).unwrap();
            assert_eq!(req.status, RequestStatus::Refused);
            assert_eq!(req.reserved, U128(0));
            assert!(
                req.payload_hex.is_none(),
                "nothing may be prepared for signing"
            );
        }
        PromiseOrValue::Value(other) => {
            panic!("a disabled agent must be refused, got {other:?}")
        }
        PromiseOrValue::Promise(_) => {
            panic!("a disabled agent must be refused before any MPC call")
        }
    }
}

#[test]
fn the_mpc_backend_reports_itself_as_not_mock() {
    let c = setup(SignerBackend::Mpc {
        contract_id: account(SIGNER),
    });
    assert!(!c.is_mock_signer());
    assert_eq!(
        c.get_signer_backend(),
        SignerBackend::Mpc {
            contract_id: account(SIGNER)
        }
    );
}
