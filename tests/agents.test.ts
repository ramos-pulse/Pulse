// Agents on-chain : filtres du sélectionneur, garde-fous de l'agent nouveaux tokens, mise, arbitrage éclaireur.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dexSpread, freshRefusal, freshStake, rankSelection, selectionRefusal, type JupToken, freshAffordable, impersonates, parseRugcheck, RC_NEEDED } from "../supabase/functions/pulse/engine/agents.ts";

const TP = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const safe = (x: Partial<JupToken> = {}): JupToken => ({ id: "M", symbol: "OK", decimals: 6, tokenProgram: TP, isVerified: true, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 10, devBalancePercentage: 2 }, rug: { devPct: 2, rugged: false, dangers: [], score: 1, lockedPct: 100 }, ...x });
const cand = { mint: "M", symbol: "OK", decimals: 6, pool: "P", liquidity: 2e6, volume24h: 3e6, ageDays: 90 };

test("sélectionneur : filtres stricts (liquidité, volume, vérifié, âge, émission et gel désactivés)", () => {
  assert.equal(selectionRefusal(cand, safe()), null);
  assert.match(selectionRefusal(cand, safe({ isVerified: false }))!, /non vérifié/);
  assert.match(selectionRefusal(cand, safe({ audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true } }))!, /émission/);
  assert.match(selectionRefusal(cand, safe({ audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false } }))!, /gel/);
  assert.match(selectionRefusal({ ...cand, liquidity: 5e5 }, safe())!, /liquidité/);
  assert.match(selectionRefusal({ ...cand, volume24h: 2e5 }, safe())!, /volume/);
  assert.match(selectionRefusal({ ...cand, ageDays: 10 }, safe())!, /récent/);
  assert.equal(selectionRefusal(cand, safe({ tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" })), null); // Token-2022 accepté (extensions vérifiées ensuite)
  assert.match(selectionRefusal(cand, safe({ tokenProgram: "AutreProgramme1111111111111111111111111111" }))!, /inconnu/);
  const many = Array.from({ length: 40 }, (_, i) => ({ ...cand, mint: "M" + i, volume24h: 1e6 + i * 1e5 }));
  const info = new Map(many.map((c) => [c.mint, safe({ id: c.mint })]));
  const r = rankSelection(many, info);
  assert.equal(r.selected.length, 25); assert.equal(r.selected[0]!.mint, "M39", "les plus échangés d'abord");
});

test("nouveaux tokens : garde-fous anti-arnaque", () => {
  const f = { mint: "N", symbol: "NEW", decimals: 6, pool: "P", liquidity: 1e5, volume1h: 5e4, change1h: 15, buys1h: 200, sells1h: 120, ageMin: 180 };
  assert.equal(freshRefusal(f, safe({ isVerified: false })), null, "un nouveau token n'a pas besoin d'être vérifié, mais doit passer le reste");
  assert.match(freshRefusal(f, safe({ audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false, topHoldersPercentage: 5 } }))!, /gel/);
  assert.match(freshRefusal(f, safe({ audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 60, devBalancePercentage: 2 } }))!, /concentration/);
  assert.match(freshRefusal({ ...f, sells1h: 3 }, safe())!, /vente/);
  assert.match(freshRefusal({ ...f, ageMin: 10 }, safe())!, /trop jeune/);
  assert.match(freshRefusal({ ...f, change1h: 300 }, safe())!, /variation/);
  assert.match(freshRefusal({ ...f, liquidity: 2e4 }, safe())!, /liquidité/);
  assert.match(freshRefusal({ ...f, buys1h: 100, sells1h: 150 }, safe())!, /vendeurs/);
  // mise : 5 % du capital entre 2 et 5 $, jamais plus de 20 % du capital
  assert.equal(freshStake(100), 5); assert.equal(freshStake(40), 2); assert.equal(freshStake(10), 2); assert.equal(freshStake(8), 0);
});

test("arbitrage éclaireur : écart entre DEX, frais déduits", () => {
  const pair = (dex: string, p: number, liq = 1e6) => ({ dexId: dex, pairAddress: dex, baseToken: { address: "M", symbol: "X" }, quoteToken: { address: "U", symbol: "USDC" }, priceUsd: String(p), liquidity: { usd: liq } });
  const o = dexSpread("X", [pair("orca", 1), pair("raydium", 1.01), pair("petit", 1.5, 1000)], "M")!;
  assert.ok(Math.abs(o.grossPct - 1) < 1e-9, "le pool trop petit est ignoré");
  assert.ok(o.netPct < o.grossPct - 0.5, "frais de 2 swaps et de réseau déduits");
  assert.equal(dexSpread("X", [pair("orca", 1)], "M"), null);
});

test("mode extra souple : nouveaux tokens moins exigeants, mais les contrôles anti-arnaque restent", () => {
  const f = { mint: "N", symbol: "NEW", decimals: 6, pool: "P", liquidity: 3e4, volume1h: 1.2e4, change1h: 80, buys1h: 50, sells1h: 60, ageMin: 120 };
  assert.ok(freshRefusal(f, safe()) !== null, "refusé en mode normal");
  assert.equal(freshRefusal(f, safe(), true), null, "accepté en extra souple");
  assert.match(freshRefusal(f, safe({ audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false, topHoldersPercentage: 5 } }), true)!, /gel/);
  assert.match(freshRefusal({ ...f, sells1h: 4 }, safe(), true)!, /vente/);
});

