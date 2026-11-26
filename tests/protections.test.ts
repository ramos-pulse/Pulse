import { test } from "node:test";
import assert from "node:assert/strict";
import { addToVault, loadConfig, loadMemory, loadPerpsConfig, marketFilter, migratePositions, sampleCurve, tradable, type Candle } from "../supabase/functions/pulse/engine/strategy.ts";
import { luckProbability, normCdf } from "../supabase/functions/pulse/engine/math.ts";

test("reprise de l'ancien format : la position en cours garde son stop et sa stratégie", () => {
  const mem = loadMemory({ v: 3, stop: 1.9, best: 2.1, initialRisk: 0.1, asset: "WIF", strategy: "tendance", posInterval: "15m", source: "chercheur #5", costUsd: 40, openedAt: 123 });
  const pos = migratePositions(mem, { kind: "spot", position_mint: "MINTWIF", entry_price: 2 });
  assert.deepEqual(Object.keys(pos), ["MINTWIF"]);
  assert.equal(pos.MINTWIF!.stop, 1.9); assert.equal(pos.MINTWIF!.costUsd, 40); assert.equal(pos.MINTWIF!.posInterval, "15m"); assert.equal(pos.MINTWIF!.entry, 2);
  assert.equal(mem.stop, undefined, "anciens champs à plat retirés");
  const perps = migratePositions(loadMemory({ v: 3, stop: 140, asset: "SOL", side: "long" }), { kind: "perps", position_side: "short", position_asset: "ETH", position_pubkey: "PK", entry_price: 3000 });
  assert.equal(perps.ETH!.side, "short"); assert.equal(perps.ETH!.pubkey, "PK");
  assert.deepEqual(migratePositions(loadMemory({ v: 3 }), { kind: "spot", position_mint: null }), {});
});
test("coffre : seule une part des GAINS y va ; il est exclu du capital tradable", () => {
  assert.equal(addToVault(0, 10, 25), 2.5); assert.equal(addToVault(2.5, -4, 25), 2.5, "une perte ne vide pas le coffre"); assert.equal(addToVault(undefined, 10, 0), 0);
  assert.deepEqual(tradable(100, 60, 10), { equity: 90, usdc: 50, vault: 10 });
  assert.deepEqual(tradable(100, 5, 10), { equity: 95, usdc: 0, vault: 5 }, "coffre plafonné à l'USDC présent");
});
test("courbe du capital : un point par heure au plus, 30 jours gardés", () => {
  const mem = loadMemory(null);
  sampleCurve(mem, 100, 0); sampleCurve(mem, 101, 60_000); sampleCurve(mem, 102, 3_600_000);
  assert.deepEqual(mem.curve, [{ t: 0, v: 101 }, { t: 3_600_000, v: 102 }]);
  for (let i = 2; i < 800; i++) sampleCurve(mem, 100 + i, i * 3_600_000);
  assert.equal(mem.curve!.length, 720);
});
test("filtre BTC : bloque une chute forte, laisse passer un marché calme", () => {
  const mk = (f: (i: number) => number) => Array.from({ length: 230 }, (_, i): Candle => ({ t: i * 3_600_000, o: f(i), h: f(i), l: f(i), c: f(i) }));
  assert.equal(marketFilter(mk(() => 100)).blocked, false);
  assert.equal(marketFilter(mk((i) => (i < 205 ? 100 : 100 - (i - 205) * 0.3))).blocked, true, "−7 % en 24 h");
  assert.equal(marketFilter(mk((i) => (i < 205 ? 100 : 100 - (i - 205) * 0.17))).blocked, true, "−4 % sous la moyenne 200 h");
  assert.equal(marketFilter(mk((i) => (i < 205 ? 80 + i * 0.2 : 121 - (i - 205) * 0.17))).blocked, false, "−4 % mais au-dessus de la moyenne : passe");
});
test("chance ou talent : un résultat solide est du talent, un résultat fragile parmi des milliers d'essais est de la chance", () => {
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3 && Math.abs(normCdf(0) - 0.5) < 1e-6);
  const strong = luckProbability({ trades: 40, meanPct: 1, sdPct: 1.5 }, 200)!; // t ≈ 4,2
  const weak = luckProbability({ trades: 6, meanPct: 0.5, sdPct: 2 }, 5000)!;   // t ≈ 0,6 parmi 5000 essais
  assert.ok(strong < 0.05, `fort : ${strong}`); assert.ok(weak > 0.9, `faible : ${weak}`);
  assert.equal(luckProbability({ trades: 6, meanPct: -0.2, sdPct: 1 }, 10), 1, "une stratégie perdante n'a aucun talent");
  assert.equal(luckProbability({ trades: 6 }, 10), null, "anciennes stratégies sans données : pas de jugement");
});
test("protections : réglages bornés et valeurs par défaut", () => {
  const c = loadConfig({ maxPositions: 9, vaultPct: 33, breakerPct: 12 });
  assert.equal(c.maxPositions, 3); assert.equal(c.vaultPct, 25); assert.equal(c.breakerPct, 15); assert.equal(c.marketFilter, true); assert.equal(c.partialTp, true);
  assert.equal(loadConfig({ breakerPct: 0 }).breakerPct, 0, "disjoncteur coupable");
  const p = loadPerpsConfig({ plan: { asset: "ETH", params: { breakout: 24, trailAtr: 3, minTrend: 1 }, interval: "1h", source: "x" } });
  assert.equal(p.plans.length, 1); assert.equal(p.plan?.asset, "ETH", "ancien plan unique repris dans la liste");
  const many = loadPerpsConfig({ plans: ["SOL", "ETH", "SOL", "BTC", "ETH"].map((asset) => ({ asset, params: { breakout: 24, trailAtr: 3, minTrend: 1 }, interval: "1h", source: asset })) });
  assert.deepEqual(many.plans.map((x) => x.asset), ["SOL", "ETH", "BTC"], "une stratégie par marché, 3 au maximum");
});
