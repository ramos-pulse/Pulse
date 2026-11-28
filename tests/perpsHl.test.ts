// Bot perps HYPERLIQUID : tailles, arrondis, mise selon la confiance, et simulation complète contre un faux serveur
// Hyperliquid (ouverture, stop posé chez Hyperliquid, stop déplacé, stop déclenché, dépôt). Aucune requête réelle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressOf, l1Digest, recoverAddress } from "../supabase/functions/pulse/engine/evm.ts";
import { floatToWire, roundPrice, roundSize } from "../supabase/functions/pulse/engine/hyperliquid.ts";
import { hlSafeLeverage, hlSizing, runHlTick } from "../supabase/functions/pulse/engine/perpsHl.ts";
import { conviction, setPerpsMarkets, type Candle } from "../supabase/functions/pulse/engine/strategy.ts";

test("Hyperliquid : arrondis des prix et des tailles", () => {
  assert.equal(floatToWire(100), "100");
  assert.equal(floatToWire(0.0147), "0.0147");
  assert.equal(floatToWire(1670.1), "1670.1");
  assert.equal(roundPrice(61234.567, 5), 61235);     // BTC : 5 chiffres significatifs, 1 décimale max
  assert.equal(roundPrice(70.12345, 2), 70.123);     // SOL : 5 chiffres significatifs
  assert.equal(roundPrice(0.000123456, 0), 0.000123); // petit token : 6 décimales max
  assert.equal(roundSize(0.123456, 2), 0.12);         // toujours vers le bas
  assert.equal(roundSize(1.999999999, 2), 1.99);
});

test("Hyperliquid : levier sûr (liquidation 3 fois plus loin que le stop)", () => {
  const lev = hlSafeLeverage(0.02, 20); // stop à 2 %
  const liqDist = 1 / lev - 1 / 40;      // distance de liquidation ≈ 1/levier − marge de maintien
  assert.ok(liqDist >= 0.02 * 3 - 1e-9, `liquidation à ${liqDist}`);
  assert.ok(lev > 1 && lev < 20);
});

test("Hyperliquid : taille d'une position (minimum 10 $ de TAILLE, marge dans les USDC disponibles)", () => {
  const s = hlSizing(44, 44, 70, 68.6, 0.0225, 5, 0.03)!; // stop 2 %, risque 2,25 %
  assert.ok(Math.abs(s.notional - 49.5) < 0.01);
  assert.ok(s.margin <= 44 * 0.95 && s.leverage <= 5);
  // petite position voulue (4 $) : montée à 10 $ si le risque reste sous le plafond
  const m = hlSizing(44, 44, 70, 69.3, 0.001, 5, 0.03)!;
  assert.ok(m.notional >= 10 && m.risk <= 0.03);
  // impossible : 10 $ de taille dépasserait le plafond de risque
  assert.equal(hlSizing(5, 5, 70, 63, 0.001, 5, 0.03), null);
  // marge plafonnée par les USDC disponibles
  const c = hlSizing(1000, 10, 70, 68.6, 0.03, 3, 0.03)!;
  assert.ok(c.margin <= 10 * 0.95 + 1e-9);
});

test("mise selon la confiance : de ×0,5 à ×1,5 selon le score de la stratégie", () => {
  assert.equal(conviction(undefined), 1);
  assert.equal(conviction(-49), 0.5);
  assert.equal(conviction(1), 0.9);
  assert.ok(conviction(2.6) > 1 && conviction(2.6) < 1.2);
  assert.equal(conviction(50), 1.5);
});

