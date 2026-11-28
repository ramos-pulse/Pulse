import { test } from "node:test";
import assert from "node:assert/strict";
import { backtestSetup, expectedMove, sanitizeSetup, setupExit, setupSignal, type RebondParams } from "../supabase/functions/pulse/engine/setups.ts";
import { cooldownMs, REBOND_COOLDOWN_MS, SPOT_COOLDOWN_MS, type Candle } from "../supabase/functions/pulse/engine/strategy.ts";
import { FAMILIES, simulate, type Market } from "../supabase/functions/pulse/engine/research.ts";

// marché calme qui oscille (bougies de 15 min), avec des chutes anormales régulières suivies d'un rebond
function series(n: number, shockEvery = 40, rebound = true): Candle[] {
  const out: Candle[] = []; let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p, shock = i > 60 && i % shockEvery === 0, after = i > 60 && i % shockEvery === 1;
    const c = shock ? o * 0.97 : after && rebound ? o * 1.02 : o * (1 + 0.002 * Math.sin(i));
    out.push({ t: 1_790_000_000_000 + i * 900_000, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1000 });
    p = c;
  }
  return out;
}
const P: RebondParams = { drop: 3, target: 0.5, stopAtr: 2, hold: 4 };

test("rebond : une chute anormale donne un achat avec objectif de retour partiel ; une bougie normale rien", () => {
  const c = series(241); // la dernière bougie (i = 240) est une chute de 3 %
  const sig = setupSignal("rebond", c, false, P);
  assert.equal(sig.side, "long", sig.reason);
  assert.ok(sig.target! > sig.price && sig.stop < sig.price);
  assert.ok(Math.abs(sig.target! - (sig.price + 0.5 * (c.at(-1)!.o - c.at(-1)!.c))) < 1e-9);
  assert.equal(setupSignal("rebond", c.slice(0, -2), false, P).side, null);
  assert.equal(setupExit("rebond", c, "long", P, 4, 0), "rebond_temps");
  assert.equal(setupExit("rebond", c, "long", P, 3, 0), null);
});

test("rebond : réglages absurdes bornés, famille proposée au bot 1", () => {
  assert.equal(sanitizeSetup("rebond", { drop: "x", target: 0.5, stopAtr: 1, hold: 4 }), null);
  assert.deepEqual(sanitizeSetup("rebond", { drop: 50, target: 9, stopAtr: 0.1, hold: 6 }), { drop: 8, target: 1.5, stopAtr: 0.5, hold: 6 });
  assert.ok(FAMILIES.spot.includes("rebond"));
});

test("« ça vaut les frais » : le backtest refuse les entrées dont l'objectif vaut moins de 4 fois l'aller-retour", () => {
  const c = series(1200);
  const cheap = backtestSetup("rebond", c, P, { allowShort: false, feePct: 0.0005, partial: "half" });
  const gated = backtestSetup("rebond", c, P, { allowShort: false, feePct: 0.0005, partial: "half", minEdge: 0.05 }); // 5 % exigés : aucun rebond ne vaut ça
  assert.ok(cheap.trades > 5, `${cheap.trades} trades`);
  assert.equal(gated.trades, 0);
  assert.ok(Math.abs(expectedMove({ price: 100, target: 101.5 }) - 0.015) < 1e-12);
  assert.equal(expectedMove({ price: 100 }), Infinity); // stop suiveur : pas concerné
});

test("rebond : pause de 5 min après une perte (15 min pour les autres stratégies du bot 1), même règle en backtest", () => {
  assert.equal(cooldownMs("15m", "spot", "rebond"), REBOND_COOLDOWN_MS);
  assert.equal(cooldownMs("15m", "spot", "squeeze"), SPOT_COOLDOWN_MS);
  const m: Market = { name: "Spot SOL · 15 min", product: "SOL-USD", symbol: "SOL", kind: "spot", interval: "15m", feePct: 0.0005, hourlyCost: 0, cap: 1 };
  const r = simulate({ market: m.name, product: m.product, symbol: "SOL", kind: "spot", interval: "15m", family: "rebond", params: P }, series(1200), m);
  assert.ok(r.trades > 5 && r.profitFactor > 1, `${r.trades} trades, PF ${r.profitFactor}`);
});

test("bot 2 : rebond dans les deux sens (envolée anormale → short), filtre de frais pour le rebond seulement", () => {
  assert.ok(FAMILIES.perps.includes("rebond"));
  const up = series(241).map((x) => ({ ...x, o: 200 - x.o, c: 200 - x.c, h: 200 - x.l, l: 200 - x.h })); // miroir : les chutes deviennent des envolées
  const sig = setupSignal("rebond", up, true, P);
  assert.equal(sig.side, "short", sig.reason);
  assert.ok(sig.target! < sig.price && sig.stop > sig.price);
  assert.equal(setupSignal("rebond", up, false, P).side, null); // sans short (bot 1) : rien
  const m: Market = { name: "Perps SOL · 15 min", product: "SOL-USD", symbol: "SOL", kind: "perps", interval: "15m", feePct: 0.0007, hourlyCost: 0.00002, cap: 10 };
  const cand = (f: "rebond" | "vwap", params: unknown) => ({ market: m.name, product: m.product, symbol: "SOL", kind: "perps" as const, interval: "15m" as const, family: f, params: params as RebondParams });
  const tiny: RebondParams = { drop: 3, target: 0.05, stopAtr: 2, hold: 4 }; // objectif minuscule : jamais 4 × les frais
  assert.equal(simulate(cand("rebond", tiny), series(1200), m).trades, 0);
  assert.ok(simulate(cand("rebond", P), series(1200), m).trades > 5);
});

test("bot 2 : jusqu'à 12 stratégies surveillées (8 avant), une par marché", async () => {
  const { loadPerpsConfig, PERPS_PLANS_MAX, perpsMarkets, setPerpsMarkets } = await import("../supabase/functions/pulse/engine/strategy.ts");
  assert.equal(PERPS_PLANS_MAX, 12);
  const before = [...perpsMarkets()];
  setPerpsMarkets([...Array(20)].map((_, i) => ({ asset: `C${i}`, candles: `hl:C${i}` })));
  const plans = [...Array(15)].map((_, i) => ({ asset: `C${i}`, params: { breakout: 24, trailAtr: 3, minTrend: 1 }, interval: "1h", source: "test", score: 1, confidence: "nouvelle" }));
  assert.equal(loadPerpsConfig({ plans }).plans.length, 12);
  setPerpsMarkets(before);
});