test("nouveaux tokens : les imitations de marques sont refusées", async () => {
  const { impersonates } = await import("../supabase/functions/pulse/engine/agents.ts");
  assert.equal(impersonates("MetaMask"), true);
  assert.equal(impersonates("USDC"), true);
  assert.equal(impersonates("XYZ", "Official Trump Coin"), true);
  assert.equal(impersonates("ZOTH", "Zoth"), false);
  assert.equal(impersonates("NINE"), false);
});

test("nouveaux tokens : cas NINE (suspect, créateur à 96 %) refusé", async () => {
  const f = { mint: "M", symbol: "NINE", decimals: 6, pool: "P", liquidity: 80_000, volume1h: 50_000, change1h: 20, buys1h: 300, sells1h: 200, ageMin: 120 };
  const a = { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 6.6 };
  assert.match(freshRefusal(f, safe({ audit: { ...a, isSus: true, devBalancePercentage: 95.85 } }))!, /suspect/);
  assert.match(freshRefusal(f, safe({ audit: { ...a, devBalancePercentage: 95.85 } }))!, /créateur détient 96/);
  assert.match(freshRefusal(f, safe({ audit: { ...a, devBalancePercentage: 95.85 } }), true)!, /créateur/); // extra souple aussi
  assert.match(freshRefusal(f, safe({ audit: a }))!, /créateur inconnue/);
});

test("RugCheck : le vrai rapport de NINE (27/11) aurait bloqué l'achat", async () => {
  const { parseRugcheck, freshRefusal } = await import("../supabase/functions/pulse/engine/agents.ts");
  const rc = parseRugcheck({ creator: "Gfe4", creatorBalance: 958505243376195, token: { supply: 999999855295605, decimals: 6 }, rugged: false, score_normalised: 62,
    risks: [{ name: "Top 10 holders high ownership", level: "danger", value: "" }, { name: "Single holder ownership", level: "danger", value: "95.85%" }, { name: "Mutable metadata", level: "warn" }] })!;
  assert.equal(rc.devPct, 95.85);
  assert.equal(rc.dangers.length, 2);
  const f = { mint: "M", symbol: "NINE", decimals: 6, pool: "P", liquidity: 80_000, volume1h: 50_000, change1h: 20, buys1h: 300, sells1h: 200, ageMin: 120 };
  const j = { id: "M", symbol: "NINE", decimals: 6, isVerified: false, tags: [], audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 6.6 }, rug: rc } as never;
  assert.match(freshRefusal(f, j)!, /RugCheck : Top 10/);
  // sans alerte « danger » mais créateur à 95 % (part trouvée par RugCheck) : refusé aussi
  const j2 = { id: "M", symbol: "NINE", decimals: 6, isVerified: false, tags: [], audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 6.6, devBalancePercentage: rc.devPct! } } as never;
  assert.match(freshRefusal(f, j2)!, /créateur détient 96/);
  // token sain : RugCheck ne bloque pas
  const ok = parseRugcheck({ creatorBalance: 0, token: { supply: 1e15 }, risks: [{ name: "Mutable metadata", level: "warn" }] })!;
  assert.deepEqual([ok.devPct, ok.dangers.length, ok.rugged], [0, 0, false]);
});

test("nouveaux tokens : imitations de grands tokens actuels (WLFI, HYPE…) refusées", () => {
  for (const s of ["WLFI", "wlfi", "HYPE", "PENGU", "Fartcoin", "USD1"]) assert.ok(impersonates(s), s);
  assert.ok(!impersonates("STEADY") && !impersonates("Memeball"));
});

test("nouveaux tokens : pas d'achat sous 10 $ de capital (mise ≤ 20 %, perte au stop ≤ 4 %)", () => {
  assert.equal(freshAffordable(9.86), false); // le bot 1 le 28/11
  assert.equal(freshAffordable(10), true);
  assert.equal(freshAffordable(11.65), true); // quand NINE a été acheté
});

test("nouveaux tokens : liquidité verrouillée exigée (≥ 70 %), rapport RugCheck obligatoire", () => {
  const f = { mint: "M", symbol: "OK", decimals: 6, pool: "P", liquidity: 80_000, volume1h: 30_000, change1h: 20, buys1h: 60, sells1h: 40, ageMin: 120 };
  assert.equal(freshRefusal(f, safe()), null);
  assert.equal(freshRefusal(f, safe({ rug: undefined })), RC_NEEDED, "sans rapport RugCheck : jamais retenu");
  assert.match(freshRefusal(f, safe({ rug: { devPct: 2, rugged: false, dangers: [], score: 1, lockedPct: 55 } }))!, /liquidité retirable \(55 %/);
  assert.equal(freshRefusal(f, safe({ rug: { devPct: 2, rugged: false, dangers: [], score: 1, lockedPct: null } })), "liquidité verrouillée inconnue");
  // vrai rapport du 28/11 : pool pump.fun brûlé (83 k$) + pools Meteora DLMM non verrouillés (63 k$) sur 150 k$ → 55,4 %
  const r = parseRugcheck({ token: { supply: 1e9 }, creatorBalance: 0, totalMarketLiquidity: 150148.14, markets: [{ lp: { lpLockedUSD: 83178.48 } }, { lp: { lpLockedUSD: 0 } }, { lp: { lpLockedUSD: 0 } }] })!;
  assert.equal(r.lockedPct, 55.4);
});