// ---------------------------------------------------------------------------------------------------
// Faux serveur Hyperliquid
// ---------------------------------------------------------------------------------------------------
const AGENT_KEY = "0x" + "11".repeat(32), ACCOUNT = "0x" + "ab".repeat(20);
const META = [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }, { name: "SOL", szDecimals: 2, maxLeverage: 20 }];
interface FakePos { szi: number; entryPx: number; lev: number }
const hl = {
  cash: 50, mids: { BTC: 60000, ETH: 3000, SOL: 70 } as Record<string, number>, pos: {} as Record<string, FakePos>, orders: [] as { oid: number; coin: string; trig: number; isBuy: boolean; sz: number }[],
  fills: [] as { coin: string; px: string; sz: string; side: string; time: number; closedPnl: string; fee: string; oid: number; dir: string }[],
  ledger: [] as { time: number; delta: { type: string; usdc: string } }[], oid: 100, signers: new Set<string>(), solTrend: 0, dir: 1, rejectStops: false, down: false,
};
/** Bougies 1 h de SOL : tendance haussière régulière, la dernière casse franchement le plus haut. */
function solCandles(start: number, end: number): Candle[] {
  const out: Candle[] = [], nowH = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  for (let t = Math.floor(start / 3_600_000) * 3_600_000; t < end; t += 3_600_000) {
    const k = (t - nowH) / 3_600_000; // -1 = dernière bougie clôturée
    const base = 70 * Math.exp(0.0015 * hl.dir * k) * (1 + hl.dir * hl.solTrend * (k >= -1 ? 1 : 0));
    const wig = Math.sin(k * 1.7) * 0.004, jump = k === -1 ? 0.02 * hl.dir : 0; // la dernière casse franchement le plus haut
    const o = base * (1 + wig), c = base * (1 + wig + 0.002 + jump);
    out.push({ t, o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, c, v: 1000 });
  }
  return out;
}
function value() { return hl.cash + Object.entries(hl.pos).reduce((s, [c, p]) => s + Math.abs(p.szi) * p.entryPx / p.lev + p.szi * (hl.mids[c]! - p.entryPx), 0); }
function fill(coin: string, isBuy: boolean, sz: number, px: number) {
  const p = hl.pos[coin], dir = isBuy ? 1 : -1;
  let closed = 0;
  if (p && Math.sign(p.szi) !== dir) { // réduction
    const red = Math.min(Math.abs(p.szi), sz);
    closed = (px - p.entryPx) * red * Math.sign(p.szi);
    hl.cash += red * p.entryPx / p.lev + closed;
    p.szi += dir * red;
    if (Math.abs(p.szi) < 1e-9) delete hl.pos[coin];
  } else {
    const lev = (hl as unknown as { lev: Record<string, number> }).lev?.[coin] ?? 1;
    hl.cash -= sz * px / lev;
    hl.pos[coin] = p ? { ...p, szi: p.szi + dir * sz } : { szi: dir * sz, entryPx: px, lev };
  }
  const fee = sz * px * 0.00045; hl.cash -= fee;
  hl.fills.push({ coin, px: String(px), sz: String(sz), side: isBuy ? "B" : "A", time: Date.now(), closedPnl: String(closed), fee: String(fee), oid: ++hl.oid, dir: closed ? "Close" : "Open" });
}
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (!u.startsWith("https://api.hyperliquid.xyz")) throw new Error(`requête inattendue : ${u}`);
  const body = JSON.parse(String(init?.body ?? "{}"));
  const ok = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
  if (hl.down) return new Response("indisponible", { status: 503 });
  if (u.endsWith("/info")) {
    switch (body.type) {
      case "meta": return ok({ universe: META });
      case "allMids": return ok(Object.fromEntries(Object.entries(hl.mids).map(([k, v]) => [k, String(v)])));
      case "clearinghouseState": return ok({ marginSummary: { accountValue: String(value()) }, withdrawable: String(hl.cash), assetPositions: Object.entries(hl.pos).map(([coin, p]) => ({ position: {
        coin, szi: String(p.szi), entryPx: String(p.entryPx), positionValue: String(Math.abs(p.szi) * hl.mids[coin]!), unrealizedPnl: String(p.szi * (hl.mids[coin]! - p.entryPx)), marginUsed: String(Math.abs(p.szi) * p.entryPx / p.lev), leverage: { value: p.lev }, liquidationPx: null } })) });
      case "spotClearinghouseState": return ok({ balances: [] });
      case "candleSnapshot": return ok(body.req.coin === "SOL" ? solCandles(body.req.startTime, body.req.endTime).map((c) => ({ t: c.t, o: String(c.o), h: String(c.h), l: String(c.l), c: String(c.c), v: String(c.v) })) : []);
      case "userFillsByTime": return ok(hl.fills.filter((f) => f.time >= body.startTime));
      case "userNonFundingLedgerUpdates": return ok(hl.ledger.filter((l) => l.time >= body.startTime));
      case "frontendOpenOrders": return ok(hl.orders.map((o) => ({ coin: o.coin, oid: o.oid, isTrigger: true, triggerPx: String(o.trig), reduceOnly: true, side: o.isBuy ? "B" : "A", sz: String(o.sz), orderType: "Stop Market" })));
    }
    throw new Error(`info inconnue ${body.type}`);
  }
  // /exchange : la signature doit venir de l'agent
  hl.signers.add(recoverAddress(l1Digest(body.action, body.nonce, true), body.signature));
  const a = body.action;
  if (a.type === "updateLeverage") { ((hl as unknown as { lev: Record<string, number> }).lev ??= {})[META[a.asset]!.name] = a.leverage; return ok({ status: "ok", response: { type: "default" } }); }
  if (a.type === "cancel") { for (const c of a.cancels) hl.orders = hl.orders.filter((o) => o.oid !== c.o); return ok({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } }); }
  if (a.type === "order") {
    const o = a.orders[0], coin = META[o.a]!.name, sz = Number(o.s);
    if (o.t.trigger && hl.rejectStops) return ok({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Invalid trigger price" }] } } });
    if (o.t.trigger) { const oid = ++hl.oid; hl.orders.push({ oid, coin, trig: Number(o.t.trigger.triggerPx), isBuy: o.b, sz }); return ok({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid } }] } } }); }
    const px = hl.mids[coin]!;
    if (o.b ? Number(o.p) < px : Number(o.p) > px) return ok({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Order could not immediately match" }] } } });
    fill(coin, o.b, sz, px);
    return ok({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: String(sz), avgPx: String(px), oid: hl.oid } }] } } });
  }
  throw new Error(`action inconnue ${a.type}`);
}) as typeof fetch;

