// LIEU D'EXÉCUTION des bots : réel (Solana + Jupiter) ou PAPER (portefeuille fictif, mêmes décisions, vrais prix).
// En paper, aucune transaction n'est envoyée et aucune clé n'est utilisée : les ordres sont « remplis » au prix
// réellement coté par Jupiter à cet instant (impact de prix compris), moins une marge de prudence, frais perps inclus.
import type { BotKind, BotState, Store } from "../store.ts";
import { executeSwap, perpsClose, perpsOpen, perpsPositions, perpsPrice, type PerpPosition, type Quote } from "./jupiter.ts";
import { getBalances, loadKeyPairFrom, txStatus, waitForTx, type Balances, type TxStatus } from "./solana.ts";
import { PERPS_ASSETS, SOL_MINT, TOKENS, USDC_MINT } from "./strategy.ts";

export type KeyPair = Awaited<ReturnType<typeof loadKeyPairFrom>>["keyPair"];
export interface PaperPos { pubkey: string; asset: string; side: "long" | "short"; entryPrice: number; sizeUsd: number; collateralUsd: number; openedAt: number; stop: number }
export interface Paper { on: boolean; startUsd: number; raw: Record<string, string>; positions: PaperPos[]; seq: number; since: string | null }

/** Hypothèses de simulation, volontairement un peu pessimistes : mieux vaut être déçu en paper qu'en réel. */
export const PAPER = { defaultUsd: 100, minUsd: 10, maxUsd: 100_000, swapHaircut: 0.001, perpsFee: 0.0006, perpsSlip: 0.0005, borrowPerHour: 0.00002 };
export const PAPER_ADDRESS = "PAPER";

export function freshPaper(startUsd = PAPER.defaultUsd, on = true): Paper {
  const usd = Math.min(PAPER.maxUsd, Math.max(PAPER.minUsd, Number(startUsd) || PAPER.defaultUsd));
  return { on, startUsd: usd, raw: { [USDC_MINT]: String(Math.round(usd * 1e6)) }, positions: [], seq: 0, since: null };
}
/** Sans réglage enregistré, un bot démarre en paper : on ne risque jamais de l'argent par défaut. */
export function loadPaper(x: unknown): Paper {
  const o = (x && typeof x === "object" ? x : {}) as Partial<Paper>;
  const base = freshPaper(o.startUsd ?? PAPER.defaultUsd, o.on !== false);
  return { ...base, raw: o.raw && typeof o.raw === "object" ? { ...o.raw } : base.raw, positions: Array.isArray(o.positions) ? o.positions.map((p) => ({ ...p })) : [], seq: Number(o.seq) || 0, since: o.since ?? null };
}

export interface Venue {
  paper: boolean;
  wallet(): Promise<{ address: string; keyPair: KeyPair }>;
  balances(address: string): Promise<Balances>;
  swap(quote: Quote, address: string, keyPair: KeyPair): Promise<string>;
  wait(sig: string, ms?: number): Promise<TxStatus>;
  status(sig: string): Promise<TxStatus>;
  positions(address: string): Promise<PerpPosition[]>;
  open(p: Parameters<typeof perpsOpen>[0], keyPair: KeyPair): Promise<string>;
  close(pubkey: string, slippageBps: number, keyPair: KeyPair): Promise<string>;
}

const realVenue = (envKey: string): Venue => ({
  paper: false,
  wallet: () => loadKeyPairFrom(envKey),
  balances: getBalances,
  swap: executeSwap,
  wait: (s, ms) => waitForTx(s, ms),
  status: txStatus,
  positions: perpsPositions,
  open: perpsOpen,
  close: perpsClose,
});

const decimalsOf = (mint: string) => (mint === USDC_MINT ? 6 : mint === SOL_MINT ? 9 : TOKENS.find((t) => t.mint === mint)?.decimals ?? 6);
const big = (x: string | undefined) => { try { return BigInt(x ?? "0"); } catch { return 0n; } };

