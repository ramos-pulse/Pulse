// Serveur uniquement : agents qui travaillent sur les données on-chain de Solana.
//  - SÉLECTIONNEUR : chaque jour, les 20 à 30 meilleurs tokens Solana selon des filtres stricts ; retrait automatique.
//  - NOUVEAUX TOKENS : repère les tokens tout juste lancés qui passent des garde-fous anti-arnaque très stricts.
//  - ARBITRAGE (éclaireur, sans argent) : mesure les écarts de prix entre DEX et les boucles de swaps, frais déduits.
// Les filtres sont des fonctions pures (testées) ; les appels réseau sont à part.
import { dexPairs, type DexPair } from "./dex.ts";
import { getQuote } from "./jupiter.ts";
import { SOL_MINT, USDC_MINT } from "./strategy.ts";

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const JUP = "https://lite-api.jup.ag";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const STABLES = new Set([USDC_MINT, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA"]);
const WRAPPED_SOL = new Set([SOL_MINT, "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v"]);

export interface JupToken {
  id: string; symbol: string; name?: string; decimals: number; tokenProgram?: string; isVerified?: boolean; tags?: string[]; organicScore?: number;
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; topHoldersPercentage?: number };
  firstPool?: { id?: string; createdAt?: string }; liquidity?: number; stats24h?: { buyVolume?: number; sellVolume?: number };
}
export async function jupTokens(mints: string[]): Promise<Map<string, JupToken>> {
  const out = new Map<string, JupToken>();
  for (let i = 0; i < mints.length; i += 20) { // petits lots : la recherche Jupiter limite le nombre de résultats renvoyés
    if (i) await new Promise((res) => setTimeout(res, 700)); // espacer les appels
    const r = await fetchRetry(`${JUP}/tokens/v2/search?query=${mints.slice(i, i + 20).join(",")}`);
    if (!r.ok) throw new Error(`Jupiter tokens indisponible (${r.status})`);
    for (const t of (await r.json()) as JupToken[]) if (t?.id) out.set(t.id, t);
  }
  return out;
}

interface GtPool { id: string; attributes: { address: string; name: string; reserve_in_usd: string; pool_created_at: string; volume_usd: { h1?: string; h24?: string }; price_change_percentage?: { h1?: string; h24?: string }; transactions?: { h1?: { buys: number; sells: number }; h24?: { buys: number; sells: number } } };
  relationships: { base_token: { data: { id: string } }; quote_token: { data: { id: string } } } }
async function gtPools(path: string, pages: number): Promise<GtPool[]> {
  const out: GtPool[] = [];
  for (let p = 1; p <= pages; p++) {
    if (p > 1) await new Promise((res) => setTimeout(res, 600));
    const r = await fetchRetry(`${GT}/${path}${path.includes("?") ? "&" : "?"}page=${p}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`GeckoTerminal indisponible (${r.status})`);
    out.push(...(((await r.json()) as { data?: GtPool[] }).data ?? []));
  }
  return out;
}
const mintOf = (id: string) => id.replace(/^solana_/, "");
/** Les API gratuites limitent le nombre d'appels (et l'adresse de Supabase est partagée) : on patiente et on réessaie. */
async function fetchRetry(url: string, init: RequestInit = {}, tries = 4): Promise<Response> {
  for (let k = 0; ; k++) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
    if ((r.status !== 429 && r.status < 500) || k >= tries - 1) return r;
    await new Promise((res) => setTimeout(res, 1500 * (k + 1) + Math.random() * 500));
  }
}

// ---------------------------------------------------------------------------------------------------
// SÉLECTIONNEUR
// ---------------------------------------------------------------------------------------------------
/** Filtres stricts du sélectionneur. */
export const SELECT = { minLiquidity: 1_000_000, minVolume24h: 1_000_000, minAgeDays: 30, keep: 25, max: 30 };
export interface Candidate { mint: string; symbol: string; decimals: number; pool: string; liquidity: number; volume24h: number; ageDays: number; why?: string }

/** Un token passe-t-il les filtres ? Renvoie null s'il passe, sinon la raison du refus. */
export function selectionRefusal(c: Candidate, j: JupToken | undefined): string | null {
  if (!j) return "inconnu de Jupiter";
  if (!isVerified(j)) return "non vérifié par Jupiter";
  if (j.tokenProgram && j.tokenProgram !== TOKEN_PROGRAM) return "programme de token non standard (Token-2022)";
  if (j.audit?.mintAuthorityDisabled !== true) return "émission de nouveaux jetons encore possible";
  if (j.audit?.freezeAuthorityDisabled !== true) return "gel des comptes encore possible";
  if (c.liquidity < SELECT.minLiquidity) return `liquidité ${Math.round(c.liquidity / 1000)} k$ < 1 M$`;
  if (c.volume24h < SELECT.minVolume24h) return `volume 24 h ${Math.round(c.volume24h / 1000)} k$ < 1 M$`;
  if (c.ageDays < SELECT.minAgeDays) return `trop récent (${Math.floor(c.ageDays)} jours < 30)`;
  return null;
}

const isVerified = (j: JupToken) => j.isVerified === true || !!j.tags?.some((t) => t === "verified" || t === "strict");

/**
 * Candidats : les 100 tokens les plus échangés sur 24 h selon Jupiter (vérification, audit, liquidité et volume inclus).
 * Le pool le plus liquide (pour l'historique de prix) est trouvé ensuite sur DexScreener. Secours : GeckoTerminal.
 */
export async function selectionCandidates(exclude: Set<string>): Promise<{ candidates: Candidate[]; info: Map<string, JupToken> }> {
  const info = new Map<string, JupToken>(), by = new Map<string, Candidate>();
  try {
    const r = await fetchRetry(`${JUP}/tokens/v2/toptraded/24h?limit=100`);
    if (!r.ok) throw new Error(`Jupiter top (${r.status})`);
    for (const j of (await r.json()) as JupToken[]) {
      if (!j?.id || exclude.has(j.id) || STABLES.has(j.id) || WRAPPED_SOL.has(j.id)) continue;
      info.set(j.id, j);
      const age = j.firstPool?.createdAt ? (Date.now() - Date.parse(j.firstPool.createdAt)) / 86_400_000 : 0;
      by.set(j.id, { mint: j.id, symbol: j.symbol, decimals: j.decimals, pool: "", liquidity: j.liquidity ?? 0, volume24h: (j.stats24h?.buyVolume ?? 0) + (j.stats24h?.sellVolume ?? 0), ageDays: age });
    }
  } catch { /* secours ci-dessous */ }
  if (!by.size) {
    const pools = await gtPools("pools?sort=h24_volume_usd_desc", 5);
    for (const p of pools) {
      const mint = mintOf(p.relationships.base_token.data.id);
      if (exclude.has(mint) || STABLES.has(mint) || WRAPPED_SOL.has(mint)) continue;
      const liq = Number(p.attributes.reserve_in_usd) || 0, vol = Number(p.attributes.volume_usd.h24) || 0, age = (Date.now() - Date.parse(p.attributes.pool_created_at)) / 86_400_000;
      const cur = by.get(mint);
      if (!cur) by.set(mint, { mint, symbol: "", decimals: 0, pool: p.attributes.address, liquidity: liq, volume24h: vol, ageDays: age });
      else { if (liq > cur.liquidity) cur.pool = p.attributes.address; cur.liquidity += liq; cur.volume24h += vol; cur.ageDays = Math.max(cur.ageDays, age); }
    }
    for (const [m, j] of await jupTokens([...by.keys()])) info.set(m, j);
    for (const c of by.values()) { const j = info.get(c.mint); if (j) { c.symbol = j.symbol; c.decimals = j.decimals; if (j.firstPool?.createdAt) c.ageDays = Math.max(c.ageDays, (Date.now() - Date.parse(j.firstPool.createdAt)) / 86_400_000); } }
  }
  return { candidates: [...by.values()], info };
}

/** Pool le plus liquide de chaque token (pour l'historique de prix GeckoTerminal). */
export async function bestPools(mints: string[]): Promise<Record<string, string>> {
  const out: Record<string, { a: string; l: number }> = {};
  for (const p of await dexPairs(mints).catch(() => [] as DexPair[])) {
    const m = mints.find((x) => p.baseToken?.address === x);
    if (m && (p.liquidity?.usd ?? 0) > (out[m]?.l ?? 0)) out[m] = { a: p.pairAddress, l: p.liquidity?.usd ?? 0 };
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.a]));
}

/** Classe les candidats qui passent et garde les 20 à 30 meilleurs (volume × liquidité). */
export function rankSelection(cands: Candidate[], info: Map<string, JupToken>) {
  const ok: Candidate[] = [], refused: Candidate[] = [];
  for (const c of cands) { const why = selectionRefusal(c, info.get(c.mint)); if (why) refused.push({ ...c, why }); else ok.push(c); }
  ok.sort((a, b) => Math.sqrt(b.volume24h * b.liquidity) - Math.sqrt(a.volume24h * a.liquidity));
  return { selected: ok.slice(0, SELECT.keep), refused };
}

// ---------------------------------------------------------------------------------------------------
// NOUVEAUX TOKENS : garde-fous anti-arnaque
// ---------------------------------------------------------------------------------------------------
export const FRESH = {
  minAgeMin: 30, maxAgeH: 24,           // ni les toutes premières minutes (pièges), ni plus d'un jour
  minLiquidity: 50_000, minVolume1h: 20_000, minSells1h: 20, // il faut pouvoir REVENDRE : des ventes réelles doivent passer
  maxTopHolders: 30,                    // les 10 plus gros portefeuilles ≤ 30 % du total
  minChange1h: 5, maxChange1h: 60,      // élan, mais pas une fusée déjà partie
  // gestion d'une position : toute petite mise, sortie rapide
  stakePct: 0.05, minStakeUsd: 2, maxStakeUsd: 5, maxShareOfEquity: 0.2, stopPct: 0.2, targetPct: 0.4, maxHoldMs: 4 * 3_600_000, maxPerDay: 3,
};
export interface Fresh { program?: "2022"; mint: string; symbol: string; decimals: number; pool: string; liquidity: number; volume1h: number; change1h: number; buys1h: number; sells1h: number; ageMin: number; topHolders?: number }

/** Seuils assouplis du mode « extra souple » (les contrôles anti-arnaque restent les mêmes). */
export const FRESH_SOFT = { minLiquidity: 25_000, minVolume1h: 10_000, minSells1h: 10, maxTopHolders: 40, minChange1h: 0, maxChange1h: 100 };
export function freshRefusal(f: Fresh, j: JupToken | undefined, soft = false): string | null {
  const F = soft ? { ...FRESH, ...FRESH_SOFT } : FRESH;
  if (!j) return "inconnu de Jupiter";
  if (j.tokenProgram && j.tokenProgram !== TOKEN_PROGRAM && j.tokenProgram !== TOKEN_2022) return "programme de token inconnu";
  if (j.audit?.mintAuthorityDisabled !== true) return "émission de nouveaux jetons possible";
  if (j.audit?.freezeAuthorityDisabled !== true) return "gel des comptes possible (piège classique)";
  const top = j.audit?.topHoldersPercentage;
  if (top == null || top > F.maxTopHolders) return `concentration : les gros portefeuilles détiennent ${top == null ? "?" : Math.round(top)} %`;
  if (f.ageMin < FRESH.minAgeMin) return "trop jeune (moins de 30 min)";
  if (f.ageMin > FRESH.maxAgeH * 60) return "plus si nouveau";
  if (f.liquidity < F.minLiquidity) return `liquidité ${Math.round(f.liquidity / 1000)} k$ < ${F.minLiquidity / 1000} k$`;
  if (f.volume1h < F.minVolume1h) return "trop peu d'échanges";
  if (f.sells1h < F.minSells1h) return "presque aucune vente réussie (risque de piège à acheteurs)";
  if (f.change1h < F.minChange1h || f.change1h > F.maxChange1h) return `variation 1 h ${Math.round(f.change1h)} % hors de la zone ${F.minChange1h}-${F.maxChange1h} %`;
  if (!soft && f.buys1h <= f.sells1h) return "plus de vendeurs que d'acheteurs";
  return null;
}

export async function freshCandidates(exclude: Set<string>, soft = false): Promise<{ list: Fresh[]; info: Map<string, JupToken> }> {
  const pools = await gtPools("new_pools", 2);
  const list: Fresh[] = [];
  for (const p of pools) {
    const mint = mintOf(p.relationships.base_token.data.id), quote = mintOf(p.relationships.quote_token.data.id);
    if (exclude.has(mint) || STABLES.has(mint) || WRAPPED_SOL.has(mint) || !(quote === SOL_MINT || STABLES.has(quote))) continue;
    const t = p.attributes.transactions?.h1;
    list.push({ mint, symbol: p.attributes.name.split(" / ")[0] ?? "?", decimals: 0, pool: p.attributes.address, liquidity: Number(p.attributes.reserve_in_usd) || 0,
      volume1h: Number(p.attributes.volume_usd.h1) || 0, change1h: Number(p.attributes.price_change_percentage?.h1) || 0, buys1h: t?.buys ?? 0, sells1h: t?.sells ?? 0,
      ageMin: (Date.now() - Date.parse(p.attributes.pool_created_at)) / 60_000 });
  }
  const F = soft ? FRESH_SOFT : FRESH;
  const pre = list.filter((f) => f.liquidity >= F.minLiquidity && f.sells1h >= F.minSells1h).slice(0, 40);
  const info = pre.length ? await jupTokens(pre.map((f) => f.mint)) : new Map<string, JupToken>();
  for (const f of pre) { const j = info.get(f.mint); if (j) { f.symbol = j.symbol; f.decimals = j.decimals; f.topHolders = j.audit?.topHoldersPercentage; if (j.tokenProgram === TOKEN_2022) f.program = "2022"; } }
  return { list: pre, info };
}

/** Mise de l'agent nouveaux tokens : 5 % du capital (2 à 5 $), jamais plus de 20 % du capital. 0 = pas de mise possible. */
export function freshStake(equity: number): number {
  const s = Math.min(FRESH.maxStakeUsd, Math.max(FRESH.minStakeUsd, equity * FRESH.stakePct));
  return s <= equity * FRESH.maxShareOfEquity ? s : 0;
}

// ---------------------------------------------------------------------------------------------------
// ARBITRAGE (éclaireur, aucun argent engagé)
// ---------------------------------------------------------------------------------------------------
/** Frais estimés d'un aller-retour : 2 swaps (~0,25 % chacun en moyenne sur les pools concernés) + frais de réseau. */
export const ARB = { poolFee: 0.0025, txUsd: 0.004, sizeUsd: 20, minLiquidity: 50_000 };
export interface ArbObs { kind: "écart" | "boucle"; token: string; detail: string; grossPct: number; netPct: number }

/** Écart de prix d'un même token entre DEX (pools assez liquides), frais déduits. */
export function dexSpread(symbol: string, pairs: DexPair[], mint: string): ArbObs | null {
  const ok = pairs.filter((p) => p.baseToken?.address === mint && (p.liquidity?.usd ?? 0) >= ARB.minLiquidity && Number(p.priceUsd) > 0);
  if (ok.length < 2) return null;
  ok.sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd));
  const lo = ok[0]!, hi = ok[ok.length - 1]!, gross = Number(hi.priceUsd) / Number(lo.priceUsd) - 1;
  const net = gross - 2 * ARB.poolFee - (2 * ARB.txUsd) / ARB.sizeUsd;
  return { kind: "écart", token: symbol, detail: `acheter sur ${lo.dexId} (${lo.priceUsd} $), revendre sur ${hi.dexId} (${hi.priceUsd} $)`, grossPct: gross * 100, netPct: net * 100 };
}

/** Boucle USDC → token → USDC cotée par Jupiter (le meilleur chemin, tous DEX confondus), frais compris. */
export async function loop(symbol: string, mint: string, decimals: number): Promise<ArbObs | null> {
  const amount = BigInt(ARB.sizeUsd * 1e6);
  const there = await getQuote(USDC_MINT, mint, amount, 30);
  const back = await getQuote(mint, USDC_MINT, BigInt(there.outAmount), 30);
  const gross = Number(back.outAmount) / Number(amount) - 1;
  void decimals;
  return { kind: "boucle", token: symbol, detail: `USDC → ${symbol} → USDC sur ${ARB.sizeUsd} $`, grossPct: gross * 100, netPct: (gross - (2 * ARB.txUsd) / ARB.sizeUsd) * 100 };
}

export async function arbScan(tokens: { symbol: string; mint: string; decimals: number }[], loopsPerCycle: number, offset: number): Promise<ArbObs[]> {
  const out: ArbObs[] = [];
  const pairs = await dexPairs(tokens.map((t) => t.mint)).catch(() => [] as DexPair[]);
  for (const t of tokens) { const o = dexSpread(t.symbol, pairs, t.mint); if (o) out.push(o); }
  for (let k = 0; k < loopsPerCycle && tokens.length; k++) {
    const t = tokens[(offset + k) % tokens.length]!;
    if (t.mint === USDC_MINT) continue;
    const o = await loop(t.symbol, t.mint, t.decimals).catch(() => null);
    if (o) out.push(o);
  }
  return out;
}
