// Serveur uniquement : client Hyperliquid (perps) — lecture du compte, marchés, bougies, ordres et stops.
// Sécurité : le bot signe avec un « portefeuille API » (agent) créé par Ramos sur app.hyperliquid.xyz/API.
// Un agent peut ouvrir et fermer des positions, mais NE PEUT PAS retirer d'argent : même volée, sa clé ne vide pas le compte.
// Secrets Supabase : HL_ACCOUNT_ADDRESS (adresse du compte principal, où sont les USDC) et HL_AGENT_PRIVATE_KEY (clé de l'agent).
import { addressOf, signL1Action } from "./evm.ts";
import { env } from "./solana.ts";
import type { Candle, Interval } from "./strategy.ts";

const API = "https://api.hyperliquid.xyz";
export const HL_RULES = {
  minNotionalUsd: 10,     // Hyperliquid refuse un ordre de moins de 10 $ de valeur (taille × prix)
  takerFee: 0.00045,      // 0,045 % par côté (niveau de départ)
  slippage: 0.01,         // ordre « au marché » = ordre limite IOC 1 % au-delà du prix moyen
  stopSlippage: 0.03,     // stop « au marché » déclenché : prix limite 3 % au-delà du déclencheur
  expectedSlip: 0.0005,   // glissement moyen attendu à la sortie (0,05 %) : compté dans le risque d'un trade
  maxExposure: 10,
  fundingBuffer: 0.005,   // réserve de 0,5 % : en marge isolée, le funding payé ronge la marge et rapproche la liquidation        // taille d'une position plafonnée à 10 × le capital, même avec un stop très serré
};

// ---------------------------------------------------------------------------------------------------
// Appels
// ---------------------------------------------------------------------------------------------------
async function post<T>(path: "/info" | "/exchange", body: unknown, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    const res = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (res.status === 429 && i < tries - 1) { await new Promise((r) => setTimeout(r, 700 * (i + 1))); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`Hyperliquid ${path} : ${res.status} ${text.slice(0, 120)}`);
    try { return JSON.parse(text) as T; } catch { throw new Error(`Hyperliquid ${path} : réponse illisible (${text.slice(0, 80)})`); }
  }
}
const info = <T>(body: Record<string, unknown>) => post<T>("/info", body);

// ---------------------------------------------------------------------------------------------------
// Marchés
// ---------------------------------------------------------------------------------------------------
export interface HlAsset { index: number; name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean; isDelisted?: boolean }
export interface HlMarketStats extends HlAsset { markPx: number; dayVolume: number; openInterest: number; funding: number }

let META: { at: number; list: HlAsset[] } | null = null;
/** Liste des perps (index = numéro d'actif utilisé dans les ordres). Gardée 10 minutes en mémoire. */
export async function hlMeta(): Promise<HlAsset[]> {
  if (META && Date.now() - META.at < 600_000) return META.list;
  const m = await info<{ universe: Omit<HlAsset, "index">[] }>({ type: "meta" });
  const list = (m.universe ?? []).map((u, index) => ({ ...u, index }));
  if (!list.length) throw new Error("Hyperliquid : liste des marchés vide");
  META = { at: Date.now(), list };
  return list;
}
export async function hlAsset(name: string): Promise<HlAsset> {
  const a = (await hlMeta()).find((x) => x.name === name);
  if (!a) throw new Error(`Hyperliquid : marché ${name} inconnu`);
  if (a.isDelisted) throw new Error(`Hyperliquid : ${name} n'est plus coté`);
  return a;
}

/** Tous les perps avec leur volume 24 h, l'intérêt ouvert et le funding (pour choisir les marchés à trader). */
export async function hlMarkets(): Promise<HlMarketStats[]> {
  const [m, ctx] = await info<[{ universe: Omit<HlAsset, "index">[] }, { markPx: string; dayNtlVlm: string; openInterest: string; funding: string }[]]>({ type: "metaAndAssetCtxs" });
  return (m.universe ?? []).map((u, index) => {
    const c = ctx[index];
    return { ...u, index, markPx: Number(c?.markPx) || 0, dayVolume: Number(c?.dayNtlVlm) || 0, openInterest: (Number(c?.openInterest) || 0) * (Number(c?.markPx) || 0), funding: Number(c?.funding) || 0 };
  });
}