function store(config: unknown) {
  const b = { kind: "perps", status: "running", goal_usd: 5000, end_at: null, started_at: new Date().toISOString(), start_value_usd: 50, wallet_address: null, position_mint: null, entry_price: null,
    position_pubkey: null, position_asset: null, position_side: null, price_history: null, config, last_value_usd: null, last_tick_at: null, last_message: null } as Record<string, unknown>;
  const trades: Record<string, unknown>[] = [], alerts: string[] = [];
  return { b, trades, alerts, s: { bot: () => b as never, update: (_k: string, p: Record<string, unknown>) => Object.assign(b, p), addTrade: (_k: string, r: Record<string, unknown>) => trades.push(r), alert: (t: string) => alerts.push(t) } };
}

test("simulation : ouverture, stop chez Hyperliquid, stop suiveur, stop déclenché, dépôt", async () => {
  process.env.HL_ACCOUNT_ADDRESS = ACCOUNT;
  process.env.HL_AGENT_PRIVATE_KEY = AGENT_KEY;
  setPerpsMarkets([{ asset: "BTC", candles: "hl:BTC" }, { asset: "ETH", candles: "hl:ETH" }, { asset: "SOL", candles: "hl:SOL" }]);
  const plan = { asset: "SOL", params: { breakout: 8, minTrend: 0.3, trailAtr: 2.5 }, interval: "1h", source: "chercheur #5201 · Perps SOL", score: 5.59, confidence: "nouvelle" };
  const { b, s, trades, alerts } = store({ aggr: 3, maxLev: 5, autopilot: true, pilotAggressive: true, plans: [plan], maxPositions: 3, vaultPct: 25, partialTp: true });
  // prix réel = dernière clôture des bougies
  const lastClose = () => solCandles(Date.now() - 2 * 3_600_000, Math.floor(Date.now() / 3_600_000) * 3_600_000).at(-1)!.c;
  hl.mids.SOL = lastClose();

  const r1 = await runHlTick(s as never);
  if (r1 !== "open") console.log("tick 1 :", r1, b.last_message);
  assert.equal(r1, "open", String(b.last_message));
  assert.ok(hl.pos.SOL && hl.pos.SOL.szi > 0, "position longue ouverte chez Hyperliquid");
  assert.equal(hl.orders.length, 1, "un stop posé chez Hyperliquid");
  const firstStop = hl.orders[0]!.trig;
  assert.ok(firstStop < hl.mids.SOL!, "stop sous le prix pour un long");
  assert.ok(hl.pos.SOL.lev >= 1 && hl.pos.SOL.lev <= 5, "levier dans la limite choisie");
  assert.deepEqual([...hl.signers], [addressOf(AGENT_KEY)], "toutes les actions signées par l'agent");
  assert.equal(trades.filter((x) => x.action === "open").length, 1);
  assert.match(String((trades[0]!.detail as { pourquoi: string }).pourquoi), /confiance ×1\.\d+/);

  // le marché monte fortement : à la bougie suivante, le stop suiveur monte et le stop chez Hyperliquid est déplacé
  const mem = b.price_history as { positions: Record<string, { stopCandle?: number; stop?: number }> };
  mem.positions.SOL!.stopCandle = 0; // force la relecture de la bougie
  hl.solTrend = 0.08; hl.mids.SOL = lastClose();
  const r2 = await runHlTick(s as never);
  assert.equal(r2, "hold", String(b.last_message));
  assert.equal(hl.orders.length, 1, "toujours un seul stop (l'ancien est annulé)");
  assert.ok(hl.orders[0]!.trig > firstStop, `stop remonté (${firstStop} → ${hl.orders[0]!.trig})`);

  // le stop est déclenché chez Hyperliquid : la position disparaît, le bot l'enregistre au 2e tick avec le vrai résultat
  const o = hl.orders.pop()!;
  hl.mids.SOL = o.trig; fill("SOL", false, o.sz, o.trig);
  await runHlTick(s as never);
  assert.equal(trades.filter((x) => x.action === "close").length, 0, "1er tick sans la position : on attend");
  await runHlTick(s as never);
  const close = trades.find((x) => x.action === "close")!;
  assert.ok(close, "fermeture enregistrée");
  assert.equal(close.reason, "stop_hl");
  assert.ok(Math.abs(Number(close.pnl_usd) - hl.fills.reduce((x, f) => x + Number(f.closedPnl) - Number(f.fee), 0)) < 1e-6, "résultat = gains réalisés − frais");

  // dépôt de 20 $ : point de départ ajusté, ce n'est pas un gain
  const start = Number(b.start_value_usd);
  hl.ledger.push({ time: Date.now() + 1, delta: { type: "deposit", usdc: "20" } }); hl.cash += 20;
  await runHlTick(s as never);
  assert.equal(Number(b.start_value_usd), start + 20);
  assert.equal(alerts.length, 0, alerts.join(" | "));
});

