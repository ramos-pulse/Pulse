import { test } from "node:test";
import assert from "node:assert/strict";
import { costChanged, costFromRoundTrip, COSTS, dueForMeasure, setSpotCosts, spotFee } from "../supabase/functions/pulse/engine/costs.ts";

test("frais réels : aller-retour coté → coût par côté (×1,5 + frais Solana, plancher 0,1 %)", () => {
  // SOL : on récupère 19,98 $ sur 20 $ (0,1 % aller-retour), SOL à 150 $
  const c = costFromRoundTrip(20, 19.98, 150)!;
  const tx = 50_000 / 1e9 * 150 / 5; // 0,15 % pour une mise de 5 $
  assert.ok(Math.abs(c.side - (0.0005 * 1.5 + tx)) < 1e-6, `coût ${c.side}`);
  assert.ok(c.side < 0.003, "moins cher que l'ancien coût fixe de 0,3 %");
  // petit token cher : 2 % aller-retour → 1,5 % par côté + frais Solana (bien plus que l'ancien 0,4 %)
  assert.ok(costFromRoundTrip(20, 19.6, 150)!.side > 0.015);
  // jamais sous le plancher
  assert.equal(costFromRoundTrip(20, 20, 0.001)!.side, COSTS.floor);
  // cotation absurde (on récupère plus que la mise) : ignorée
  assert.equal(costFromRoundTrip(20, 21, 150), null);
  assert.equal(costFromRoundTrip(20, 0, 150), null);
});

test("frais réels : utilisés par le chercheur seulement s'ils sont récents", () => {
  const now = Date.now();
  setSpotCosts({ SOL: { side: 0.002, roundTrip: 0.001, tx: 0.0015, at: now - 3_600_000 }, JUP: { side: 0.002, roundTrip: 0.001, tx: 0.0015, at: now - 5 * 86_400_000 } });
  assert.equal(spotFee("sol", 0.003, now), 0.002);
  assert.equal(spotFee("JUP", 0.003, now), 0.003, "mesure trop vieille : ancien coût");
  assert.equal(spotFee("BONK", 0.003, now), 0.003, "jamais mesuré : ancien coût");
  setSpotCosts({});
});

test("frais réels : jamais mesurés d'abord, puis les plus anciens, 3 par cycle", () => {
  const now = Date.now(), old = now - 2 * 86_400_000;
  const due = dueForMeasure(["SOL", "JUP", "BONK", "WIF", "JTO", "PYTH", "RAY", "ORCA"], { SOL: { side: 0.002, roundTrip: 0, tx: 0, at: now }, JUP: { side: 0.002, roundTrip: 0, tx: 0, at: old } }, now);
  assert.equal(due.length, 3);
  assert.ok(!due.includes("SOL"), "mesure du jour : pas re-mesuré");
  assert.equal(due[0] === "JUP", false, "les jamais mesurés passent avant");
  assert.ok(costChanged(undefined, 0.003, { side: 0.0015, roundTrip: 0, tx: 0, at: 0 }));
  assert.ok(!costChanged({ side: 0.003, roundTrip: 0, tx: 0, at: 0 }, 0.003, { side: 0.0029, roundTrip: 0, tx: 0, at: 0 }));
});
