import { test } from "node:test";
import assert from "node:assert/strict";
import { hlMakerEntry, type HlAsset } from "../supabase/functions/pulse/engine/hyperliquid.ts";

// faux Hyperliquid minimal pour l'entrée « faiseur »
const S = { fills: [] as { coin: string; px: string; sz: string; side: string; time: number; closedPnl: string; fee: string; oid: number; dir: string }[], sent: [] as string[], cancelFails: false, aloFill: 0 };
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const ok = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
  if (String(url).endsWith("/info")) {
    if (body.type === "l2Book") return ok({ levels: [[{ px: "100" }], [{ px: "100.1" }]] });
    if (body.type === "userFillsByTime") return ok(S.fills);
    throw new Error(body.type);
  }
  const a = body.action;
  if (a.type === "cancel") { S.sent.push("cancel"); return ok(S.cancelFails ? { status: "err", response: "réseau" } : { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } }); }
  const o = a.orders[0];
  if (o.t.limit.tif === "Alo") {
    S.sent.push(`alo@${o.p}`);
    if (S.aloFill) S.fills.push({ coin: "ETH", px: "100", sz: String(S.aloFill), side: "B", time: Date.now(), closedPnl: "0", fee: "0", oid: 7, dir: "Open" });
    return ok({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 7 } }] } } });
  }
  S.sent.push(`marché ${o.s}`);
  return ok({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: o.s, avgPx: "100.2", oid: 8 } }] } } });
}) as typeof fetch;

const KEY = "0x" + "11".repeat(32), ACC = "0x" + "ab".repeat(20);
const ETH: HlAsset = { index: 1, name: "ETH", szDecimals: 3, maxLeverage: 25 };
const reset = () => { S.fills = []; S.sent = []; S.cancelFails = false; S.aloFill = 0; };
const run = () => hlMakerEntry(KEY, ACC, ETH, true, 0.5, 100, 6, async () => {});

test("entrée faiseur : exécutée en entier au meilleur prix d'achat → aucun ordre au marché", async () => {
  reset(); S.aloFill = 0.5;
  const f = await run();
  assert.deepEqual([f.size, f.avgPx, f.makerSize], [0.5, 100, 0.5]);
  assert.ok(S.sent[0] === "alo@100" && !S.sent.some((x) => x.startsWith("marché")));
});

test("entrée faiseur : partiellement exécutée → le reste au marché, prix moyen juste", async () => {
  reset(); S.aloFill = 0.2;
  const f = await run();
  assert.equal(f.size, 0.5); assert.equal(f.makerSize, 0.2);
  assert.ok(Math.abs(f.avgPx - (0.2 * 100 + 0.3 * 100.2) / 0.5) < 1e-9);
  assert.deepEqual(S.sent, ["alo@100", "cancel", "marché 0.3"]);
});

test("entrée faiseur : annulation impossible → RIEN de plus n'est envoyé (pas de position doublée)", async () => {
  reset(); S.cancelFails = true;
  await assert.rejects(run());
  assert.ok(!S.sent.some((x) => x.startsWith("marché")));
});