function reset() {
  Object.assign(hl, { cash: 50, pos: {}, orders: [], fills: [], ledger: [], solTrend: 0, dir: 1, rejectStops: false, down: false });
  hl.signers.clear();
}
const PLAN = { asset: "SOL", params: { breakout: 8, minTrend: 0.3, trailAtr: 2.5 }, interval: "1h", source: "chercheur #1 · Perps SOL", score: 2, confidence: "nouvelle" };
const lastSol = () => solCandles(Date.now() - 2 * 3_600_000, Math.floor(Date.now() / 3_600_000) * 3_600_000).at(-1)!.c;

test("short sur marché baissier : vente à découvert, stop AU-DESSUS du prix", async () => {
  reset(); hl.dir = -1; hl.mids.SOL = lastSol();
  const { b, s } = store({ aggr: 3, maxLev: 5, autopilot: true, pilotAggressive: true, plans: [PLAN], maxPositions: 3 });
  const r = await runHlTick(s as never);
  assert.equal(r, "open", String(b.last_message));
  assert.ok(hl.pos.SOL!.szi < 0, "position courte");
  assert.ok(hl.orders[0]!.trig > hl.mids.SOL!, "stop au-dessus du prix pour un short");
  assert.equal(hl.orders[0]!.isBuy, true, "le stop d'un short rachète");
});

