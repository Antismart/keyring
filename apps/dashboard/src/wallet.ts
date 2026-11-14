/**
 * Wallet connection for owner actions.
 *
 * The console never holds a key. Privileged calls are handed to the owner's
 * own wallet to sign, so the key stays in the wallet and this code only ever
 * sees a transaction outcome.
 *
 * That matters beyond hygiene: owner authority on the contract comes from
 * `predecessor_account_id()`, so a call signed by anyone other than the owner
 * is rejected on chain regardless of what this page sends.
 */

import {
  internalActionToNaj,
  setupWalletSelector,
  type InternalAction,
  type WalletSelector,
} from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui-js";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
// The modal ships its layout as a separate stylesheet. Without it the modal is
// mounted but invisible, so "Connect wallet" appears to do nothing.
import "@near-wallet-selector/modal-ui-js/styles.css";

import { NETWORK_ID, OWNER_CALL_GAS } from "./config";

let selector: WalletSelector | null = null;
let modal: WalletSelectorModal | null = null;
let modalContract = "";

/** Lazily builds the selector; the modal needs the contract it will act on. */
async function ensure(contractId: string): Promise<WalletSelector> {
  if (!selector) {
    selector = await setupWalletSelector({
      network: NETWORK_ID,
      // MyNearWallet only, deliberately. Meteor's SDK imports `utils` from
      // near-api-js, which v7 removed, and this workspace resolves v7 for the
      // SDK — so adding it breaks the build rather than adding a wallet.
      modules: [setupMyNearWallet()],
    });
  }
  if (!modal || modalContract !== contractId) {
    modalContract = contractId;
    modal = setupModal(selector, { contractId });
  }
  return selector;
}

export interface WalletState {
  accountId: string | null;
  walletName: string | null;
}

export async function walletState(contractId: string): Promise<WalletState> {
  const s = await ensure(contractId);
  const accounts = s.store.getState().accounts;
  const active = accounts.find((a) => a.active) ?? accounts[0];
  if (!active) return { accountId: null, walletName: null };
  const modules = s.store.getState().modules;
  const selectedId = s.store.getState().selectedWalletId;
  const mod = modules.find((m) => m.id === selectedId);
  return { accountId: active.accountId, walletName: mod?.metadata.name ?? null };
}

export async function connect(contractId: string): Promise<void> {
  await ensure(contractId);
  modal!.show();
}

export async function disconnect(contractId: string): Promise<void> {
  const s = await ensure(contractId);
  const wallet = await s.wallet();
  await wallet.signOut();
}

/** Subscribes to sign-in/out so the UI can follow without polling. */
export async function onAccountChange(
  contractId: string,
  handler: () => void,
): Promise<void> {
  const s = await ensure(contractId);
  s.store.observable.subscribe(() => handler());
}

export interface CallResult {
  /** The NEAR transaction hash, when the wallet returns one. */
  txHash: string | null;
}

/**
 * Signs and sends a contract call through the connected wallet.
 *
 * Deposit is always zero: no owner method on the Keyring contract is payable,
 * and the signer's own deposit is attached by the contract from its balance.
 */
export async function ownerCall(
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const s = await ensure(contractId);
  const wallet = await s.wallet();
  // Written as the readable literal, then converted: the wallet's `Action`
  // is the near-js class form, not this shape.
  const action: InternalAction = {
    type: "FunctionCall",
    params: { methodName, args, gas: OWNER_CALL_GAS, deposit: "0" },
  };
  const outcome = await wallet.signAndSendTransaction({
    receiverId: contractId,
    actions: [internalActionToNaj(action)],
  });
  // A browser-redirect wallet returns nothing here: it navigates away and
  // comes back, so treat an absent outcome as submitted rather than failed.
  const hash =
    outcome && typeof outcome === "object" && "transaction" in outcome
      ? ((outcome as { transaction?: { hash?: string } }).transaction?.hash ?? null)
      : null;
  return { txHash: hash };
}
