import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStats, familyWeights, mathShare, pickMarket, recordCycle, VALID, type Market } from "../supabase/functions/pulse/engine/research.ts";

const mk = (product: string, interval: "1h" | "15m" = "1h"): Market => ({ name: product, product, symbol: product, kind: "spot", interval, feePct: 0.001, hourlyCost: 0, cap: 1 });

test("répartition : une famille qui échoue toujours garde 5 %, celle qui trouve prend plus de temps", () => {
  const st = emptyStats(), m = mk("SOL-USD");
  const rows = [...Array(200)].map(() => ({ family: "rsi" as const, verdict: "rejetée", origin: "chercheur" }))
    .concat([...Array(100)].map((_, i) => ({ family: "squeeze" as const, verdict: i < 15 ? "prometteuse" : "rejetée", origin: "chercheur" })));
  recordCycle(st, m, rows, Date.now());
  const w = familyWeights(st, "spot", "1h", ["tendance", "rsi", "orb", "vwap", "squeeze", "volume"]);
  assert.ok(w.rsi! >= 0.049 && w.rsi! < 0.08, `RSI ${w.rsi}`);
  assert.ok(w.squeeze! > 0.2, `compression ${w.squeeze}`);
  assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b!, 0) - 1) < 1e-9);
});

test("répartition : le marché le moins récemment étudié passe d'abord, un marché indisponible ne bloque pas", () => {
  const st = emptyStats(), now = Date.now(), A = mk("A"), B = mk("B"), C = mk("C");
  recordCycle(st, A, [], now - 10 * 3_600_000);
  recordCycle(st, B, [], now - 1 * 3_600_000);
  recordCycle(st, C, [], now - 5 * 3_600_000);
  assert.equal(pickMarket([A, B, C], st, now, () => 0.5).product, "A");
  recordCycle(st, A, [], now); // visité (même sans résultat : historique indisponible)
  assert.equal(pickMarket([A, B, C], st, now, () => 0.5).product, "C");
  // jamais étudié : prioritaire
  assert.equal(pickMarket([A, B, C, mk("D")], st, now, () => 0.5).product, "D");
});

test("répartition : le mathématicien garde entre 15 et 50 % du temps", () => {
  const st = emptyStats(), m = mk("X", "15m");
  recordCycle(st, m, [...Array(110)].map(() => ({ family: "vwap" as const, verdict: "rejetée", origin: "mathématicien" }))
    .concat([...Array(100)].map((_, i) => ({ family: "squeeze" as const, verdict: i < 10 ? "prometteuse" : "rejetée", origin: "chercheur" }))), Date.now());
  const s = mathShare(st, "spot", "15m");
  assert.ok(s >= 0.15 && s < 0.3, `part ${s}`);
  assert.equal(mathShare(emptyStats(), "perps", "1h"), 0.5);
});

test("validation : 8 trades sur la période jamais vue pour « prometteuse »", () => {
  assert.equal(VALID.minTestTrades, 8);
});
