// Serveur uniquement : RPC Solana, clés, soldes, et surtout CONFIRMATION des transactions.
// Règle d'or : une transaction envoyée n'est pas une transaction exécutée. Rien n'est enregistré tant que la blockchain
// ne l'a pas confirmée, et l'état du bot est toujours recalé sur le contenu réel du portefeuille.
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  createKeyPairFromBytes,
  getAddressEncoder,
  getAddressFromPublicKey,
  getBase58Encoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { SOL_MINT, allTokens, USDC_MINT } from "./strategy.ts";

/** Variables d'environnement : marche sous Deno (Supabase) comme sous Node. */
export function env(name: string): string | undefined {
  const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } }; process?: { env: Record<string, string | undefined> } };
  return g.Deno?.env.get(name) ?? g.process?.env[name];
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SOL_RESERVE = 0.015; // gardé pour les frais réseau, jamais tradé

function rpcUrls() {
  const custom = env("SOLANA_RPC_URL");
  const free = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
  return custom ? [custom, ...free] : free;
}

/** Appel RPC avec bascule automatique sur un autre fournisseur en cas d'échec. */
export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let last = "";
  for (const url of rpcUrls()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(12_000),
      });
      const json = (await res.json()) as { result?: T; error?: { message: string } };
      if (json.error) { last = json.error.message; if (method === "sendTransaction") break; continue; }
      return json.result as T;
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(`RPC ${method} : ${last}`);
}

export async function loadKeyPairFrom(envName: string) {
  const raw = env(envName)?.trim();
  if (!raw) throw new Error(`Clé du portefeuille manquante (${envName})`);
  const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw) as number[]) : new Uint8Array(getBase58Encoder().encode(raw));
  const keyPair = await createKeyPairFromBytes(bytes);
  const addr = await getAddressFromPublicKey(keyPair.publicKey);
  return { keyPair, address: addr as string };
}

export interface Balances {
  sol: number;                    // SOL total (réserve comprise)
  raw: Record<string, bigint>;    // unités brutes ; SOL = lamports TRADABLES (hors réserve)
  ui: Record<string, number>;     // montants lisibles ; SOL = SOL tradable
  usdc: number;
}

export async function getBalances(owner: string): Promise<Balances> {
  const mints = [USDC_MINT, ...allTokens().filter((t) => t.mint !== SOL_MINT).map((t) => t.mint)];
  const enc = getAddressEncoder();
  const accounts = await Promise.all(mints.map(async (mint) => {
    const [ata] = await getProgramDerivedAddress({
      programAddress: address(ATA_PROGRAM),
      seeds: [enc.encode(address(owner)), enc.encode(address(TOKEN_PROGRAM)), enc.encode(address(mint))],
    });
    return ata;
  }));
  const [lamports, infos] = await Promise.all([
    rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]),
    rpc<{ value: ({ owner: string; data: { parsed: { info: { owner: string; mint: string; tokenAmount: { amount: string; decimals: number } } } } } | null)[] }>(
      "getMultipleAccounts", [accounts, { encoding: "jsonParsed", commitment: "confirmed" }]),
  ]);
  if (infos.value.length !== mints.length) throw new Error("Réponse de soldes incomplète");
  const tradable = Math.max(0, lamports.value - SOL_RESERVE * 1e9);
  const raw: Record<string, bigint> = { [SOL_MINT]: BigInt(Math.floor(tradable)) };
  const ui: Record<string, number> = { [SOL_MINT]: tradable / 1e9 };
  infos.value.forEach((a, i) => {
    if (!a) return; // compte jamais créé = solde nul
    const info = a.data.parsed.info;
    if (a.owner !== TOKEN_PROGRAM || info.owner !== owner || info.mint !== mints[i]) throw new Error("Compte de jeton inattendu");
    raw[info.mint] = BigInt(info.tokenAmount.amount);
    ui[info.mint] = Number(info.tokenAmount.amount) / 10 ** info.tokenAmount.decimals;
  });
  return { sol: lamports.value / 1e9, raw, ui, usdc: ui[USDC_MINT] ?? 0 };
}

export type TxStatus = "confirmed" | "failed" | "pending";

export async function txStatus(sig: string): Promise<TxStatus> {
  const res = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(
    "getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
  const st = res.value[0];
  if (!st) return "pending";
  if (st.err) return "failed";
  return st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized" ? "confirmed" : "pending";
}

/** Attend la confirmation (au plus `ms`). Au-delà, la transaction reste « en attente » et sera vérifiée au tick suivant. */
export async function waitForTx(sig: string, ms = 20_000): Promise<TxStatus> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const st = await txStatus(sig).catch(() => "pending" as TxStatus);
    if (st !== "pending") return st;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return "pending";
}

export async function sendRaw(wireBase64: string): Promise<string> {
  return rpc<string>("sendTransaction", [wireBase64, { encoding: "base64", maxRetries: 3, skipPreflight: false, preflightCommitment: "confirmed" }]);
}

// ------------------------------------ Comptes de tokens (agent swap) ------------------------------------
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PE6Z2ZZ8vKtzqjB";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export interface TokenAccount { pubkey: string; mint: string; program: string; amount: bigint; ui: number; decimals: number; lamports: number }

/** Tous les comptes de tokens du portefeuille (programme classique et Token-2022). */
export async function listTokenAccounts(owner: string): Promise<TokenAccount[]> {
  type R = { value: { pubkey: string; account: { lamports: number; data: { parsed: { info: { mint: string; tokenAmount: { amount: string; uiAmount: number | null; decimals: number } } } } } }[] };
  const out: TokenAccount[] = [];
  for (const program of [TOKEN_PROGRAM, TOKEN_2022]) {
    const res = await rpc<R>("getTokenAccountsByOwner", [owner, { programId: program }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    for (const a of res.value) {
      const info = a.account.data.parsed.info;
      out.push({ pubkey: a.pubkey, mint: info.mint, program, amount: BigInt(info.tokenAmount.amount), ui: info.tokenAmount.uiAmount ?? 0, decimals: info.tokenAmount.decimals, lamports: a.account.lamports });
    }
  }
  return out;
}

type KeyPair = Awaited<ReturnType<typeof loadKeyPairFrom>>["keyPair"];

/**
 * Ferme des comptes de tokens VIDES (ou de SOL emballé) : le SOL bloqué en caution revient au portefeuille.
 * Une seule transaction pour au plus 8 comptes. Renvoie la signature (à confirmer).
 */
export async function closeTokenAccounts(keyPair: KeyPair, owner: string, accounts: TokenAccount[]): Promise<string> {
  if (!accounts.length || accounts.length > 8) throw new Error("1 à 8 comptes par transaction");
  for (const a of accounts) if (a.amount > 0n && a.mint !== WSOL_MINT) throw new Error(`compte non vide (${a.mint})`); // sécurité : jamais de tokens détruits
  const { value } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const instructions = accounts.map((a) => ({
    programAddress: address(a.program),
    accounts: [
      { address: address(a.pubkey), role: AccountRole.WRITABLE },        // compte fermé
      { address: address(owner), role: AccountRole.WRITABLE },           // le SOL revient au propriétaire
      { address: address(owner), role: AccountRole.READONLY_SIGNER },    // autorisation du propriétaire
    ],
    data: new Uint8Array([9]), // instruction CloseAccount du programme de tokens
  }));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(owner), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: value.blockhash as never, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransaction([keyPair], compileTransaction(message) as Parameters<typeof signTransaction>[1]);
  return sendRaw(getBase64EncodedWireTransaction(signed));
}
