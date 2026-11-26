// Serveur uniquement : prix, cotations, swaps spot et API Jupiter Perps.
import { getBase64EncodedWireTransaction, getTransactionDecoder, partiallySignTransaction, signTransaction } from "@solana/kit";
import { sendRaw } from "./solana.ts";

const JUP = "https://lite-api.jup.ag";
const PERPS = "https://perps-api.jup.ag/v2";

const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : NaN;
};
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
type KeyPair = Awaited<ReturnType<typeof import("./solana.ts").loadKeyPairFrom>>["keyPair"];

/** Prix USD. Un prix manquant n'annule plus tout : on reçoit ce qui est disponible. */
export async function getPrices(mints: string[]): Promise<Record<string, number>> {
  const res = await fetch(`${JUP}/price/v3?ids=${mints.join(",")}`, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Cours Jupiter indisponibles (${res.status})`);
  const json = (await res.json()) as Record<string, { usdPrice?: unknown } | undefined>;
  const out: Record<string, number> = {};
  for (const m of mints) {
    const p = num(json?.[m]?.usdPrice);
    if (p > 0) out[m] = p;
  }
  return out;
}

export interface Quote { inAmount: string; outAmount: string; priceImpactPct: string; [k: string]: unknown }

export async function getQuote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote> {
  const url = `${JUP}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  const q = (await res.json()) as Quote & { error?: string };
  if (!res.ok || q.error || !q.outAmount) throw new Error(`Cotation refusée : ${q.error ?? res.status}`);
  return q;
}

/** Construit, signe et envoie le swap. Renvoie la signature (à CONFIRMER ensuite). */
export async function executeSwap(quote: Quote, owner: string, keyPair: KeyPair): Promise<string> {
  const res = await fetch(`${JUP}/swap/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: owner,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      // frais de priorité plafonnés : avec un petit capital, des frais « auto » illimités mangent les gains
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: "high", maxLamports: 150_000 } },
    }),
  });
  const json = (await res.json()) as { swapTransaction?: string; error?: string };
  if (!json.swapTransaction) throw new Error(`Swap refusé : ${json.error ?? res.status}`);
  const tx = getTransactionDecoder().decode(b64ToBytes(json.swapTransaction));
  const signed = await signTransaction([keyPair], tx as Parameters<typeof signTransaction>[1]);
  return sendRaw(getBase64EncodedWireTransaction(signed));
}

// ------------------------------------ Jupiter Perps ------------------------------------
export async function perpsPrice(mint: string): Promise<number> {
  const res = await fetch(`${PERPS}/market-stats?mint=${mint}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error("Cours perps indisponible");
  const p = num(((await res.json()) as { price?: unknown }).price);
  if (!(p > 0)) throw new Error("Cours perps invalide");
  return p;
}

export interface PerpPosition { pubkey: string; asset: string; side: "long" | "short"; entryPrice: number; valueUsd: number; sizeUsd: number }

export async function perpsPositions(wallet: string): Promise<PerpPosition[]> {
  const res = await fetch(`${PERPS}/positions?walletAddress=${wallet}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error("Positions perps indisponibles");
  const json = (await res.json()) as { dataList?: Record<string, unknown>[] };
  if (!Array.isArray(json.dataList)) throw new Error("Réponse de positions invalide");
  return json.dataList.map((p) => {
    // L'API v2 renvoie les montants USD en entiers à 6 décimales : on les convertit ICI, une seule fois.
    const value = (num(p["collateralUsd"]) + num(p["pnlAfterFeesUsd"])) / 1e6;
    const entry = num(p["entryPriceUsd"]) / 1e6;
    const size = num(p["sizeUsd"]) / 1e6;
    if (!Number.isFinite(value) || !(entry > 0)) throw new Error("Position perps illisible");
    return { pubkey: String(p["positionPubkey"]), asset: String(p["asset"]), side: p["side"] === "short" ? "short" : "long", entryPrice: entry, valueUsd: value, sizeUsd: Number.isFinite(size) ? size : 0 };
  });
}

async function perpsExecute(serializedTxBase64: string, action: string, keyPair: KeyPair): Promise<string> {
  const tx = getTransactionDecoder().decode(b64ToBytes(serializedTxBase64));
  const signed = await partiallySignTransaction([keyPair], tx as Parameters<typeof partiallySignTransaction>[1]);
  const res = await fetch(`${PERPS}/transaction/execute`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ action, serializedTxBase64: getBase64EncodedWireTransaction(signed) }),
  });
  const json = (await res.json()) as { txid?: string; error?: string; message?: string };
  if (!res.ok || !json.txid) throw new Error(`Exécution perps : ${json.message ?? json.error ?? res.status}`);
  return json.txid;
}

const usd6 = (n: number) => String(Math.round(n * 1e6));

export async function perpsOpen(p: { wallet: string; asset: string; side: "long" | "short"; usdcRaw: bigint; leverage: number; stop: number; slippageBps: number }, keyPair: KeyPair) {
  const res = await fetch(`${PERPS}/positions/increase`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      walletAddress: p.wallet, asset: p.asset, side: p.side, inputToken: "USDC", inputTokenAmount: p.usdcRaw.toString(),
      leverage: p.leverage.toFixed(2), maxSlippageBps: String(p.slippageBps),
      // Stop de sécurité posé on-chain : protège même si le bot est injoignable. Le stop suiveur est géré par le bot.
      tpsl: [{ requestType: "sl", receiveToken: "USDC", triggerPrice: usd6(p.stop) }],
    }),
  });
  const json = (await res.json()) as { serializedTxBase64?: string; positionPubkey?: string | null; error?: string; message?: string };
  if (!res.ok || !json.serializedTxBase64) throw new Error(`Ouverture refusée (${res.status}) : ${json.message ?? json.error ?? "réponse vide"}`);
  return perpsExecute(json.serializedTxBase64, "increase-position", keyPair);
}

export async function perpsClose(pubkey: string, slippageBps: number, keyPair: KeyPair) {
  const res = await fetch(`${PERPS}/positions/decrease`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ positionPubkey: pubkey, receiveToken: "USDC", entirePosition: true, maxSlippageBps: String(slippageBps) }),
  });
  const json = (await res.json()) as { serializedTxBase64?: string; error?: string; message?: string };
  if (!res.ok || !json.serializedTxBase64) throw new Error(`Fermeture refusée (${res.status}) : ${json.message ?? json.error ?? "réponse vide"}`);
  return perpsExecute(json.serializedTxBase64, "decrease-position", keyPair);
}

// ------------------------------------ Contrôle des tokens ------------------------------------
const verified = new Map<string, { ok: boolean; at: number; why: string }>();

/**
 * Vérifie sur Jupiter qu'une adresse correspond bien au token attendu (symbole + décimales) avant tout achat.
 * Résultat gardé 6 h. En cas de doute (API muette, symbole ou décimales différents), le token est refusé.
 */
export async function verifyToken(t: { symbol: string; mint: string; decimals: number; verify: boolean }): Promise<{ ok: boolean; why: string }> {
  if (!t.verify) return { ok: true, why: "token d'origine" };
  const hit = verified.get(t.mint);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit;
  let res = { ok: false, why: "contrôle Jupiter indisponible" };
  try {
    const r = await fetch(`${JUP}/tokens/v2/search?query=${t.mint}`, { signal: AbortSignal.timeout(8_000) });
    if (r.ok) {
      const list = (await r.json()) as { id?: string; symbol?: string; decimals?: number }[];
      const info = Array.isArray(list) ? list.find((x) => x.id === t.mint) : undefined;
      if (!info) res = { ok: false, why: "adresse inconnue de Jupiter" };
      else if (String(info.symbol).toUpperCase() !== t.symbol.toUpperCase()) res = { ok: false, why: `symbole ${info.symbol} au lieu de ${t.symbol}` };
      else if (info.decimals !== t.decimals) res = { ok: false, why: `décimales ${info.decimals} au lieu de ${t.decimals}` };
      else res = { ok: true, why: "vérifié sur Jupiter" };
    }
  } catch { /* res reste « indisponible » : on n'achète pas ce token pour l'instant */ }
  // un refus définitif (mauvais symbole/décimales) est gardé 6 h ; une panne d'API est retentée au prochain tick
  if (res.ok || res.why !== "contrôle Jupiter indisponible") verified.set(t.mint, { ...res, at: Date.now() });
  return res;
}
