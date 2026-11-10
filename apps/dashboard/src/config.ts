/** Deployment-wide constants and display metadata. */

export const NEAR_RPC = "https://rpc.testnet.near.org";
export const NETWORK_ID = "testnet";
export const MPC_SIGNER = "v1.signer-prod.testnet";
/** Domain 0 on the deployed signer: CaitSith, purpose Sign, secp256k1. */
export const ECDSA_DOMAIN_ID = 0;
/** Must match the contract: the rolling window is half-open. */
export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The reference deployment, used when no account is given. */
export const DEFAULT_ACCOUNT = "keyring-gated-1794298589.testnet";

/** Gas for an owner call, in gas units. Comfortably covers policy writes. */
export const OWNER_CALL_GAS = "100000000000000";

export interface ChainMeta {
  label: string;
  /** The identifier the contract uses in derivation paths. */
  short: string;
  symbol: string;
  decimals: number;
  /** Smallest unit, for exact figures. */
  unit: string;
  explorer: string;
}

export const CHAINS: Record<string, ChainMeta> = {
  base_sepolia: {
    label: "Base Sepolia",
    short: "base-sepolia",
    symbol: "ETH",
    decimals: 18,
    unit: "wei",
    explorer: "https://sepolia.basescan.org",
  },
  bitcoin_testnet4: {
    label: "Bitcoin testnet4",
    short: "bitcoin-testnet4",
    symbol: "BTC",
    decimals: 8,
    unit: "sat",
    explorer: "https://mempool.space/testnet4",
  },
};

/**
 * Tokens whose decimals we recognise, for display only.
 *
 * The contract never reads a token's decimals — amounts are always its
 * smallest unit. An unrecognised token is shown in raw units rather than
 * guessed at, because displaying a wrong scale for money is worse than
 * displaying an awkward one.
 */
export const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": { symbol: "USDC", decimals: 6 },
};