test("stop refusé par Hyperliquid : la position est refermée aussitôt et une alerte part", async () => {
  reset(); hl.rejectStops = true; hl.mids.SOL = lastSol();
  const { s, alerts, b } = store({ aggr: 3, maxLev: 5, autopilot: true, pilotAggressive: true, plans: [PLAN], maxPositions: 3 });
  const r = await runHlTick(s as never);
  assert.equal(r, "hold");
  assert.equal(Object.keys(hl.pos).length, 0, "plus aucune position ouverte");
  assert.match(alerts.join(" "), /refermée aussitôt/);
  assert.match(String(b.last_message), /refermée par sécurité/);
});

test("Hyperliquid injoignable : le bot ne touche à rien et le dit", async () => {
  reset(); hl.down = true;
  const { s, b } = store({ autopilot: true, plans: [PLAN] });
  assert.equal(await runHlTick(s as never), "data_unavailable");
  assert.match(String(b.last_message), /stops posés chez Hyperliquid protègent/);
  hl.down = false;
});

test("secrets absents : message clair, aucune action", async () => {
  reset();
  const keep = process.env.HL_AGENT_PRIVATE_KEY;
  delete process.env.HL_AGENT_PRIVATE_KEY;
  const { s, b } = store({ autopilot: true, plans: [PLAN] });
  assert.equal(await runHlTick(s as never), "data_unavailable");
  assert.match(String(b.last_message), /HL_AGENT_PRIVATE_KEY/);
  process.env.HL_AGENT_PRIVATE_KEY = keep;
  assert.equal(hl.signers.size, 0);
});

test("premier passage sur Hyperliquid : point de départ remis à la valeur du compte", async () => {
  reset(); hl.mids.SOL = 1; // pas de signal
  const { s, b } = store({ autopilot: true, plans: [] });
  b.start_value_usd = 46.17; b.price_history = { v: 3, curve: [{ t: 1, v: 46.17 }], venue: "jupiter" };
  await runHlTick(s as never);
  assert.equal(Number(b.start_value_usd), 50);
  assert.match(String(b.last_message), /passé sur Hyperliquid/);
});

test("transfert Spot → Perps sur son propre compte : ni dépôt ni retrait (cas réel du 28/11)", async () => {
  reset(); hl.mids.SOL = 1;
  const { s, b, trades } = store({ autopilot: true, plans: [] });
  b.price_history = { v: 3, venue: "hyperliquid", hlLedgerAt: Date.now() - 1000 };
  b.start_value_usd = 50;
  const me = ACCOUNT;
  (hl.ledger as unknown[]).push({ time: Date.now(), delta: { type: "send", user: me, destination: me, sourceDex: "spot", destinationDex: "", token: "USDC", amount: "39.17", usdcValue: "39.17" } });
  await runHlTick(s as never);
  assert.equal(Number(b.start_value_usd), 50, "point de départ inchangé");
  assert.equal(trades.filter((t) => t.action === "deposit").length, 0);
});
