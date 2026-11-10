/** Read-only NEAR JSON-RPC access. */

import { NEAR_RPC } from "./config";

interface RpcResponse<T> {
  result?: { result: number[]; error?: string; logs?: string[] } & T;
  error?: { message?: string; data?: { message?: string } | string };
}

/**
 * Calls a contract view method.
 *
 * Views only. Anything that changes state goes through the wallet, so this
 * module cannot mutate a keyring even if it is misused.
 */
export async function view<T>(
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "keyring-console",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  if (!res.ok) throw new Error(`RPC returned ${res.status}`);
  const body = (await res.json()) as RpcResponse<unknown>;
  if (body.error) {
    const d = body.error.data;
    throw new Error((typeof d === "string" ? d : d?.message) ?? body.error.message ?? "RPC error");
  }
  if (body.result?.error) throw new Error(body.result.error);
  const bytes = new Uint8Array(body.result!.result);
  const text = new TextDecoder().decode(bytes);
  return (text.length ? JSON.parse(text) : null) as T;
}
