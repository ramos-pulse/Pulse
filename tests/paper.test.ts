import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPaper, loadPaper, PAPER, venueFor, type Paper } from "../supabase/functions/pulse/engine/venue.ts";
import { SOL_MINT, USDC_MINT } from "../supabase/functions/pulse/engine/strategy.ts";

let solPrice = 100;
globalThis.fetch = (async (url: any) => {
  if (String(url).includes("market-stats")) return new Response(JSON.stringify({ price: String(solPrice) }));
  throw new Error("réseau interdit en paper : " + url);
}) as typeof fetch;
const admin = () => { const saved: { paper?: Paper } = {}; return { saved, store: { bot: () => ({}) as never, addTrade() {}, update: (_k: unknown, p: { paper: Paper }) => { saved.paper = p.paper; } } }; };

test("par défaut un bot est en paper ; un réglage « off » le remet en réel", () => {
  assert.equal(loadPaper(null).on, true); assert.equal(loadPaper({ on: false }).on, false);
  assert.equal(venueFor("spot", { paper: { on: false } }).paper, false);
  assert.equal(freshPaper(5).startUsd, PAPER.minUsd);
});
test("swap paper : rempli à la cotation réelle moins la marge de prudence, sans clé ni réseau", async () => {
  const a = admin(); const V = venueFor("spot", { paper: freshPaper(100) }, a.store as never);
  const w = await V.wallet(); assert.equal(w.address, "PAPER");
  // 50 USDC → 0,5 SOL coté
  const sig = await V.swap({ inputMint: USDC_MINT, outputMint: SOL_MINT, inAmount: "50000000", outAmount: "500000000", priceImpactPct: "0" }, w.address, w.keyPair);
  assert.match(sig, /^paper-/); assert.equal(await V.wait(sig), "confirmed");
  const b = await V.balances(w.address);
  assert.equal(b.usdc, 50); assert.ok(Math.abs(b.ui[SOL_MINT]! - 0.5 * (1 - PAPER.swapHaircut)) < 1e-9);
  assert.equal(a.saved.paper!.raw[USDC_MINT], "50000000", "portefeuille fictif enregistré");
  await assert.rejects(V.swap({ inputMint: USDC_MINT, outputMint: SOL_MINT, inAmount: "60000000", outAmount: "1", priceImpactPct: "0" }, w.address, w.keyPair), /insuffisant/);
});
test("perps paper : long x3, gain au vrai cours, frais déduits, fermeture", async () => {
  solPrice = 100; const a = admin(); const V = venueFor("perps", { paper: freshPaper(100) }, a.store as never);
  await V.open({ wallet: "PAPER", asset: "SOL", side: "long", usdcRaw: 20_000_000n, leverage: 3, stop: 95, slippageBps: 50 }, null as never);
  assert.equal((await V.balances("PAPER")).usdc, 80);
  solPrice = 110;
  const [pos] = await V.positions("PAPER");
  assert.ok(pos && pos.valueUsd > 25 && pos.valueUsd < 26, `valeur ${pos?.valueUsd}`); // 20 + 60 × ~9,9 % − frais
  await V.close(pos!.pubkey, 50, null as never);
  assert.equal((await V.positions("PAPER")).length, 0);
  const usdc = (await V.balances("PAPER")).usdc; assert.ok(usdc > 105 && usdc < 106, `usdc ${usdc}`);
});
test("perps paper : le stop de sécurité « on-chain » est simulé (la position disparaît, perte limitée)", async () => {
  solPrice = 100; const V = venueFor("perps", { paper: freshPaper(100) }, admin().store as never);
  await V.open({ wallet: "PAPER", asset: "SOL", side: "short", usdcRaw: 20_000_000n, leverage: 2, stop: 104, slippageBps: 50 }, null as never);
  solPrice = 120; // le cours a dépassé le stop
  assert.equal((await V.positions("PAPER")).length, 0);
  // perte au stop (~4 % × 40 $ + frais ≈ 1,7 $), et non au cours de 120 $ (qui aurait coûté ~8 $)
  const usdc = (await V.balances("PAPER")).usdc; assert.ok(usdc > 98 && usdc < 98.6, `usdc ${usdc}`);
});