/** Prix moyens (milieu du carnet) de tous les perps. */
export async function hlMids(): Promise<Record<string, number>> {
  const r = await info<Record<string, string>>({ type: "allMids" });
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]).filter(([, v]) => (v as number) > 0));
}

/** Bougies clôturées (5000 maximum par appel : on enchaîne les pages). */
export async function hlCandles(coin: string, interval: Interval, count: number, end: number): Promise<Candle[]> {
  const step = interval === "1h" ? 3_600_000 : 900_000, all = new Map<number, Candle>();
  for (let to = end; to > end - count * step; to -= 5000 * step) {
    const from = Math.max(end - count * step, to - 5000 * step);
    const rows = await info<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({ type: "candleSnapshot", req: { coin, interval, startTime: from, endTime: to - 1 } });
    for (const r of rows ?? []) all.set(r.t, { t: r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v });
    if (!rows?.length) break;
  }
  return [...all.values()].filter((c) => c.t + step <= end).sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------------------------------
// Compte
// ---------------------------------------------------------------------------------------------------
export interface HlPosition { coin: string; side: "long" | "short"; size: number; entryPx: number; valueUsd: number; marginUsd: number; pnlUsd: number; leverage: number; liqPx: number | null }
export interface HlAccount { address: string; valueUsd: number; perpValueUsd: number; spotUsdc: number; withdrawable: number; positions: HlPosition[] }

export function hlCredentials() {
  const account = env("HL_ACCOUNT_ADDRESS")?.trim().toLowerCase();
  const key = env("HL_AGENT_PRIVATE_KEY")?.trim();
  if (!account || !/^0x[0-9a-f]{40}$/.test(account)) throw new Error("secret HL_ACCOUNT_ADDRESS absent ou invalide");
  if (!key || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error("secret HL_AGENT_PRIVATE_KEY absent ou invalide");
  const k = key.startsWith("0x") ? key : "0x" + key;
  return { account, key: k, agent: addressOf(k) };
}

/** Valeur du compte = perps (marge + gains latents) + USDC restés côté « spot » (un dépôt peut y arriver). */
export async function hlAccount(address: string): Promise<HlAccount> {
  const [st, spot] = await Promise.all([
    info<{ marginSummary?: { accountValue: string }; withdrawable?: string; assetPositions?: { position: { coin: string; szi: string; entryPx: string; positionValue: string; unrealizedPnl: string; marginUsed: string; leverage?: { value: number }; liquidationPx: string | null } }[] }>({ type: "clearinghouseState", user: address }),
    info<{ balances?: { coin: string; total: string; hold: string }[] }>({ type: "spotClearinghouseState", user: address }).catch(() => ({ balances: [] })),
  ]);
  if (!st?.marginSummary) throw new Error("Hyperliquid : état du compte illisible");
  const positions = (st.assetPositions ?? []).map(({ position: p }) => {
    const szi = Number(p.szi), size = Math.abs(szi), entryPx = Number(p.entryPx), lev = Math.max(1, p.leverage?.value ?? 1), pnl = Number(p.unrealizedPnl) || 0;
    const margin = (size * entryPx) / lev; // marge engagée à l'ouverture (indépendante de la façon dont Hyperliquid présente « marginUsed »)
    return { coin: p.coin, side: szi > 0 ? "long" as const : "short" as const, size, entryPx, valueUsd: margin + pnl,
      marginUsd: margin, pnlUsd: pnl, leverage: lev, liqPx: p.liquidationPx ? Number(p.liquidationPx) : null };
  }).filter((p) => p.size > 0 && p.entryPx > 0);
  const perp = Number(st.marginSummary.accountValue) || 0;
  const usdc = Number(spot.balances?.find((b) => b.coin === "USDC")?.total) || 0;
  return { address, valueUsd: perp + usdc, perpValueUsd: perp, spotUsdc: usdc, withdrawable: Number(st.withdrawable) || 0, positions };
}

/** Soldes du côté « Spot » du compte Hyperliquid (USDC et autres jetons), pour la section Wallets. */
export async function hlSpotBalances(address: string): Promise<{ coin: string; total: number; hold: number }[]> {
  const r = await info<{ balances?: { coin: string; total: string; hold: string }[] }>({ type: "spotClearinghouseState", user: address });
  return (r.balances ?? []).map((b) => ({ coin: b.coin, total: +b.total, hold: +b.hold })).filter((b) => b.total > 0);
}

export interface HlFill { coin: string; px: number; sz: number; side: "B" | "A"; time: number; closedPnl: number; fee: number; oid: number; dir: string }
export async function hlFills(address: string, startTime: number): Promise<HlFill[]> {
  const rows = await info<{ coin: string; px: string; sz: string; side: "B" | "A"; time: number; closedPnl: string; fee: string; oid: number; dir: string }[]>({ type: "userFillsByTime", user: address, startTime });
  return (rows ?? []).map((f) => ({ coin: f.coin, px: +f.px, sz: +f.sz, side: f.side, time: f.time, closedPnl: +f.closedPnl, fee: +f.fee, oid: f.oid, dir: f.dir }));
}

/** Dépôts et retraits (en USDC, + = arrivé sur le compte) depuis un instant donné. */
export async function hlTransfers(address: string, startTime: number): Promise<{ time: number; usd: number; kind: string }[]> {
  const rows = await info<{ time: number; delta: { type: string; usdc?: string; amount?: string; token?: string; destination?: string; user?: string } }[]>({ type: "userNonFundingLedgerUpdates", user: address, startTime });
  const out: { time: number; usd: number; kind: string }[] = [];
  for (const r of rows ?? []) {
    const d = r.delta, usd = Number(d.usdc ?? (d.token === "USDC" ? d.amount : NaN));
    if (!Number.isFinite(usd) || usd === 0) continue;
    // mouvement entre les soldes d'un MÊME compte (Spot → Perps, d'une plateforme à l'autre) : la valeur totale ne change pas
    if (d.user && d.destination && d.user.toLowerCase() === d.destination.toLowerCase()) continue;
    if (d.type === "deposit") out.push({ time: r.time, usd: Math.abs(usd), kind: "dépôt" });
    else if (d.type === "withdraw") out.push({ time: r.time, usd: -Math.abs(usd), kind: "retrait" });
    else if (d.type === "send" || d.type === "spotTransfer" || d.type === "internalTransfer") // envoi entre comptes : signe selon le sens
      out.push({ time: r.time, usd: (d.destination ?? "").toLowerCase() === address ? Math.abs(usd) : -Math.abs(usd), kind: d.type });
    // accountClassTransfer (spot ⇄ perps du même compte) : la valeur totale ne change pas, on l'ignore
  }
  return out;
}

export interface HlOrder { coin: string; oid: number; isTrigger: boolean; triggerPx: number; reduceOnly: boolean; side: "B" | "A"; sz: number; orderType: string }
export async function hlOpenOrders(address: string): Promise<HlOrder[]> {
  const rows = await info<{ coin: string; oid: number; isTrigger: boolean; triggerPx: string; reduceOnly: boolean; side: "B" | "A"; sz: string; orderType: string }[]>({ type: "frontendOpenOrders", user: address });
  return (rows ?? []).map((o) => ({ coin: o.coin, oid: o.oid, isTrigger: o.isTrigger, triggerPx: +o.triggerPx, reduceOnly: o.reduceOnly, side: o.side, sz: +o.sz, orderType: o.orderType }));
}

// ---------------------------------------------------------------------------------------------------
// Arrondis imposés par Hyperliquid
// ---------------------------------------------------------------------------------------------------
/** Nombre → texte comme le SDK officiel (8 décimales max, sans zéros inutiles). */
export function floatToWire(x: number): string {
  const r = x.toFixed(8);
  if (Math.abs(Number(r) - x) >= 1e-12) throw new Error(`arrondi impossible : ${x}`);
  const s = r.replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}
/** Taille arrondie VERS LE BAS au pas du marché (jamais plus que voulu). */
export const roundSize = (sz: number, szDecimals: number) => Math.floor(sz * 10 ** szDecimals + 1e-9) / 10 ** szDecimals;
/** Prix : 5 chiffres significatifs au plus et (6 − szDecimals) décimales au plus, comme l'exige Hyperliquid. */
export function roundPrice(px: number, szDecimals: number): number {
  if (!(px > 0)) throw new Error("prix invalide");
  const sig = Number(px.toPrecision(5));
  const dec = Math.max(0, 6 - szDecimals);
  return Number(sig.toFixed(dec));
}

// ---------------------------------------------------------------------------------------------------
// Actions signées
// ---------------------------------------------------------------------------------------------------
let lastNonce = 0;
const nonce = () => (lastNonce = Math.max(Date.now(), lastNonce + 1));

type Status = { filled?: { totalSz: string; avgPx: string; oid: number }; resting?: { oid: number }; error?: string } | string;
async function exchange(key: string, action: Record<string, unknown>): Promise<{ statuses: Status[] }> {
  const n = nonce();
  const signature = await signL1Action(key, action, n, true);
  const r = await post<{ status: string; response?: { type?: string; data?: { statuses?: Status[] } } | string }>("/exchange", { action, nonce: n, signature, vaultAddress: null, expiresAfter: null }, 1);
  if (r.status !== "ok") throw new Error(`Hyperliquid a refusé : ${typeof r.response === "string" ? r.response : JSON.stringify(r.response).slice(0, 150)}`);
  return { statuses: typeof r.response === "object" ? r.response?.data?.statuses ?? [] : [] };
}
const firstError = (s: Status[]) => s.map((x) => (typeof x === "string" ? null : x.error)).find(Boolean);

/** Levier en marge ISOLÉE : chaque position a sa propre marge, une liquidation ne touche qu'elle. */
export async function hlSetLeverage(key: string, asset: HlAsset, leverage: number) {
  const lev = Math.max(1, Math.min(asset.maxLeverage, Math.floor(leverage)));
  await exchange(key, { type: "updateLeverage", asset: asset.index, isCross: false, leverage: lev });
  return lev;
}

export interface HlFillResult { size: number; avgPx: number; oid: number }
/** Ordre au marché (limite IOC avec 1 % de marge). Renvoie ce qui a réellement été exécuté. */
export async function hlMarketOrder(key: string, asset: HlAsset, isBuy: boolean, size: number, refPx: number, reduceOnly = false): Promise<HlFillResult> {
  const sz = roundSize(size, asset.szDecimals);
  if (!(sz > 0)) throw new Error(`taille trop petite pour ${asset.name}`);
  const px = roundPrice(refPx * (isBuy ? 1 + HL_RULES.slippage : 1 - HL_RULES.slippage), asset.szDecimals);
  const { statuses } = await exchange(key, { type: "order", orders: [{ a: asset.index, b: isBuy, p: floatToWire(px), s: floatToWire(sz), r: reduceOnly, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
  const err = firstError(statuses);
  if (err) throw new Error(`ordre ${asset.name} refusé : ${err}`);
  const f = statuses.map((x) => (typeof x === "string" ? undefined : x.filled)).find(Boolean);
  if (!f) throw new Error(`ordre ${asset.name} non exécuté (pas de contrepartie à moins de 1 %)`);
  return { size: Number(f.totalSz), avgPx: Number(f.avgPx), oid: f.oid };
}

/** Stop posé CHEZ Hyperliquid (déclencheur « au marché », réduction seulement) : il protège même si le serveur tombe. */
export async function hlPlaceStop(key: string, asset: HlAsset, side: "long" | "short", size: number, triggerPx: number): Promise<number> {
  const isBuy = side === "short"; // on ferme un short en achetant
  const trig = roundPrice(triggerPx, asset.szDecimals);
  const limit = roundPrice(trig * (isBuy ? 1 + HL_RULES.stopSlippage : 1 - HL_RULES.stopSlippage), asset.szDecimals);
  const { statuses } = await exchange(key, { type: "order", orders: [{ a: asset.index, b: isBuy, p: floatToWire(limit), s: floatToWire(roundSize(size, asset.szDecimals)), r: true,
    t: { trigger: { isMarket: true, triggerPx: floatToWire(trig), tpsl: "sl" } } }], grouping: "na" });
  const err = firstError(statuses);
  if (err) throw new Error(`stop ${asset.name} refusé : ${err}`);
  const s = statuses[0];
  const oid = typeof s === "object" ? s.resting?.oid ?? s.filled?.oid : undefined;
  if (!oid) throw new Error(`stop ${asset.name} : numéro d'ordre absent`);
  return oid;
}

export async function hlCancel(key: string, asset: HlAsset, oid: number) {
  const { statuses } = await exchange(key, { type: "cancel", cancels: [{ a: asset.index, o: oid }] });
  const err = firstError(statuses);
  if (err && !/already|never placed|not found/i.test(err)) throw new Error(`annulation ${asset.name} : ${err}`);
}