/** Le lieu d'exécution d'un bot. `admin` permet d'enregistrer le portefeuille fictif après chaque ordre simulé. */
export function venueFor(kind: BotKind, bot: Pick<BotState, "paper">, admin?: Store | null): Venue {
  const envKey = kind === "spot" ? "BOT_WALLET_PRIVATE_KEY" : "PERPS_WALLET_PRIVATE_KEY";
  const st = loadPaper(bot.paper);
  if (!st.on) return realVenue(envKey);
  const persist = () => admin?.update(kind, { paper: st });
  const add = (mint: string, delta: bigint) => {
    const v = big(st.raw[mint]) + delta;
    if (v < 0n) throw new Error("solde fictif insuffisant");
    st.raw[mint] = v.toString();
  };
  const usdc = () => Number(big(st.raw[USDC_MINT])) / 1e6;
  const sig = (what: string) => `paper-${what}-${Date.now()}-${++st.seq}`;
  const assetMint = (a: string) => PERPS_ASSETS.find((x) => x.asset === a)?.mint ?? SOL_MINT;
  const valueOf = (p: PaperPos, price: number) => {
    const move = p.side === "long" ? price / p.entryPrice - 1 : 1 - price / p.entryPrice;
    const hours = (Date.now() - p.openedAt) / 3_600_000;
    return Math.max(0, p.collateralUsd + p.sizeUsd * move - p.sizeUsd * PAPER.perpsFee - p.sizeUsd * PAPER.borrowPerHour * hours);
  };
  const settle = (p: PaperPos, price: number) => {
    add(USDC_MINT, BigInt(Math.floor(valueOf(p, price) * 1e6)));
    st.positions = st.positions.filter((x) => x.pubkey !== p.pubkey);
  };

  return {
    paper: true,
    wallet: async () => ({ address: PAPER_ADDRESS, keyPair: null as unknown as KeyPair }),
    balances: async () => {
      const raw: Record<string, bigint> = {}, ui: Record<string, number> = {};
      for (const [mint, v] of Object.entries(st.raw)) { raw[mint] = big(v); ui[mint] = Number(raw[mint]) / 10 ** decimalsOf(mint); }
      raw[SOL_MINT] = raw[SOL_MINT] ?? 0n; ui[SOL_MINT] = ui[SOL_MINT] ?? 0;
      return { sol: ui[SOL_MINT]!, raw, ui, usdc: ui[USDC_MINT] ?? 0 };
    },
    // le swap fictif est rempli à la cotation RÉELLE de Jupiter (impact compris), moins une marge de prudence
    swap: async (q) => {
      const inMint = String(q.inputMint ?? ""), outMint = String(q.outputMint ?? "");
      if (!inMint || !outMint) throw new Error("cotation sans jetons");
      const out = (big(q.outAmount) * BigInt(Math.round((1 - PAPER.swapHaircut) * 1e6))) / 1_000_000n;
      add(inMint, -big(q.inAmount)); add(outMint, out);
      persist();
      return sig("swap");
    },
    wait: async () => "confirmed",
    status: async () => "confirmed",
    // positions perps fictives, valorisées au vrai cours ; le stop de sécurité « on-chain » est simulé ici
    positions: async () => {
      const out: PerpPosition[] = [];
      let changed = false;
      for (const p of [...st.positions]) {
        const price = await perpsPrice(assetMint(p.asset));
        const hit = p.side === "long" ? price <= p.stop : price >= p.stop;
        if (hit || valueOf(p, price) <= 0) { settle(p, hit ? p.stop * (p.side === "long" ? 1 - PAPER.perpsSlip : 1 + PAPER.perpsSlip) : price); changed = true; continue; }
        out.push({ pubkey: p.pubkey, asset: p.asset, side: p.side, entryPrice: p.entryPrice, valueUsd: valueOf(p, price), sizeUsd: p.sizeUsd });
      }
      if (changed) persist();
      return out;
    },
    open: async (o) => {
      const collateral = Number(o.usdcRaw) / 1e6;
      if (collateral > usdc() + 1e-9) throw new Error("solde fictif insuffisant");
      const price = await perpsPrice(assetMint(o.asset));
      add(USDC_MINT, -o.usdcRaw);
      const entryPrice = price * (o.side === "long" ? 1 + PAPER.perpsSlip : 1 - PAPER.perpsSlip);
      const sizeUsd = collateral * o.leverage;
      st.positions.push({ pubkey: sig("pos"), asset: o.asset, side: o.side, entryPrice, sizeUsd, collateralUsd: collateral - sizeUsd * PAPER.perpsFee, openedAt: Date.now(), stop: o.stop });
      persist();
      return sig("open");
    },
    close: async (pubkey) => {
      const p = st.positions.find((x) => x.pubkey === pubkey);
      if (!p) throw new Error("position fictive introuvable");
      const price = await perpsPrice(assetMint(p.asset));
      settle(p, price * (p.side === "long" ? 1 - PAPER.perpsSlip : 1 + PAPER.perpsSlip));
      persist();
      return sig("close");
    },
  };
}
