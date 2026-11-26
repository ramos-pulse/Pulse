import { test } from "node:test";
import assert from "node:assert/strict";
import { PROBATION_RISK, riskFactor, sanitizeSpotPlans, loadConfig } from "../supabase/functions/pulse/engine/strategy.ts";

test("bots ← chercheur : 75 % du risque tant que la stratégie n'est pas confirmée en réel", () => {
  assert.equal(riskFactor("nouvelle"), PROBATION_RISK); assert.equal(riskFactor(undefined), 0.75); assert.equal(riskFactor("confirmée"), 1);
  const [p] = sanitizeSpotPlans([{ symbol: "SOL", family: "tendance", params: { breakout: 24, trailAtr: 3, minTrend: 1 }, confidence: "n'importe quoi" }]);
  assert.equal(p!.confidence, "nouvelle");
});
test("agent swap : nettoyage automatique activé par défaut, désactivable", () => {
  assert.equal(loadConfig(null).swapAuto, true); assert.equal(loadConfig({ swapAuto: false }).swapAuto, false);
});
