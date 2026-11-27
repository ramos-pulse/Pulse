// Fonction Supabase « pulse » : appelée chaque minute par le cron (tick des deux bots) et par l'app (API).
//   POST /pulse/tick                 cron (en-tête x-cron-secret)
//   GET  /pulse/api/state            état des deux missions
//   POST /pulse/api/{spot|perps}/{start|pause|stop|goal}
//   GET  /pulse/api/backtest?market=N
import { createClient } from "npm:@supabase/supabase-js@2";
import { riskPerTrade } from "./engine/brain.ts";
import { candles as getCandles, hourlyCandles } from "./engine/candles.ts";
import { env, token2022Danger } from "./engine/solana.ts";
import { currentPerpsValue, getPerpsWalletAddress, liquidatePerps, runPerpsTick } from "./engine/perps.ts";
import { currentValue, getWalletAddress, liquidate, runTick } from "./engine/spot.ts";
import { AGGR_LEVELS, AGGRESSIVE, BREAKER_STEPS, dayKey, effectiveAggr, LEVERAGES, marketFilter, type Candle, migratePositions, NERVE_LEVELS, PARTIAL, VAULT_STEPS, backtest, backtestRsi, loadConfig, loadMemory, loadPerpsConfig, PERPS_ASSETS, PERPS_RULES, PRESETS, RISK, RULES, sanitizeRsi, sanitizeTrend, STRATEGY, TOKENS, researchSide, EXTRA_SOFT, allTokens, setExtraTokens, type TokenInfo, type Interval, type Params, type PerpsPlan, type RsiParams, type SpotPlan } from "./engine/strategy.ts";
import { candidateKey, describe, evaluate, mutate, randomCandidate, seeded, simulate, tempo, type Candidate, type Market } from "./engine/research.ts";
import { DbStore, notify, pushHook, type BotKind, type BotState } from "./store.ts";
import { arbScan, bestPools, FRESH, freshCandidates, freshRefusal, rankSelection, SELECT, selectionCandidates } from "./engine/agents.ts";
import { newVapid, sendPush, type Subscription, type Vapid } from "./engine/webpush.ts";
import { cleanWallet, CLEANER } from "./engine/cleaner.ts";
import { analyze, LUCK, luckProbability, propose } from "./engine/math.ts";
import { FAMILY_NAMES, isSetup, PERPS_ONLY, sanitizeSetup, type Extra, type SetupParams } from "./engine/setups.ts";
import { fundingHistory } from "./engine/funding.ts";

const SUPABASE_URL = env("SUPABASE_URL") ?? "";

/** Clé « service » : son nom varie selon l'âge du projet Supabase. */
function serviceKey(): string | undefined {
  const direct = env("SUPABASE_SERVICE_ROLE_KEY") ?? env("SUPABASE_SECRET_KEY") ?? env("PULSE_SERVICE_KEY");
  if (direct) return direct;
  const many = env("SUPABASE_SECRET_KEYS"); // format JSON {"default": "sb_secret_..."} sur les projets récents
  if (many) { try { const o = JSON.parse(many) as Record<string, string>; return o["default"] ?? Object.values(o)[0]; } catch { /* ignore */ } }
  return undefined;
}
const KEY = serviceKey();
// Créé seulement si la clé existe : sinon la fonction répond avec une erreur claire au lieu de planter au démarrage.
const db = (KEY && SUPABASE_URL ? createClient(SUPABASE_URL, KEY, { auth: { persistSession: false } }) : null) as ReturnType<typeof createClient>;
const TOKEN = (env("DASHBOARD_TOKEN") ?? "").trim().replace(/^["']|["']$/g, ""); // tolère espaces ou guillemets collés par erreur
const KINDS: BotKind[] = ["spot", "perps"];

const MARKETS = [
  ...TOKENS.map((t) => ({ name: `Spot ${t.symbol}`, product: t.candles, allowShort: false, feePct: 0.003, hourlyCost: 0, cap: RISK.maxSpotFraction })),
  { name: "Perps SOL", product: "SOL-USD", allowShort: true, feePct: 0.0012, hourlyCost: 0.00008, cap: PERPS_RULES.maxLeverage },
];

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "x-token, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" } });

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const cronSecret = () => sha256(`${TOKEN}:pulse-cron`);
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ------------------------------------------------------------------ tick
async function tickBot(kind: BotKind): Promise<string> {
  const store = await DbStore.claim(db, kind);
  if (!store) return "occupé (tick précédent en cours)";
  try {
    return kind === "spot" ? await runTick(store) : await runPerpsTick(store);
  } catch (e) {
    store.update(kind, { last_tick_at: new Date().toISOString(), last_message: `Erreur inattendue : ${(e as Error).message}`.slice(0, 280) + " — je réessaie." });
    return "error";
  } finally {
    await store.release();
  }
}

// ------------------------------------------------------------------ installation automatique du cron
let cronReady = false;
async function ensureCron() {
  if (cronReady) return;
  const { error } = await db.rpc("pulse_install_cron", { fn_url: `${SUPABASE_URL}/functions/v1/pulse/tick`, secret: await cronSecret() });
  if (error) throw new Error(`cron : ${error.message}`);
  cronReady = true;
}

// ------------------------------------------------------------------ actions de l'app
async function readBots(): Promise<Record<BotKind, BotState>> {
  const { data, error } = await db.from("bot_state").select("*");
  if (error) throw new Error(error.message);
  const out = {} as Record<BotKind, BotState>;
  for (const r of data as BotState[]) out[r.kind] = r;
  return out;
}

async function setBot(kind: BotKind, patch: Partial<BotState>) {
  const { error } = await db.from("bot_state").update(patch).eq("kind", kind);
  if (error) throw new Error(error.message);
}

/** Nouvelle mission : perte du jour, pause après perte, références de soldes et courbe repartent de zéro (le cerveau et les positions sont gardés). */
function freshMissionMemory(ph: unknown, startValue: number | null) {
  const mem = loadMemory(ph);
  mem.day = dayKey(Date.now()); mem.dayStartValue = startValue ?? undefined; mem.cooldownUntil = undefined;
  delete mem.lastUsdc; delete mem.lastSol;
  mem.curve = startValue ? [{ t: Date.now(), v: Math.round(startValue * 100) / 100 }] : [];
  return mem;
}

async function startMission(kind: BotKind, body: { goal_usd?: number; days?: number }) {
  const bot = (await readBots())[kind];
  if (bot.status === "running") return { ok: true };
  const isNew = !bot.started_at || ["success", "destroyed", "stopped"].includes(bot.status);
  const goal = Number(body.goal_usd ?? bot.goal_usd) || 5000;
  const days = Number(body.days ?? 30) || 30;
  let startValue = bot.start_value_usd;
  // après un déclenchement du disjoncteur : il repart de zéro avec la nouvelle mission
  const sc0 = loadConfig((await readBots()).spot.config);
  if (sc0.breakerTrippedAt) await setBot("spot", { config: { ...sc0, breakerTrippedAt: null, breakerBase: null } });
  if (isNew) {
    try { startValue = (kind === "spot" ? await currentValue() : await currentPerpsValue()).valueUsd; } catch { startValue = null; }
  }
  await setBot(kind, {
    status: "running", goal_usd: goal,
    ...(isNew ? { started_at: new Date().toISOString(), start_value_usd: startValue, end_at: new Date(Date.now() + days * 86_400_000).toISOString(), price_history: freshMissionMemory(bot.price_history, startValue) as never } : {}),
    last_message: isNew ? "Mission lancée. J'analyse le marché." : "Je reprends la mission.",
  });
  await notify(`${kind === "spot" ? "Bot spot" : "Bot perps"} : mission ${isNew ? "lancée" : "reprise"} (objectif ${goal} $)`);
  return { ok: true };
}

/**
 * DISJONCTEUR GLOBAL : si la valeur totale des deux bots baisse de plus de X % depuis le départ, tout s'arrête
 * (positions fermées, bots arrêtés) et une alerte est envoyée. Remis à zéro au lancement d'une nouvelle mission.
 */
async function checkBreaker(): Promise<string | null> {
  const bots = await readBots();
  const sc = loadConfig(bots.spot.config);
  if (!sc.breakerPct || sc.breakerTrippedAt) return null;
  const active = KINDS.map((k) => bots[k]).filter((b) => (b.status === "running" || b.status === "paused") && Number(b.start_value_usd) > 0 && b.last_value_usd != null);
  if (!active.length) return null;
  const base = sc.breakerBase ?? active.reduce((a, b) => a + Number(b.start_value_usd), 0);
  const now = active.reduce((a, b) => a + Number(b.last_value_usd), 0);
  const drop = 1 - now / base;
  if (drop < sc.breakerPct / 100) return null;
  await setBot("spot", { config: { ...sc, breakerTrippedAt: Date.now() } });
  const msg = `Disjoncteur : les bots ont perdu ${(drop * 100).toFixed(1)} % ensemble (${base.toFixed(2)} $ → ${now.toFixed(2)} $), au-delà de ta limite de ${sc.breakerPct} %. Tout est arrêté et les positions sont fermées.`;
  await notify(`⚠ ${msg}`);
  for (const b of active) {
    await emergencyStop(b.kind).catch(() => null);
    await setBot(b.kind, { last_message: msg.slice(0, 300) });
  }
  return `DÉCLENCHÉ : ${msg}`;
}

async function emergencyStop(kind: BotKind) {
  await setBot(kind, { status: "paused", last_message: "Arrêt d'urgence en cours : je ferme les positions…" });
  const store = await DbStore.claimWait(db, kind, 60_000);
  if (!store) return { ok: false, error: "Un tick est encore en cours. Le bot est en pause ; réessaie l'arrêt d'urgence dans une minute." };
  try {
    if (kind === "spot") await liquidate(store, store.bot(kind), "stopped", "Arrêt d'urgence : positions vendues en USDC.");
    else await liquidatePerps(store, store.bot(kind), "stopped", "Arrêt d'urgence : positions fermées.");
    if (store.bot(kind).status === "running") store.update(kind, { status: "paused" }); // vente impossible : on garde la position mais en pause
  } catch (e) {
    store.update(kind, { status: "paused", last_message: `Arrêt d'urgence : ${(e as Error).message}`.slice(0, 280) });
  } finally {
    await store.release();
  }
  return { ok: true };
}

/** Courbe allégée pour l'app : au plus n points, le dernier toujours gardé. */
function downsample(c: { t: number; v: number }[], n: number) {
  if (c.length <= n) return c;
  const step = c.length / n;
  const out = Array.from({ length: n - 1 }, (_, i) => c[Math.floor(i * step)]!);
  out.push(c.at(-1)!);
  return out;
}

async function state() {
  const bots = await readBots();
  const out: Record<string, unknown> = {};
  for (const k of KINDS) {
    const b = bots[k];
    const mem = loadMemory(b.price_history);
    const { data: trades } = await db.from("trades").select("*").eq("bot", k).order("created_at", { ascending: false }).limit(60);
    out[k] = {
      ...b, price_history: undefined, lock_until: undefined, config: k === "spot" ? loadConfig(b.config) : loadPerpsConfig(b.config),
      positions: Object.values(migratePositions(mem, b)).map((p) => ({ key: p.key, symbol: p.symbol, side: p.side, entry: p.entry, stop: p.stop, best: p.best, live: p.live, openedAt: p.openedAt, strategy: p.strategy,
        source: p.source, partialDone: !!p.partialDone, interval: p.posInterval, target: p.target, why: p.why })),
      vault: Math.round((mem.vault ?? 0) * 100) / 100,
      curve: downsample(mem.curve ?? [], 120),
      memory: { strategy: mem.strategy, stop: mem.stop, best: mem.best, signal: mem.signal, mindset: mem.mindset, live: mem.live, asset: mem.asset, side: mem.side, openedAt: mem.openedAt, costUsd: mem.costUsd, pending: mem.pending ? { kind: mem.pending.kind, at: mem.pending.at } : null, errStreak: mem.errStreak ?? 0, cooldownUntil: mem.cooldownUntil ?? null },
      brain: mem.brain ? { risk: riskPerTrade(mem.brain), streak: mem.brain.streak, benched: mem.brain.benched, disabled: mem.brain.disabled, report: mem.brain.report ?? {}, preset: mem.brain.preset } : null,
      trades: trades ?? [],
    };
  }
  const [spotWallet, perpsWallet, { data: bilan }] = await Promise.all([getWalletAddress(), getPerpsWalletAddress(),
    db.from("agent_log").select("created_at, detail").eq("agent", "bilan").order("created_at", { ascending: false }).limit(1)]);
  return {
    now: new Date().toISOString(), wallets: { spot: spotWallet, perps: perpsWallet }, bilan: bilan?.[0] ?? null,
    protections: (({ breakerPct, breakerTrippedAt }) => ({ breakerPct, breakerTrippedAt }))(loadConfig(bots.spot.config)), bots: out, markets: MARKETS.map((m) => m.name),
    secrets: { anthropic: !!env("ANTHROPIC_API_KEY"), spotWallet: !!env("BOT_WALLET_PRIVATE_KEY"), perpsWallet: !!env("PERPS_WALLET_PRIVATE_KEY"), customRpc: !!env("SOLANA_RPC_URL"), telegram: !!(env("TELEGRAM_BOT_TOKEN") && env("TELEGRAM_CHAT_ID")), cron: cronReady },
    rules: { strategy: STRATEGY, risk: RISK, perps: PERPS_RULES, rules: RULES, presets: PRESETS, aggressive: AGGRESSIVE, aggrLevels: AGGR_LEVELS, leverages: LEVERAGES, vaultSteps: VAULT_STEPS, breakerSteps: BREAKER_STEPS, partial: PARTIAL },
  };
}

/** Un marché par appel : reste sous la limite de 2 s de calcul des fonctions Supabase. */
async function backtestMarket(i: number) {
  const m = MARKETS[i];
  if (!m) throw new Error("marché inconnu");
  const candles = await hourlyCandles(m.product, 1440);
  type R = ReturnType<typeof backtest>;
  const row = (name: string, r: R) => ({ name, trades: r.trades, winRate: r.winRate, profitFactor: Number.isFinite(r.profitFactor) ? r.profitFactor : null, returnPct: r.returnPct, maxDrawdownPct: r.maxDrawdownPct });
  const bots = await readBots();
  const pc = loadPerpsConfig(bots.perps.config);
  const bias = m.allowShort ? pc.bias : 0; // la barre longs/shorts s'applique au bot perps
  const presets = Object.entries(PRESETS).map(([name, params]) =>
    row(name, backtest(candles, { allowShort: m.allowShort, feePct: m.feePct, hourlyCost: m.hourlyCost, leverageCap: m.cap, params, bias })));
  if (m.allowShort) presets.push(row("agressif", backtest(candles, { allowShort: true, feePct: m.feePct, hourlyCost: m.hourlyCost,
    leverageCap: AGGRESSIVE.maxLeverage, params: PRESETS.rapide, risk: AGGRESSIVE.maxRisk, bias })));
  if (!m.allowShort) { // marchés spot : on compare aussi la stratégie RSI (tes réglages) et sa version naïve
    const rsi = loadConfig(bots.spot.config).rsi;
    presets.push(row("RSI", backtestRsi(candles, { ...rsi, naive: false }, m.feePct)));
    presets.push(row("RSI naïf", backtestRsi(candles, { ...rsi, naive: true }, m.feePct)));
  }
  return { market: m.name, days: Math.round(candles.length / 24), presets };
}

// ------------------------------------------------------------------ agent chercheur
type LiveStats = { trades: number; wins: number; pnlUsd: number; profitFactor: number; confirmed: boolean; failed: boolean; lastAt: string };
type ResearchRow = { id: number; created_at: string; market: string; product: string; symbol?: string | null; interval?: string | null; kind: "spot" | "perps"; family: Candidate["family"]; params: Candidate["params"]; train: Record<string, number>; test: Record<string, number>; score: number; verdict: string; why: string; live?: LiveStats | null; origin?: string | null; rationale?: string | null; validated_at?: string | null };

// ------------------------------------------------------------------ apprentissage croisé : le chercheur apprend des vrais trades des bots
// 6 trades réels minimum avant de confirmer ou d'abandonner une stratégie (4, c'était trop peu : la chance pouvait trancher)
const LIVE = { minTrades: 6, failPF: 0.8, confirmPF: 1.2, boost: 1.3, days: 45 };
/** Score effectif : une stratégie confirmée en réel passe devant, une stratégie qui déçoit en réel est écartée par son verdict. */
const effScore = (r: ResearchRow) => r.score * (r.live?.confirmed ? LIVE.boost : r.live?.failed ? 0 : 1);
// le réel prime sur le backtest : confirmées d'abord, puis non testées, déçues en dernier
const tier = (r: ResearchRow) => (r.live?.confirmed ? 2 : r.live?.failed ? 0 : 1);
const byRank = (a: ResearchRow, b: ResearchRow) => tier(b) - tier(a) || effScore(b) - effScore(a);

async function learnFromBots(): Promise<string[]> {
  const since = new Date(Date.now() - LIVE.days * 86_400_000).toISOString();
  const { data } = await db.from("trades").select("*").gt("created_at", since).limit(5000);
  const by = new Map<number, { pnl: number[]; lastAt: string }>();
  for (const t of (data ?? []) as { source?: string | null; pnl_usd?: number | null; created_at: string }[]) {
    const m = /chercheur #(\d+)/.exec(t.source ?? "");
    if (!m || typeof t.pnl_usd !== "number") continue; // seuls les trades clôturés comptent
    const e = by.get(+m[1]!) ?? { pnl: [], lastAt: t.created_at };
    e.pnl.push(t.pnl_usd); if (t.created_at > e.lastAt) e.lastAt = t.created_at;
    by.set(+m[1]!, e);
  }
  const news: string[] = [];
  for (const [id, e] of by) {
    const wins = e.pnl.filter((x) => x > 0), gw = wins.reduce((a, x) => a + x, 0), gl = -e.pnl.filter((x) => x <= 0).reduce((a, x) => a + x, 0);
    const pf = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
    const live: LiveStats = { trades: e.pnl.length, wins: wins.length, pnlUsd: Math.round((gw - gl) * 100) / 100, profitFactor: Math.round(pf * 100) / 100,
      confirmed: e.pnl.length >= LIVE.minTrades && pf >= LIVE.confirmPF, failed: e.pnl.length >= LIVE.minTrades && pf < LIVE.failPF, lastAt: e.lastAt };
    const { data: rows } = await db.from("research").select("*").eq("id", id).limit(1);
    const row = rows?.[0] as ResearchRow | undefined;
    if (!row) continue;
    const patch: Record<string, unknown> = { live };
    if (live.failed && row.verdict !== "déçue en réel") {
      patch.verdict = "déçue en réel"; patch.why = `perd en réel : ${live.trades} trades, PF ${live.profitFactor}, ${live.pnlUsd} $`;
      news.push(`#${id} ${row.market} déçoit en réel (PF ${live.profitFactor} sur ${live.trades} trades) : abandonnée`);
    } else if (live.confirmed && !row.live?.confirmed) news.push(`#${id} ${row.market} confirmée en réel (PF ${live.profitFactor} sur ${live.trades} trades) : priorité et risque plein`);
    await db.from("research").update(patch).eq("id", id);
  }
  if (news.length) await notify(`Chercheur : ${news.join(" ; ")}`);
  return news;
}
const INTERVALS: Interval[] = ["1h", "15m"];
/** Marchés étudiés : liste fixe + tokens choisis par le sélectionneur (historique on-chain). */
const researchMarkets = (): Market[] => [...RESEARCH_MARKETS, ...INTERVALS.flatMap((interval) => allTokens().filter((t) => t.extra === "selection" && t.active !== false).map((t) => ({
  name: `Spot ${t.symbol}${interval === "15m" ? " · 15 min" : ""}`, product: t.candles, symbol: t.symbol, kind: "spot" as const, interval, feePct: 0.004, hourlyCost: 0, cap: RISK.maxSpotFraction })))];
const RESEARCH_MARKETS: Market[] = INTERVALS.flatMap((interval) => [
  ...TOKENS.filter((t) => t.symbol !== "JUP").map((t) => ({ name: `Spot ${t.symbol}${interval === "15m" ? " · 15 min" : ""}`, product: t.candles, symbol: t.symbol,
    kind: "spot" as const, interval, feePct: 0.003, hourlyCost: 0, cap: RISK.maxSpotFraction })),
  ...PERPS_ASSETS.map((a) => ({ name: `Perps ${a.asset}${interval === "15m" ? " · 15 min" : ""}`, product: a.candles, symbol: a.asset,
    kind: "perps" as const, interval, feePct: 0.0012, hourlyCost: 0.00008, cap: PERPS_RULES.maxLeverage })),
]);
/** Historique utilisé : 90 jours en 1 h, 60 jours en 15 min (2/3 pour régler, 1/3 jamais vu pour valider : 20 jours en 15 min). */
const HISTORY: Record<Interval, number> = { "1h": 2160, "15m": 5760 };
/** Re-validation : chaque stratégie retenue est rejouée sur les données récentes au moins une fois par semaine. */
const REVALIDATE = { everyDays: 7, maxAgeDays: 10, perCycle: 3 };

/** Filtre BTC du bot spot rejoué dans le passé : à l'instant t, le BTC chutait-il ? (pour un backtest identique au réel) */
function btcFilterSeries(btc: Candle[]): (t: number) => boolean {
  const blocked = new Set<number>();
  for (let i = 30; i < btc.length; i++) if (marketFilter(btc.slice(Math.max(0, i - 229), i + 1)).blocked) blocked.add(btc[i]!.t);
  return (t: number) => blocked.has(Math.floor(t / 3_600_000) * 3_600_000 - 3_600_000);
}
const RESEARCH_BUDGET_MS = 1100; // calcul total d'un cycle (mathématicien + re-validation + chercheur), sous la limite de 2 s de Supabase
const RESEARCH_MAX = 40;

async function runResearch() {
  const cycle = Math.floor(Date.now() / 300_000);
  const A = agentSettings((await readBots()).spot.config);
  const fast = A.nerve >= 2;
  // nerveux : 2 cycles sur 3 consacrés au scalping 15 min
  const all = researchMarkets();
  // barre du chercheur : ce cycle est consacré au bot spot ou au bot perps selon la répartition choisie
  const side = researchSide(cycle, A.perps ?? 50);
  const bySide = all.filter((x) => x.kind === side);
  const base = bySide.length ? bySide : all;
  const pool = fast && cycle % 3 !== 0 ? base.filter((x) => x.interval === "15m") : base;
  const m = pool[Math.floor((Math.abs(Math.sin(cycle * 78.233) * 43758.5453) % 1) * pool.length)]!; // tirage uniforme : chaque marché du bot passe régulièrement
  let candles;
  try { candles = await getCandles(m.product, m.interval, HISTORY[m.interval]); }
  catch (e) { return { market: m.name, tested: 0, note: `historique indisponible : ${(e as Error).message}` }; }
  if (candles.length < HISTORY[m.interval] * 0.6) return { market: m.name, tested: 0, note: "historique insuffisant" };
  // contexte identique au réel : filtre BTC (spot) et taux de financement (perps)
  const ctx: { blockedAt?: (t: number) => boolean; extra?: Extra } = {};
  if (m.kind === "spot") { const btc = await getCandles("BTC-USD", "1h", Math.ceil(HISTORY[m.interval] * (m.interval === "15m" ? 0.25 : 1)) + 240).catch(() => null); if (btc?.length) ctx.blockedAt = btcFilterSeries(btc); }
  else { const f = await fundingHistory(m.symbol, candles[0]!.t - 86_400_000).catch(() => null); if (f && f.length > 100) ctx.extra = { funding: f }; }
  const [{ data: known }, { data: best }] = await Promise.all([
    db.from("research").select("key").eq("product", m.product).eq("kind", m.kind).eq("interval", m.interval).limit(20000),
    db.from("research").select("*").eq("product", m.product).eq("kind", m.kind).eq("interval", m.interval).order("score", { ascending: false }).limit(6),
  ]);
  const seen = new Set<string>((known ?? []).map((r: { key: string }) => r.key));
  const parents: Candidate[] = (best ?? []).filter((r: { score: number }) => r.score > 0)
    .map((r: ResearchRow) => ({ market: r.market, product: r.product, symbol: m.symbol, kind: r.kind, interval: m.interval, family: r.family, params: r.params }));
  const rnd = seeded(cycle * 7919 + Date.now() % 1000);
  const rows = [];
  const t0 = performance.now();
  const left = () => RESEARCH_BUDGET_MS - (performance.now() - t0);
  // 1. le mathématicien analyse la partie entraînement (jamais la période de validation) et propose ses stratégies en premier
  const train = candles.slice(0, Math.floor(candles.length * 2 / 3));
  const insight = analyze(train);
  const liveInsight = analyze(candles.slice(-300)); // régime EN DIRECT (300 dernières bougies) : oriente le pilote
  let proposed = 0;
  for (const pr of propose(train, m, insight, { aggressive: A.aggressive, fast })) {
    if (left() < RESEARCH_BUDGET_MS * 0.5) break; // le mathématicien prend au plus la moitié du temps de calcul
    const key = candidateKey(pr.candidate);
    if (seen.has(key)) continue;
    seen.add(key); proposed++;
    const e = evaluate(pr.candidate, candles, m, ctx);
    rows.push({ key, market: pr.candidate.market, product: pr.candidate.product, symbol: pr.candidate.symbol, interval: pr.candidate.interval, kind: pr.candidate.kind, family: pr.candidate.family, params: pr.candidate.params, train: e.train, test: e.test, score: e.score, verdict: e.verdict, why: e.why, origin: "mathématicien", rationale: pr.rationale });
  }
  await db.from("math_insights").upsert({ key: `${m.product}|${m.kind}|${m.interval}`, updated_at: new Date().toISOString(), market: m.name, kind: m.kind, interval: m.interval, regime: insight.regime, hurst: insight.hurst, ac1: insight.ac1, half_life: insight.halfLife, significant: insight.significant, vr: insight.vr, note: insight.note, proposed,
    live_regime: liveInsight.regime, live_note: liveInsight.note }, { onConflict: "key" });
  // 2. le chercheur : moitié améliorations des meilleures (y compris celles du mathématicien), moitié idées nouvelles
  let tries = 0;
  // RE-VALIDATION (au lieu d'expirer au bout de 14 jours) : les stratégies retenues de ce marché sont rejouées chaque semaine sur
  // l'historique le plus récent ; celles qui ne tiennent plus sont « périmées », les autres (dont les confirmées en réel) restent.
  // Elle passe avant les idées nouvelles : garder les bonnes stratégies à jour compte plus.
  const revalidated = await revalidate(m, candles, ctx, () => left() > RESEARCH_BUDGET_MS * 0.25).catch(() => [] as string[]);
  while (rows.length < RESEARCH_MAX && left() > 0 && tries < RESEARCH_MAX * 5) {
    tries++;
    // moitié améliorations des meilleures, moitié idées nouvelles
    const c = parents.length && rnd() < 0.5 ? mutate(rnd, parents[Math.floor(rnd() * parents.length)]!, fast) : randomCandidate(rnd, m, fast, !!ctx.extra?.funding);
    const key = candidateKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    const e = evaluate(c, candles, m, ctx);
    rows.push({ key, market: c.market, product: c.product, symbol: c.symbol, interval: c.interval, kind: c.kind, family: c.family, params: c.params, train: e.train, test: e.test, score: e.score, verdict: e.verdict, why: e.why, origin: "chercheur", rationale: null });
  }
  // chance ou talent : probabilité que le résultat sur la période jamais vue soit dû au hasard
  for (const r of rows) { const luck = luckProbability(r.test, seen.size); if (luck != null) r.test = { ...r.test, luck }; }
  if (rows.length) {
    const { error } = await db.from("research").upsert(rows, { onConflict: "key", ignoreDuplicates: true });
    if (error) throw new Error(`recherche : ${error.message}`);
  }
  // ménage : les stratégies rejetées depuis plus de 3 jours sont oubliées
  await db.from("research").delete().eq("verdict", "rejetée").lt("created_at", new Date(Date.now() - 3 * 86_400_000).toISOString());
  const learned = await learnFromBots().catch(() => [] as string[]);
  const pilot = await autopilot().catch((e) => `pilote : ${(e as Error).message}`);
  const math = rows.filter((r) => r.origin === "mathématicien");
  return { market: m.name, tested: rows.length, revalidated, promising: rows.filter((r) => r.verdict === "prometteuse").length, math: { regime: insight.regime, proposed: math.length, promising: math.filter((r) => r.verdict === "prometteuse").length }, learned, pilot };
}

async function revalidate(m: Market, candles: Candle[], ctx: { blockedAt?: (t: number) => boolean; extra?: Extra }, more: () => boolean): Promise<string[]> {
  const before = new Date(Date.now() - REVALIDATE.everyDays * 86_400_000).toISOString();
  const { data } = await db.from("research").select("*").eq("product", m.product).eq("kind", m.kind).eq("interval", m.interval)
    .neq("verdict", "rejetée").or(`validated_at.is.null,validated_at.lt.${before}`).order("score", { ascending: false }).limit(40);
  const rows = ((data ?? []) as ResearchRow[]).filter((r) => r.verdict === "prometteuse" || r.verdict === "à surveiller").filter((r) => (r.validated_at ?? r.created_at) < before).slice(0, REVALIDATE.perCycle);
  const out: string[] = [];
  for (const r of rows) {
    if (!more()) break;
    const c: Candidate = { market: r.market, product: r.product, symbol: m.symbol, kind: r.kind, interval: m.interval, family: r.family, params: r.params };
    const e = evaluate(c, candles, m, ctx);
    const keep = e.verdict !== "rejetée" || (r.live?.confirmed && e.test.profitFactor >= 1);
    const patch: Record<string, unknown> = { validated_at: new Date().toISOString(), train: e.train, test: { ...e.test, ...(r.test.luck != null ? { luck: r.test.luck } : {}) }, score: e.score };
    if (keep) patch.verdict = e.verdict === "rejetée" ? r.verdict : e.verdict;
    else { patch.verdict = "périmée"; patch.why = `ne tient plus sur les données récentes (${e.why})`; out.push(`#${r.id} ${r.market} périmée`); }
    await db.from("research").update(patch).eq("id", r.id);
  }
  return out;
}

// ------------------------------------------------------------------ pilote automatique
/** Critères stricts : seule une stratégie solide sur la période jamais vue peut piloter un bot. */
const QUALIFY = { minTestTrades: 5, minTestPF: 1.3, maxTestDD: 10, maxAgeDays: REVALIDATE.maxAgeDays };
/** Mode agressif des agents : critères assouplis (« à surveiller » accepté), plus de stratégies retenues mais moins sûres. */
const QUALIFY_AGGR = { minTestTrades: 4, minTestPF: 1.15, maxTestDD: 20, minTrainPF: 1.0, maxAgeDays: REVALIDATE.maxAgeDays };
interface AgentSettings { aggressive: boolean; nerve: number; perps?: number; soft?: boolean }
const agentSettings = (spotConfig: unknown): AgentSettings => { const c = loadConfig(spotConfig); return { aggressive: c.researchAggressive, nerve: c.nerve, perps: c.researchPerps, soft: c.extraSoft }; };
function qualifies(r: ResearchRow, a: AgentSettings = { aggressive: false, nerve: 1 }): boolean {
  // « fraîche » = créée ou re-validée sur des données récentes depuis moins de 10 jours (re-validation chaque semaine)
  const young = Date.now() - Date.parse(r.validated_at ?? r.created_at) < QUALIFY.maxAgeDays * 86_400_000;
  if (!young || r.verdict === "déçue en réel" || r.verdict === "périmée" || r.live?.failed) return false;
  const luck = r.test.luck;
  if (a.soft) { // mode extra souple : presque tout ce qui est positif sur la période jamais vue (risque divisé par 2 dans les bots)
    const t0 = tempo(r); if (a.nerve === 0 && t0 > 1) return false; if (a.nerve === 3 && t0 < 2) return false;
    return (r.test.trades ?? 0) >= EXTRA_SOFT.minTestTrades && (r.test.profitFactor ?? 0) >= EXTRA_SOFT.minTestPF && (r.test.maxDrawdownPct ?? 99) <= EXTRA_SOFT.maxTestDD;
  }
  if (luck != null && luck > (a.aggressive ? LUCK.rejectAggressive : LUCK.reject)) return false; // probablement de la chance
  const t = tempo(r);
  if (a.nerve === 0 && t > 1) return false;          // calme : pas de stratégie nerveuse
  if (a.nerve === 3 && t < 2) return false;          // très nerveux : seulement des stratégies nerveuses
  if (!a.aggressive) return r.verdict === "prometteuse" && (r.test.trades ?? 0) >= QUALIFY.minTestTrades && (r.test.profitFactor ?? 0) >= QUALIFY.minTestPF
    && (r.test.maxDrawdownPct ?? 99) <= QUALIFY.maxTestDD;
  const Q = QUALIFY_AGGR;
  return (r.verdict === "prometteuse" || r.verdict === "à surveiller") && (r.test.trades ?? 0) >= Q.minTestTrades && (r.test.profitFactor ?? 0) >= Q.minTestPF
    && (r.test.maxDrawdownPct ?? 99) <= Q.maxTestDD && (r.train.profitFactor ?? 0) >= Q.minTrainPF;
}
/** Classement du pilote : le réel d'abord, puis le score ; en mode nerveux, les stratégies rapides (plus de trades) passent devant. */
/** Régime en direct du marché d'une stratégie : la bonne famille passe devant (tendance ⇄ range/RSI). */
const REGIME_FIT = { match: 1.4, mismatch: 0.6 };
function regimeFit(r: ResearchRow, regimes: Map<string, string>) {
  const reg = regimes.get(`${r.product}|${r.kind}|${r.interval}`);
  if (!reg || reg === "hasard") return 1;
  const meanRev = r.family === "range" || r.family === "rsi" || r.family === "vwap";
  if (r.family === "orb" || r.family === "squeeze" || r.family === "volume" || r.family === "funding") return reg === "tendance" ? 1.2 : 1; // cassures : utiles partout
  return (reg === "tendance") === !meanRev ? REGIME_FIT.match : REGIME_FIT.mismatch;
}
async function liveRegimes(): Promise<Map<string, string>> {
  const { data } = await db.from("math_insights").select("key, live_regime").limit(200);
  return new Map(((data ?? []) as { key: string; live_regime?: string | null }[]).filter((x) => x.live_regime).map((x) => [x.key, x.live_regime!]));
}
const pilotRank = (a: AgentSettings, regimes = new Map<string, string>()) => (x: ResearchRow, y: ResearchRow) => {
  const boost = (r: ResearchRow) => effScore(r) * regimeFit(r, regimes) * (a.nerve >= 2 ? 1 + (a.nerve - 1) * 0.3 * tempo(r) : 1);
  return tier(y) - tier(x) || boost(y) - boost(x);
};
const symbolOfRow = (r: ResearchRow) => r.symbol ?? r.market.replace(/^(Spot|Perps) /, "").split(" ")[0]!;
const confidenceOf = (r: ResearchRow) => (r.live?.confirmed ? "confirmée" as const : "nouvelle" as const);
const spotFamily = (f: ResearchRow["family"]): SpotPlan["family"] => (f === "rsi" ? "rsi" : isSetup(f) && !PERPS_ONLY.includes(f) ? f as SpotPlan["family"] : "tendance");
const toSpotPlan = (r: ResearchRow): SpotPlan => ({ symbol: symbolOfRow(r), family: spotFamily(r.family),
  params: r.family === "rsi" ? sanitizeRsi({ ...(r.params as RsiParams), riskPct: 1, naive: false }) : isSetup(r.family) ? sanitizeSetup(r.family, r.params)! : sanitizeTrend(r.params)!,
  interval: r.interval === "15m" ? "15m" : "1h", source: `chercheur #${r.id} · ${r.market}`, score: effScore(r), confidence: confidenceOf(r) });
const toPerpsPlan = (r: ResearchRow): PerpsPlan => ({ asset: symbolOfRow(r), ...(isSetup(r.family) ? { family: r.family, params: sanitizeSetup(r.family, r.params as SetupParams)! } : { params: sanitizeTrend(r.params) as Params }), interval: r.interval === "15m" ? "15m" : "1h", source: `chercheur #${r.id} · ${r.market}`, score: effScore(r), confidence: confidenceOf(r) });

/** Choisit tout seul les tokens et stratégies des bots dont le pilote est activé. Renvoie un résumé des changements. */
async function autopilot(fresh = false): Promise<string> { // fresh : refaire le choix de zéro (après un changement de réglages)
  const bots = await readBots();
  const spotCfg = loadConfig(bots.spot.config), perpsCfg = loadPerpsConfig(bots.perps.config);
  if (!spotCfg.autopilot && !perpsCfg.autopilot) return "désactivé";
  const A = agentSettings(bots.spot.config);
  const { data } = A.soft ? await db.from("research").select("*").order("score", { ascending: false }).limit(600)
    : await db.from("research").select("*").neq("verdict", "rejetée").order("score", { ascending: false }).limit(300);
  const rows = (data ?? []) as ResearchRow[];
  let good = rows.filter((r) => qualifies(r, A)).sort(pilotRank(A, await liveRegimes()));
  if (A.soft) { // extra souple : si un bot n'a rien, il prend quand même la meilleure stratégie positive sur la période jamais vue
    for (const kind of ["spot", "perps"] as const) {
      if (good.some((r) => r.kind === kind)) continue;
      const fallback = rows.filter((r) => r.kind === kind && r.verdict !== "déçue en réel" && r.verdict !== "périmée" && !r.live?.failed && (r.test.returnPct ?? 0) > 0 && (r.test.trades ?? 0) >= 2).slice(0, 3);
      good = [...good, ...fallback];
    }
  }
  const changes: string[] = [];
  if (spotCfg.autopilot) {
    const spotRows = good.filter((r) => r.kind === "spot");
    // garde les plans actuels encore qualifiés (évite de changer d'avis toutes les 5 minutes), complète avec les meilleurs, 3 tokens max
    const keep = fresh ? [] : spotRows.slice(0, 10).filter((r) => spotCfg.plans.some((p) => p.source === `chercheur #${r.id} · ${r.market}`)).map(toSpotPlan);
    const plans = [...keep];
    for (const r of spotRows) { if (plans.length >= 3) break; const pl = toSpotPlan(r); if (!plans.some((x) => x.symbol === pl.symbol)) plans.push(pl); }
    const sig = (l: SpotPlan[]) => l.map((p) => `${p.source}:${p.confidence}`).join("|");
    const before = sig(spotCfg.plans), after = sig(plans);
    if (before !== after) {
      await setBot("spot", { config: { ...spotCfg, plans } });
      changes.push(plans.length ? `spot → ${plans.map((p) => `${p.symbol} (${FAMILY_NAMES[p.family] ?? p.family}, ${p.interval === "15m" ? "15 min" : "1 h"})`).join(", ")}` : "spot → aucune stratégie validée, en attente");
    }
  }
  if (perpsCfg.autopilot) {
    // une stratégie par marché (SOL, ETH, BTC) : garde celles encore qualifiées, complète avec les meilleures
    const perpsRows = good.filter((r) => r.kind === "perps");
    const plans: PerpsPlan[] = fresh ? [] : perpsRows.slice(0, 20).filter((r) => perpsCfg.plans.some((p) => p.source === `chercheur #${r.id} · ${r.market}`)).map(toPerpsPlan);
    for (const r of perpsRows) { if (plans.length >= perpsCfg.maxPositions) break; const pl = toPerpsPlan(r); if (!plans.some((x) => x.asset === pl.asset)) plans.push(pl); }
    const sig = (l: PerpsPlan[]) => l.map((p) => `${p.source}:${p.confidence}`).join("|");
    if (sig(plans) !== sig(perpsCfg.plans)) {
      await setBot("perps", { config: { ...perpsCfg, plans, plan: plans[0] ?? null } });
      changes.push(plans.length ? `perps → ${plans.map((p) => `${p.asset} (${FAMILY_NAMES[p.family ?? "tendance"]}, ${p.interval === "15m" ? "15 min" : "1 h"})`).join(", ")}, agressivité ${AGGR_LEVELS[effectiveAggr(perpsCfg)]!.name.toLowerCase()}` : "perps → aucune stratégie validée, en attente");
    }
  }
  if (changes.length) await notify(`Pilote automatique : ${changes.join(" ; ")}`);
  return changes.join(" ; ") || "inchangé";
}



async function researchBoard() {
  const [{ count }, { data: top }, { data: last }, bots] = await Promise.all([
    db.from("research").select("id", { count: "exact", head: true }),
    db.from("research").select("*").neq("verdict", "rejetée").order("score", { ascending: false }).limit(16),
    db.from("research").select("created_at").order("created_at", { ascending: false }).limit(1),
    readBots(),
  ]);
  const A = agentSettings(bots.spot.config);
  return {
    tested: count ?? 0, lastAt: last?.[0]?.created_at ?? null, settings: { ...A, levels: NERVE_LEVELS, qualify: A.aggressive ? QUALIFY_AGGR : QUALIFY },
    best: ((top ?? []) as ResearchRow[]).sort(byRank).map((r) => ({ ...r, description: describe({ ...r, interval: r.interval === "15m" ? "15m" : "1h" }), qualifies: qualifies(r, A), tempo: tempo(r) })),
  };
}

async function applyResearch(id: number) {
  const { data, error } = await db.from("research").select("*").eq("id", id).limit(1);
  if (error) throw new Error(error.message);
  const r = data?.[0] as ResearchRow | undefined;
  if (!r) throw new Error("stratégie introuvable");
  const bots = await readBots();
  const desc = describe({ ...r, interval: r.interval === "15m" ? "15m" : "1h" });
  if (r.kind === "spot") {
    const cur = loadConfig(bots.spot.config);
    const plan = toSpotPlan(r);
    const config = { ...cur, plans: [plan, ...cur.plans.filter((p) => p.symbol !== plan.symbol)].slice(0, 3) };
    await setBot("spot", { config });
    await notify(`Chercheur : stratégie #${r.id} ajoutée au bot spot (${plan.symbol}, ${desc})`);
    return { ok: true, kind: "spot", config };
  }
  const cur = loadPerpsConfig(bots.perps.config);
  const plan = toPerpsPlan(r);
  const plans = [plan, ...cur.plans.filter((p) => p.asset !== plan.asset)].slice(0, 3);
  const config = { ...cur, plans, plan: plans[0]! };
  await setBot("perps", { config });
  await notify(`Chercheur : stratégie #${r.id} appliquée au bot perps (${plan.asset}, ${desc})`);
  return { ok: true, kind: "perps", config };
}

// ------------------------------------------------------------------ agent swap (nettoyage des portefeuilles des bots)
const SWAP_EVERY_MS = 24 * 3_600_000;
async function runSwapAgent(trigger: "auto" | "manuel") {
  const results: Record<string, unknown> = {};
  for (const kind of KINDS) {
    const envKey = kind === "spot" ? "BOT_WALLET_PRIVATE_KEY" : "PERPS_WALLET_PRIVATE_KEY";
    if (!env(envKey)) { results[kind] = "wallet non configuré"; continue; }
    // même verrou que les bots : jamais un swap de l'agent pendant une décision de trading
    const store = await DbStore.claimWait(db, kind, 30_000);
    if (!store) { results[kind] = "bot occupé, réessai plus tard"; continue; }
    try {
      const bot = store.bot(kind);
      const mem = loadMemory(bot.price_history);
      const keep = new Set<string>([bot.position_mint, mem.pending?.mint].filter((x): x is string => !!x));
      const rep = await cleanWallet({ envKey, keepMints: keep, sellUniverse: kind === "perps" });
      const rows = [
        ...rep.sold.map((x) => ({ agent: "swap", wallet: kind, action: "vente", detail: `${x.symbol} revendu en USDC`, usd: x.usd, signature: x.sig })),
        ...(rep.closed ? [{ agent: "swap", wallet: kind, action: "fermeture", detail: `${rep.closed} compte(s) de tokens vide(s) fermé(s)`, sol: rep.solRecovered, signature: rep.closeSigs[0] ?? null }] : []),
        { agent: "swap", wallet: kind, action: "passage", detail: `${trigger} · ${rep.sold.length} vente(s), ${rep.closed} compte(s) fermé(s)${rep.errors.length ? ` · ${rep.errors.length} souci(s) : ${rep.errors.join(" ; ").slice(0, 200)}` : ""}${rep.skipped.length ? ` · ignorés : ${rep.skipped.slice(0, 4).join(" ; ")}` : ""}`, sol: rep.solRecovered, usd: rep.sold.reduce((a, x) => a + x.usd, 0) },
      ];
      await db.from("agent_log").insert(rows);
      if (rep.sold.length || rep.closed) await notify(`Agent swap (${kind}) : ${rep.sold.length ? `${rep.sold.map((x) => `${x.symbol} ${x.usd.toFixed(2)} $`).join(", ")} revendu(s) en USDC ; ` : ""}${rep.closed ? `${rep.closed} compte(s) fermé(s), +${rep.solRecovered.toFixed(4)} SOL récupérés` : ""}`);
      results[kind] = { vendus: rep.sold.length, comptesFermes: rep.closed, solRecupere: rep.solRecovered, ignores: rep.skipped, erreurs: rep.errors };
    } catch (e) {
      results[kind] = `erreur : ${(e as Error).message}`;
      await db.from("agent_log").insert({ agent: "swap", wallet: kind, action: "passage", detail: `${trigger} · erreur : ${(e as Error).message.slice(0, 200)}` });
    } finally {
      await store.release();
    }
  }
  return results;
}

// ------------------------------------------------------------------ bilan du soir (21 h, heure de Paris)
const BILAN_HOUR = 21;
function parisNow(d = new Date()) {
  const f = Object.fromEntries(new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${f.year}-${f.month}-${f.day}`, hour: Number(f.hour) % 24 };
}
async function eveningReport(force = false): Promise<string> {
  const { day, hour } = parisNow();
  if (!force && hour < BILAN_HOUR) return "pas encore l'heure";
  const { data: done } = await db.from("agent_log").select("id").eq("agent", "bilan").eq("wallet", day).limit(1);
  if (done?.length && !force) return "déjà fait";
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const [bots, { data: trades }, { data: found }] = await Promise.all([
    readBots(),
    db.from("trades").select("*").gt("created_at", since).limit(500),
    db.from("research").select("id").gt("created_at", since).eq("verdict", "prometteuse").limit(1000),
  ]);
  const lines: string[] = [];
  let pnlAll = 0;
  for (const k of KINDS) {
    const b = bots[k], mem = loadMemory(b.price_history), pos = Object.values(migratePositions(mem, b));
    const t = ((trades ?? []) as { bot: string; pnl_usd?: number | null; side?: string | null; action?: string | null }[])
      .filter((x) => x.bot === k && !["deposit", "withdraw"].includes(x.side ?? x.action ?? ""));
    const closed = t.filter((x) => typeof x.pnl_usd === "number"), pnl = closed.reduce((a, x) => a + (x.pnl_usd ?? 0), 0);
    pnlAll += pnl;
    const start = Number(b.start_value_usd) || null, v = b.last_value_usd;
    lines.push(`${k === "spot" ? "Bot 1 · spot" : "Bot 2 · perps"} (${b.status === "running" ? "en mission" : b.status === "paused" ? "en pause" : "arrêté"}) : ${v != null ? v.toFixed(2) + " $" : "—"}`
      + `${start && v != null ? ` (${v - start >= 0 ? "+" : ""}${(v - start).toFixed(2)} $ depuis le départ)` : ""} · ${t.length} trade(s) aujourd'hui, résultat ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} $`
      + `${mem.vault ? ` · coffre ${mem.vault.toFixed(2)} $` : ""}${pos.length ? ` · en position : ${pos.map((p) => `${p.side === "short" ? "short " : ""}${p.symbol}`).join(", ")}` : ""}.`);
  }
  const sc = loadConfig(bots.spot.config), pc = loadPerpsConfig(bots.perps.config);
  lines.push(`Chercheur et mathématicien : ${found?.length ?? 0} nouvelle(s) stratégie(s) prometteuse(s) en 24 h.`);
  lines.push(`Stratégies suivies : spot ${sc.plans.length ? sc.plans.map((p) => p.symbol).join(", ") : sc.autopilot ? "aucune validée" : "réglages de l'app"} · perps ${pc.plans.length ? pc.plans.map((p) => p.asset).join(", ") : pc.autopilot ? "aucune validée" : "réglages de l'app"}.`);
  const text = `Bilan du ${day.split("-").reverse().join("/")} : ${lines.join(" ")}`;
  await db.from("agent_log").insert({ agent: "bilan", wallet: day, action: "bilan", detail: text, usd: Math.round(pnlAll * 100) / 100 });
  await notify(text);
  return "envoyé";
}

async function swapAgentDue(): Promise<boolean> {
  if (!loadConfig((await readBots()).spot.config).swapAuto) return false;
  const { data } = await db.from("agent_log").select("created_at").eq("agent", "swap").eq("action", "passage").order("created_at", { ascending: false }).limit(1);
  const last = data?.[0]?.created_at as string | undefined;
  return !last || Date.now() - Date.parse(last) > SWAP_EVERY_MS;
}

async function mathBoard() {
  const count = async (origin: string, verdict?: string) => {
    let q = db.from("research").select("id", { count: "exact", head: true }).eq("origin", origin);
    if (verdict) q = q.eq("verdict", verdict);
    return (await q).count ?? 0;
  };
  const [{ data: insights }, mT, mP, cT, cP] = await Promise.all([
    db.from("math_insights").select("*").order("updated_at", { ascending: false }).limit(40),
    count("mathématicien"), count("mathématicien", "prometteuse"), count("chercheur"), count("chercheur", "prometteuse"),
  ]);
  const rate = (p: number, t: number) => (t ? Math.round((p / t) * 1000) / 10 : null);
  // comparaison honnête : les idées du mathématicien réussissent-elles plus souvent que les idées au hasard ?
  return { insights: insights ?? [], stats: { math: { tested: mT, promising: mP, rate: rate(mP, mT) }, chercheur: { tested: cT, promising: cP, rate: rate(cP, cT) } } };
}

async function agentsBoard() {
  const [{ data: log }, bots, math] = await Promise.all([
    db.from("agent_log").select("*").eq("agent", "swap").order("created_at", { ascending: false }).limit(40),
    readBots(), mathBoard(),
  ]);
  const rows = (log ?? []) as { created_at: string; action: string; sol?: number | null; usd?: number | null }[];
  const lastRun = rows.find((r) => r.action === "passage")?.created_at ?? null;
  return {
    swap: {
      auto: loadConfig(bots.spot.config).swapAuto, lastRun, nextRun: lastRun ? new Date(Date.parse(lastRun) + SWAP_EVERY_MS).toISOString() : null,
      totals: { sol: rows.filter((r) => r.action === "fermeture").reduce((a, r) => a + (r.sol ?? 0), 0), usd: rows.filter((r) => r.action === "vente").reduce((a, r) => a + (r.usd ?? 0), 0) },
      rules: CLEANER, log: rows.filter((r) => r.action !== "passage").slice(0, 15), runs: rows.filter((r) => r.action === "passage").slice(0, 5),
    },
    math,
    ...(await lot2Board().catch(() => ({}))),
  };
}

// ------------------------------------------------------------------ univers de tokens (sélectionneur + nouveaux tokens)
type UniverseRow = { mint: string; kind: "selection" | "nouveau"; symbol: string; decimals: number; pool?: string | null; liquidity?: number | null; volume_24h?: number | null; age_days?: number | null;
  score?: number | null; active: boolean; why?: string | null; data?: Record<string, unknown> | null; added_at: string; updated_at: string; seen_at?: string | null; removed_at?: string | null };
/** Source d'historique d'un token on-chain : Birdeye si la clé existe (GeckoTerminal en secours), sinon GeckoTerminal. */
const candleSource = (r: Pick<UniverseRow, "mint" | "pool">) => (env("BIRDEYE_API_KEY") ? `be:${r.mint}|${r.pool ?? ""}` : `gt:${r.pool}`);
async function loadUniverse() {
  // tokens actifs + tokens retirés depuis peu (ils peuvent encore être en portefeuille : le bot doit pouvoir les revendre)
  const since = Date.now() - 30 * 86_400_000;
  const { data } = await db.from("token_universe").select("*").limit(500);
  setExtraTokens(((data ?? []) as UniverseRow[]).filter((r) => r.pool && (!r.removed_at || Date.parse(r.removed_at) > since)).map((r): TokenInfo => ({
    ...((r.data as { program?: string } | null)?.program === "2022" ? { program: "2022" as const } : {}),
    symbol: r.symbol, mint: r.mint, decimals: r.decimals, candles: candleSource(r), verify: r.kind === "selection", extra: r.kind, active: r.active,
    ...(r.seen_at ? { seenAt: Date.parse(r.seen_at) } : {}) })));
}

/** SÉLECTIONNEUR : une fois par jour, les 20 à 30 meilleurs tokens Solana ; ceux qui ne passent plus les filtres sont retirés. */
async function runSelector(force = false): Promise<string> {
  const { day } = parisNow();
  if (!force) { // une fois par jour ; mais une sélection vide (souvent une panne de données) est refaite au bout d'une heure
    const { data } = await db.from("agent_log").select("created_at, usd").eq("agent", "selecteur").eq("wallet", day).order("created_at", { ascending: false }).limit(1);
    const last = data?.[0] as { created_at: string; usd?: number | null } | undefined;
    if (last && (last.usd ?? 0) > 0) return "déjà fait aujourd'hui";
    if (last && Date.now() - Date.parse(last.created_at) < 3_600_000) return "sélection vide récente : nouvel essai dans l'heure";
  }
  const fixed = new Set<string>(TOKENS.map((t) => t.mint));
  const { candidates, info } = await selectionCandidates(fixed);
  const ranked = rankSelection(candidates, info);
  const refused = ranked.refused;
  // pool le plus liquide pour l'historique des prix (DexScreener) ; sans pool, pas d'historique : token écarté
  const pools = await bestPools(ranked.selected.filter((c) => !c.pool).map((c) => c.mint));
  const selected = ranked.selected.map((c) => ({ ...c, pool: c.pool || pools[c.mint] || "" })).filter((c) => c.pool);
  if (!selected.length && !candidates.length) throw new Error("aucune donnée de marché");
  const { data: cur } = await db.from("token_universe").select("*").eq("kind", "selection").limit(500);
  const current = (cur ?? []) as UniverseRow[];
  const now = new Date().toISOString(), keep = new Set(selected.map((c) => c.mint));
  const symbols = new Set<string>(TOKENS.map((t) => t.symbol));
  const added: string[] = [], removed: string[] = [];
  for (const c of selected) {
    if (symbols.has(c.symbol)) continue; // même symbole qu'un token de la liste fixe : ignoré (éviter toute confusion)
    symbols.add(c.symbol);
    const was = current.find((r) => r.mint === c.mint);
    if (!was?.active) added.push(c.symbol);
    await db.from("token_universe").upsert({ mint: c.mint, kind: "selection", symbol: c.symbol, decimals: c.decimals, pool: c.pool, liquidity: c.liquidity, volume_24h: c.volume24h, age_days: c.ageDays,
      score: Math.round(Math.sqrt(c.volume24h * c.liquidity)), active: true, why: "passe tous les filtres", updated_at: now, removed_at: null, ...(was ? {} : { added_at: now }) }, { onConflict: "mint" });
  }
  for (const r of current.filter((x) => x.active && !keep.has(x.mint))) {
    const why = refused.find((c) => c.mint === r.mint)?.why ?? "n'est plus parmi les meilleurs tokens";
    removed.push(`${r.symbol} (${why})`);
    await db.from("token_universe").update({ active: false, why, removed_at: now, updated_at: now }).eq("mint", r.mint);
  }
  const reasons: Record<string, number> = {};
  for (const c of refused) { const k = (c.why ?? "?").split(" (")[0]!.replace(/\d[\d\s]*\s?(k\$|M\$|jours?)/g, "").trim(); reasons[k] = (reasons[k] ?? 0) + 1; }
  const why = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n})`).join(", ");
  const text = `Sélection du jour : ${selected.length} token(s) retenus sur ${candidates.length} candidats${why ? ` · refus : ${why}` : ""}${added.length ? ` · ajoutés : ${added.join(", ")}` : ""}${removed.length ? ` · retirés : ${removed.join(", ")}` : ""}.`;
  await db.from("agent_log").insert({ agent: "selecteur", wallet: day, action: "selection", detail: text, usd: selected.length });
  if (added.length || removed.length) await notify(text);
  return text;
}

/** NOUVEAUX TOKENS : repère les lancements récents qui passent les garde-fous (achat seulement si l'agent est activé). */
async function runFreshScout(): Promise<string> {
  const { data: cur } = await db.from("token_universe").select("mint, kind, active, added_at").limit(1000);
  const known = new Set<string>([...TOKENS.map((t) => t.mint), ...((cur ?? []) as UniverseRow[]).map((r) => r.mint)]);
  // les « nouveaux » de plus de 24 h ne sont plus des nouveaux
  const old = new Date(Date.now() - FRESH.maxAgeH * 3_600_000).toISOString();
  await db.from("token_universe").update({ active: false, removed_at: new Date().toISOString(), why: "plus de 24 h" }).eq("kind", "nouveau").eq("active", true).lt("added_at", old);
  const soft = loadConfig((await readBots()).spot.config).extraSoft;
  const { list, info } = await freshCandidates(known, soft);
  const ok = [], refusals: Record<string, number> = {};
  for (const f of list) {
    let why = freshRefusal(f, info.get(f.mint), soft);
    if (!why && f.program === "2022") why = await token2022Danger(f.mint).catch(() => "contrôle Token-2022 indisponible"); // frais cachés, transferts bloquables…
    if (why) { const k = why.split(" (")[0]!.split(" :")[0]!; refusals[k] = (refusals[k] ?? 0) + 1; continue; }
    if (!f.decimals) continue;
    ok.push(f);
    const now = new Date().toISOString();
    await db.from("token_universe").upsert({ mint: f.mint, kind: "nouveau", symbol: f.symbol, decimals: f.decimals, pool: f.pool, liquidity: f.liquidity, volume_24h: f.volume1h * 24, age_days: f.ageMin / 1440,
      score: f.change1h, active: true, why: "garde-fous passés", data: { change1h: f.change1h, buys1h: f.buys1h, sells1h: f.sells1h, topHolders: f.topHolders, ...(f.program ? { program: f.program } : {}) }, added_at: now, updated_at: now, seen_at: now }, { onConflict: "mint" });
  }
  const top = Object.entries(refusals).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`).join(", ");
  const text = `${list.length} lancement(s) examiné(s), ${ok.length} retenu(s)${ok.length ? ` : ${ok.map((f) => f.symbol).join(", ")}` : ""}${top ? ` · refus : ${top}` : ""}`;
  if (list.length) await db.from("agent_log").insert({ agent: "nouveaux", wallet: "spot", action: "scan", detail: text, usd: ok.length });
  await db.from("agent_log").delete().eq("agent", "nouveaux").lt("created_at", new Date(Date.now() - 3 * 86_400_000).toISOString());
  return text;
}

/** ARBITRAGE ÉCLAIREUR : écarts de prix entre DEX et boucles de swaps, frais déduits ; aucun argent engagé. */
async function runArbScout(): Promise<string> {
  const tokens = allTokens().filter((t) => t.extra !== "nouveau" && t.active !== false);
  const cycle = Math.floor(Date.now() / 300_000);
  const obs = await arbScan(tokens, 3, cycle * 3);
  if (!obs.length) return "aucune donnée";
  const best = [...obs].sort((a, b) => b.netPct - a.netPct)[0]!;
  const rows = obs.filter((o) => o.netPct > 0 || o === best).map((o) => ({ kind: o.kind, token: o.token, detail: o.detail, gross_pct: Math.round(o.grossPct * 1000) / 1000, net_pct: Math.round(o.netPct * 1000) / 1000 }));
  await db.from("arb_log").insert(rows);
  await db.from("arb_log").delete().lt("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString());
  return `${obs.length} mesure(s), meilleure : ${best.token} ${best.kind} ${best.netPct.toFixed(2)} % net`;
}

/** CHIEN DE GARDE : un bot en mission qui ne se contrôle plus depuis 5 minutes déclenche une alerte (au plus une par heure). */
async function runWatchdog(): Promise<string> {
  const bots = await readBots(), out: string[] = [];
  for (const k of KINDS) {
    const b = bots[k];
    if (b.status !== "running") continue;
    const age = b.last_tick_at ? (Date.now() - Date.parse(b.last_tick_at)) / 60_000 : Infinity;
    if (age < 5) continue;
    const { data } = await db.from("agent_log").select("id").eq("agent", "garde").eq("wallet", k).gt("created_at", new Date(Date.now() - 3_600_000).toISOString()).limit(1);
    if (data?.length) { out.push(`${k} : déjà signalé`); continue; }
    const text = `${k === "spot" ? "Bot spot" : "Bot perps"} : aucun contrôle depuis ${Number.isFinite(age) ? Math.round(age) + " minutes" : "le démarrage"}. Les positions perps gardent leur stop on-chain ; vérifie l'app.`;
    await db.from("agent_log").insert({ agent: "garde", wallet: k, action: "alerte", detail: text });
    await notify(text); out.push(text);
  }
  return out.join(" · ") || "tout va bien";
}

/** Tableau des nouveaux agents (onglet Agents). */
async function lot2Board() {
  const [{ data: uni }, { data: logs }, { data: arb }, { count: subs }, bots] = await Promise.all([
    db.from("token_universe").select("*").order("score", { ascending: false }).limit(200),
    db.from("agent_log").select("*").in("agent", ["selecteur", "nouveaux", "garde"]).order("created_at", { ascending: false }).limit(40),
    db.from("arb_log").select("*").order("created_at", { ascending: false }).limit(300),
    db.from("push_subs").select("endpoint", { count: "exact", head: true }),
    readBots(),
  ]);
  const U = (uni ?? []) as UniverseRow[], L = (logs ?? []) as { agent: string; created_at: string; detail: string }[], A = (arb ?? []) as { created_at: string; kind: string; token: string; detail: string; net_pct: number; gross_pct: number }[];
  const pos = A.filter((x) => x.net_pct > 0);
  return {
    selector: { tokens: U.filter((r) => r.kind === "selection" && r.active), removed: U.filter((r) => r.kind === "selection" && !r.active).slice(0, 10), last: L.find((x) => x.agent === "selecteur") ?? null, rules: SELECT },
    fresh: { on: loadConfig(bots.spot.config).newTokens, tokens: U.filter((r) => r.kind === "nouveau" && r.active), last: L.filter((x) => x.agent === "nouveaux").slice(0, 5), rules: FRESH },
    arb: { measures: A.length, positives: pos.length, best: [...A].sort((a, b) => b.net_pct - a.net_pct).slice(0, 5), since: A.at(-1)?.created_at ?? null },
    watchdog: { last: L.filter((x) => x.agent === "garde").slice(0, 5) },
    push: { subscribers: subs ?? 0 },
  };
}

/** BILAN PAR STRATÉGIE : résultats réels de chaque stratégie (60 derniers jours). */
async function strategyReport() {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const { data } = await db.from("trades").select("*").gt("created_at", since).limit(5000);
  const by = new Map<string, { source: string; bot: string; trades: number; wins: number; gain: number; loss: number; last: string }>();
  for (const t of (data ?? []) as { bot: string; source?: string | null; pnl_usd?: number | null; created_at: string }[]) {
    if (typeof t.pnl_usd !== "number") continue;
    const key = `${t.bot}|${t.source ?? "réglages de l'app"}`;
    const e = by.get(key) ?? { source: t.source ?? "réglages de l'app", bot: t.bot, trades: 0, wins: 0, gain: 0, loss: 0, last: t.created_at };
    e.trades++; if (t.pnl_usd > 0) { e.wins++; e.gain += t.pnl_usd; } else e.loss -= t.pnl_usd;
    if (t.created_at > e.last) e.last = t.created_at;
    by.set(key, e);
  }
  const ids = [...by.values()].map((e) => /chercheur #(\d+)/.exec(e.source)?.[1]).filter(Boolean).map(Number);
  const { data: rs } = ids.length ? await db.from("research").select("id, family, interval, market").in("id", ids) : { data: [] };
  const fam = new Map(((rs ?? []) as { id: number; family: string; interval: string }[]).map((r) => [r.id, r]));
  return { since, rows: [...by.values()].map((e) => { const id = Number(/chercheur #(\d+)/.exec(e.source)?.[1]); const r = fam.get(id);
    return { ...e, pnl: Math.round((e.gain - e.loss) * 100) / 100, winRate: Math.round((e.wins / e.trades) * 100), profitFactor: e.loss > 0 ? Math.round((e.gain / e.loss) * 100) / 100 : e.gain > 0 ? 99 : 0,
      family: r?.family ?? null, interval: r?.interval ?? null }; }).sort((a, b) => b.pnl - a.pnl) };
}

// ------------------------------------------------------------------ graphiques (positions, mini-jeu) et backtest visuel
const productOf = (symbol: string, kind: "spot" | "perps") => kind === "perps" ? PERPS_ASSETS.find((a) => a.asset === symbol)?.candles : allTokens().find((t) => t.symbol === symbol)?.candles;
async function chartData(symbol: string, kind: "spot" | "perps", interval: Interval, count: number) {
  const product = productOf(symbol, kind);
  if (!product) throw new Error("marché inconnu");
  const c = await getCandles(product, interval, Math.min(1000, Math.max(30, count)));
  const { data: trades } = await db.from("trades").select("*").eq("bot", kind).gt("created_at", new Date(c[0]?.t ?? Date.now()).toISOString()).limit(200);
  const mine = ((trades ?? []) as { symbol?: string; asset?: string; side?: string; action?: string; price?: number; created_at: string; pnl_usd?: number }[])
    .filter((t) => (t.symbol ?? t.asset) === symbol && t.price).map((t) => ({ t: Date.parse(t.created_at), price: t.price, what: t.side ?? t.action, pnl: t.pnl_usd ?? null }));
  return { symbol, kind, interval, candles: c.map((x) => [x.t, x.o, x.h, x.l, x.c]), trades: mine };
}
/** Backtest visuel : rejoue une stratégie du chercheur sur l'historique récent et renvoie les trades et la courbe. */
async function researchSim(id: number) {
  const { data } = await db.from("research").select("*").eq("id", id).limit(1);
  const r = data?.[0] as ResearchRow | undefined;
  if (!r) throw new Error("stratégie introuvable");
  const iv: Interval = r.interval === "15m" ? "15m" : "1h";
  const m = researchMarkets().find((x) => x.product === r.product && x.kind === r.kind && x.interval === iv);
  if (!m) throw new Error("marché introuvable");
  const candles = await getCandles(m.product, iv, HISTORY[iv]);
  const ctx: { extra?: Extra } = r.family === "funding" ? { extra: { funding: await fundingHistory(m.symbol, candles[0]!.t - 86_400_000).catch(() => []) } } : {};
  const res = simulate({ market: r.market, product: r.product, symbol: m.symbol, kind: r.kind, interval: iv, family: r.family, params: r.params }, candles, m, ctx);
  let eq = 1; const curve = res.log.map((t) => ({ t: t.t, v: Math.round((eq *= 1 + t.pnlPct / 100) * 10000) / 10000 }));
  const step = Math.max(1, Math.floor(candles.length / 300));
  return { id, market: r.market, family: r.family, interval: iv, description: describe({ ...r, interval: iv }), split: candles[Math.floor(candles.length * 2 / 3)]?.t ?? null,
    candles: candles.filter((_, i) => i % step === 0 || i === candles.length - 1).map((x) => [x.t, x.c]),
    trades: res.log.map((t) => ({ t: t.t, t0: t.t0 ?? null, side: t.side, entry: t.entry, exit: t.exit, pnl: Math.round(t.pnlPct * 100) / 100, reason: t.reason })).slice(-150), curve,
    stats: { trades: res.trades, winRate: Math.round(res.winRate), profitFactor: Number.isFinite(res.profitFactor) ? Math.round(res.profitFactor * 100) / 100 : 99, returnPct: Math.round(res.returnPct * 100) / 100, maxDrawdownPct: Math.round(res.maxDrawdownPct * 100) / 100 } };
}

// ------------------------------------------------------------------ notifications push
let VAPID: Vapid | null = null;
async function vapid(): Promise<Vapid> {
  if (VAPID) return VAPID;
  const { data } = await db.from("app_kv").select("value").eq("key", "vapid").limit(1);
  const v = (data?.[0] as { value?: Vapid } | undefined)?.value;
  if (v?.publicKey && v.privateJwk) return (VAPID = v);
  const fresh = await newVapid("mailto:pulse@ramos-pulse.github.io");
  await db.from("app_kv").upsert({ key: "vapid", value: fresh, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return (VAPID = fresh);
}
async function pushAll(text: string): Promise<number> {
  const { data } = await db.from("push_subs").select("*").limit(20);
  const subs = (data ?? []) as Subscription[];
  if (!subs.length) return 0;
  const v = await vapid();
  let sent = 0;
  for (const sub of subs) {
    const st = await sendPush(sub, v, { title: "Pulse", body: text.slice(0, 300), tag: text.startsWith("Bilan") ? "bilan" : undefined, url: "./" }).catch(() => 0);
    if (st === 404 || st === 410) await db.from("push_subs").delete().eq("endpoint", sub.endpoint);
    else if (st >= 200 && st < 300) sent++;
  }
  return sent;
}
pushHook.send = (text) => pushAll(text).then(() => undefined);

// ------------------------------------------------------------------ discussion avec le chercheur
async function agentChat(messages: { role: string; content: string }[]) {
  const board = await researchBoard();
  const st = await state();
  const bots = st.bots as Record<string, { status: string; last_value_usd: number | null; last_message: string | null; config: unknown; memory: { mindset?: string; signal?: string } }>;
  const context = {
    date: new Date().toISOString(),
    bots: Object.fromEntries(Object.entries(bots).map(([k, b]) => [k, { statut: b.status, valeur_usd: b.last_value_usd, derniere_action: b.last_message, pensee: b.memory?.mindset, analyse: b.memory?.signal, reglages: b.config }])),
    recherche: { strategies_testees: board.tested, meilleures: board.best.slice(0, 8).map((r) => ({ id: r.id, marche: r.market, type: r.family, description: r.description, verdict: r.verdict, entrainement: r.train, validation_jamais_vue: r.test, resultats_reels: r.live ?? "pas encore tradée", score: r.score, origine: r.origin ?? "chercheur", justification_mathematique: r.rationale ?? undefined })) },
    reglages_agents: { ...board.settings, nervosite: NERVE_LEVELS[board.settings.nerve] },
    mathematicien: await mathBoard().then((m) => ({ taux_de_reussite: m.stats, analyses: m.insights.slice(0, 16).map((x: Record<string, unknown>) => ({ marche: x.market, intervalle: x.interval, regime: x.regime, hurst: x.hurst, demi_vie: x.half_life, significatif: x.significant, conclusion: x.note })) })).catch(() => "indisponible"),
  };
  const key = env("ANTHROPIC_API_KEY");
  if (!key) {
    const top = board.best.slice(0, 3);
    return { reply: `Je cherche en continu : ${board.tested} stratégies testées pour l'instant. ` +
      (top.length ? `Mes meilleures pistes : ${top.map((r) => `#${r.id} ${r.market} (${r.description}) : validation ${r.test.returnPct?.toFixed(1)} %, PF ${r.test.profitFactor?.toFixed(2)}, ${r.verdict}`).join(" ; ")}.`
        : "Aucune stratégie n'a encore passé la validation sur une période jamais vue : je continue de chercher.") +
      ` Pour discuter librement avec moi, ajoute le secret ANTHROPIC_API_KEY dans Supabase.`, ai: false };
  }
  const system = `Tu es « le Chercheur », l'agent de recherche de stratégies de l'app Pulse (bots de trading Solana : un bot spot et un bot perps SOL).
Tu parles uniquement en français, de façon directe et concise (moins de 150 mots sauf demande contraire), comme sur un téléphone.
Ton rôle : expliquer ce que tu as trouvé, comparer les stratégies, conseiller laquelle essayer, et rester honnête.
Règles :
- Tu ne promets jamais de gains. Les backtests sont des simulations du passé.
- Une stratégie ne compte que si elle gagne aussi sur la période de validation jamais vue ; méfie-toi des résultats fondés sur peu de trades.
- Quand le pilote automatique est activé, c'est toi qui choisis les tokens et stratégies des bots, mais seulement parmi les stratégies « prometteuses » avec au moins 5 trades, un profit factor ≥ 1,3 et une baisse max ≤ 10 % sur la période jamais vue, et toujours en mode perps normal. Les plans actuels sont dans reglages.plans (spot) et reglages.plan (perps).
- Tu ne modifies rien pendant la discussion : pour appliquer une stratégie à la main, l'utilisateur touche « Appliquer » sur la stratégie #id, ou active le pilote automatique.
- Le scalping est testé en bougies de 15 minutes, frais inclus ; dis-le clairement quand une stratégie 15 min est retenue ou rejetée.
- Tu apprends des vrais trades des bots (resultats_reels) : une stratégie qui perd en réel après 4 trades est déclassée « déçue en réel », une qui gagne est « confirmée » et prioritaire. Une stratégie nouvelle est tradée avec 75 % du risque normal tant qu'elle n'est pas confirmée. Les résultats réels comptent plus que les simulations.
- Tu travailles avec l'agent mathématicien (donnees.mathematicien) : sur la partie entraînement de l'historique seulement, il mesure le ratio de variance de Lo-MacKinlay (test z, significatif si |z| > 1,96), l'exposant de Hurst, l'autocorrélation et la demi-vie du retour à la moyenne, en déduit le régime du marché (tendance, retour à la moyenne, ou hasard) et des réglages, puis te les propose. Tu testes ses propositions comme les tiennes, sur la période jamais vue. Explique ses conclusions simplement quand on te le demande, et sois honnête : un marché « hasard » n'a pas d'avantage exploitable, et son taux de réussite comparé au tien dit si ses maths aident vraiment.
- Réglages des agents (donnees.reglages_agents) : en mode agressif, le pilote accepte aussi les stratégies « à surveiller » (≥ 4 trades, PF ≥ 1,15, baisse ≤ 20 %, entraînement PF ≥ 1) et le bot perps applique son agressivité même en pilote automatique ; sinon il reste plafonné à « Normal ». La nervosité (Calme, Normal, Nerveux, Très nerveux) oriente la recherche vers des stratégies plus rapides (15 min, cassures courtes) et le pilote vers celles qui tradent plus souvent. Rappelle que plus nerveux ou plus agressif = plus de trades et plus de risque, pas forcément plus de gains.
- Familles de stratégies : « tendance » (cassure, ou achat sur repli vers la moyenne 20 si params.entry = "repli"), « rsi » (spot : achat d'excès de baisse), « range » (perps : bandes de Bollinger, long sous la bande basse, short au-dessus de la bande haute, objectif le retour à la moyenne, seulement en marché sans tendance). Le mathématicien mesure aussi le régime EN DIRECT de chaque marché (live_regime) : le pilote favorise la famille qui colle au régime (tendance ⇄ range/RSI).
- Chaque stratégie a une « chance » (test.luck) : probabilité, estimée par le mathématicien, que son résultat sur la période jamais vue soit dû au hasard, compte tenu du nombre de stratégies essayées. Au-dessus de 50 % (80 % en mode agressif), le pilote l'écarte. Explique-le simplement si on te le demande.
- Protections des bots : coffre à gains (une part de chaque gain n'est plus retradée), disjoncteur global (tout s'arrête si les deux bots perdent plus de X % ensemble), filtre BTC pour le spot, prise de bénéfices partielle (spot : moitié vendue à +1,5 R ; perps : stop au prix d'entrée à +1,5 R), jusqu'à 3 positions par bot avec un risque total plafonné.
- Tu ne donnes pas de conseil d'investissement personnalisé ; rappelle de ne risquer que ce qu'on accepte de perdre si on te demande combien investir.
- Le mode agressif du bot perps double le risque et monte le levier jusqu'à x5 : signale-le si c'est pertinent.
Données actuelles (JSON) :
${JSON.stringify(context)}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: env("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5", max_tokens: 700, system,
      messages: messages.slice(-12).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 2000) })),
    }),
  });
  const j = (await res.json()) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Claude : ${j.error?.message ?? res.status}`);
  return { reply: (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim() || "…", ai: true };
}

// ------------------------------------------------------------------ routeur
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*?\/pulse/, "") || "/";
  if (!db) return json({ error: "Clé service Supabase introuvable : ajoute le secret PULSE_SERVICE_KEY (Project Settings → API Keys → clé secret/service_role)." }, 500);
  try {
    if (route === "/research" && req.method === "POST") {
      if (!TOKEN || !safeEqual(req.headers.get("x-cron-secret") ?? "", await cronSecret())) return json({ error: "interdit" }, 403);
      await loadUniverse().catch(() => null);
      const err = (e: unknown) => `erreur : ${(e as Error).message}`;
      // chaque agent est indépendant : la panne de l'un n'empêche jamais les autres de tourner
      const watchdog = await runWatchdog().catch(err);
      const research = await runResearch().catch(err);
      const swap = (await swapAgentDue().catch(() => false)) ? await runSwapAgent("auto").catch(err) : "pas encore l'heure";
      const bilan = await eveningReport().catch(err);
      const selector = await runSelector().catch(err);
      const fresh = await runFreshScout().catch(err);
      const arb = await runArbScout().catch(err);
      return json({ watchdog, research, swap, bilan, selector, fresh, arb });
    }
    if (route === "/tick" && req.method === "POST") {
      if (!TOKEN || !safeEqual(req.headers.get("x-cron-secret") ?? "", await cronSecret())) return json({ error: "interdit" }, 403);
      // les deux bots tournent en parallèle et indépendamment : la panne de l'un ne bloque jamais l'autre
      await loadUniverse().catch(() => null); // tokens des agents : le bot spot doit pouvoir les évaluer et les revendre
      const breaker = await checkBreaker().catch((e) => `disjoncteur : ${(e as Error).message}`);
      if (breaker && breaker.startsWith("DÉCLENCHÉ")) return json({ breaker });
      const results = await Promise.all(KINDS.map((k) => tickBot(k).catch((e: unknown) => `erreur : ${String(e)}`)));
      return json({ spot: results[0], perps: results[1], ...(breaker ? { breaker } : {}) });
    }
    if (!route.startsWith("/api/")) return json({ ok: true, app: "pulse" });
    if (!TOKEN) return json({ error: "Secret DASHBOARD_TOKEN manquant dans Supabase" }, 401);
    if (!safeEqual((req.headers.get("x-token") ?? "").trim(), TOKEN)) return json({ error: "token invalide" }, 401);
    await ensureCron();
    await loadUniverse().catch(() => null);

    if (req.method === "GET" && route === "/api/state") return json(await state());
    if (req.method === "GET" && route === "/api/research") return json(await researchBoard());
    if (req.method === "POST" && route === "/api/research/apply") {
      const body = (await req.json().catch(() => ({}))) as { id?: number };
      return json(await applyResearch(Number(body.id)));
    }
    if (req.method === "POST" && route === "/api/research/run") return json(await runResearch()); // lancer une recherche tout de suite
    if (req.method === "GET" && route === "/api/agents") return json(await agentsBoard());
    if (req.method === "GET" && route === "/api/report") return json(await strategyReport());
    if (req.method === "GET" && route === "/api/curve") { // courbes complètes du capital (un point par heure, 30 jours) pour le grand graphique
      const bots = await readBots();
      return json(Object.fromEntries(KINDS.map((k) => [k, loadMemory(bots[k].price_history).curve ?? []])));
    }
    if (req.method === "GET" && route === "/api/chart") return json(await chartData(url.searchParams.get("symbol") ?? "SOL", url.searchParams.get("kind") === "perps" ? "perps" : "spot", url.searchParams.get("interval") === "15m" ? "15m" : "1h", Number(url.searchParams.get("count") ?? 120)));
    if (req.method === "GET" && route === "/api/research/sim") return json(await researchSim(Number(url.searchParams.get("id"))));
    if (req.method === "GET" && route === "/api/push/key") return json({ key: (await vapid()).publicKey });
    if (req.method === "POST" && route === "/api/push/subscribe") {
      const b = (await req.json().catch(() => ({}))) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      if (!b.endpoint?.startsWith("https://") || !b.keys?.p256dh || !b.keys?.auth) return json({ error: "abonnement invalide" }, 400);
      await db.from("push_subs").upsert({ endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth }, { onConflict: "endpoint" });
      return json({ ok: true });
    }
    if (req.method === "POST" && route === "/api/push/unsubscribe") {
      const b = (await req.json().catch(() => ({}))) as { endpoint?: string };
      if (b.endpoint) await db.from("push_subs").delete().eq("endpoint", b.endpoint);
      return json({ ok: true });
    }
    if (req.method === "POST" && route === "/api/push/test") return json({ sent: await pushAll("Test : les notifications de Pulse fonctionnent ✅") });
    if (req.method === "POST" && route === "/api/agents/selector/run") return json({ result: await runSelector(true) });
    if (req.method === "POST" && route === "/api/extra-soft") {
      const b = (await req.json().catch(() => ({}))) as { on?: boolean };
      const bots = await readBots(), on = b.on === true;
      await setBot("spot", { config: { ...loadConfig(bots.spot.config), extraSoft: on } });
      await setBot("perps", { config: { ...loadPerpsConfig(bots.perps.config), extraSoft: on } });
      await notify(on ? "Mode EXTRA SOUPLE activé : critères très assouplis, risque divisé par 2 sur chaque trade" : "Mode extra souple coupé : retour aux critères normaux");
      return json({ ok: true, on, pilot: await autopilot(true).catch((e) => `pilote : ${(e as Error).message}`) });
    }
    if (req.method === "POST" && route === "/api/agents/fresh") {
      const b = (await req.json().catch(() => ({}))) as { on?: boolean };
      const sc = loadConfig((await readBots()).spot.config);
      await setBot("spot", { config: { ...sc, newTokens: b.on === true } });
      await notify(`Agent nouveaux tokens : ${b.on === true ? "ACTIVÉ (toute petite mise, garde-fous stricts)" : "désactivé"}`);
      return json({ ok: true, on: b.on === true });
    }
    if (req.method === "POST" && route === "/api/bilan") return json({ result: await eveningReport(true) });
    if (req.method === "POST" && route === "/api/agents/swap/run") return json(await runSwapAgent("manuel"));
    if (req.method === "POST" && route === "/api/agents/swap/auto") {
      const body = (await req.json().catch(() => ({}))) as { on?: boolean };
      const sc = loadConfig((await readBots()).spot.config);
      await setBot("spot", { config: { ...sc, swapAuto: body.on !== false } });
      return json({ ok: true, auto: body.on !== false });
    }
    if (req.method === "POST" && route === "/api/research/settings") {
      const body = (await req.json().catch(() => ({}))) as { aggressive?: boolean; nerve?: number; perps?: number };
      const bots = await readBots();
      const sc = loadConfig(bots.spot.config), pc = loadPerpsConfig(bots.perps.config);
      const spot = loadConfig({ ...sc, researchAggressive: body.aggressive ?? sc.researchAggressive, nerve: body.nerve ?? sc.nerve, researchPerps: body.perps ?? sc.researchPerps });
      await setBot("spot", { config: spot });
      await setBot("perps", { config: { ...pc, pilotAggressive: spot.researchAggressive } }); // le pilote perps suit le mode agressif des agents
      await notify(`Agents : mode ${spot.researchAggressive ? "AGRESSIF" : "normal"}, nervosité ${NERVE_LEVELS[spot.nerve]}, recherche ${100 - spot.researchPerps} % spot / ${spot.researchPerps} % perps`);
      const pilot = await autopilot(true).catch((e) => `pilote : ${(e as Error).message}`);
      return json({ ok: true, aggressive: spot.researchAggressive, nerve: spot.nerve, perps: spot.researchPerps, pilot });
    }
    if (req.method === "POST" && route === "/api/autopilot") {
      const body = (await req.json().catch(() => ({}))) as { spot?: boolean; perps?: boolean };
      const bots = await readBots();
      const sc = loadConfig(bots.spot.config), pc = loadPerpsConfig(bots.perps.config);
      if (typeof body.spot === "boolean") await setBot("spot", { config: { ...sc, autopilot: body.spot, ...(body.spot ? {} : { plans: [] }) } });
      if (typeof body.perps === "boolean") await setBot("perps", { config: { ...pc, autopilot: body.perps, ...(body.perps ? {} : { plan: null }) } });
      const on = [body.spot && "spot", body.perps && "perps"].filter(Boolean).join(" et ");
      await notify(on ? `Pilote automatique activé (${on})` : "Pilote automatique modifié");
      return json({ ok: true, pilot: await autopilot() });
    }
    if (req.method === "POST" && route === "/api/agent/chat") {
      const body = (await req.json().catch(() => ({}))) as { messages?: { role: string; content: string }[] };
      return json(await agentChat(Array.isArray(body.messages) ? body.messages : []));
    }
    if (req.method === "GET" && route === "/api/backtest") return json(await backtestMarket(Number(url.searchParams.get("market") ?? 0)));
    if (req.method === "POST" && route === "/api/spot/config") {
      const body = (await req.json().catch(() => ({}))) as { strategy?: string; rsi?: Record<string, unknown>; trend?: null };
      const current = loadConfig((await readBots()).spot.config);
      const config = { ...current, strategy: body.strategy === "rsi" ? "rsi" : body.strategy === "tendance" ? "tendance" : current.strategy, rsi: sanitizeRsi({ ...current.rsi, ...(body.rsi ?? {}) }) };
      if (body.trend === null) { config.trend = null; config.plans = []; config.autopilot = false; delete config.source; } // retour aux réglages automatiques du cerveau
      await setBot("spot", { config });
      return json({ ok: true, config });
    }
    if (req.method === "POST" && route === "/api/protections") {
      type P = { maxPositions?: number; vaultPct?: number; partialTp?: boolean; marketFilter?: boolean };
      const body = (await req.json().catch(() => ({}))) as { spot?: P; perps?: P; breakerPct?: number };
      const bots = await readBots();
      const sc = loadConfig(bots.spot.config), pc = loadPerpsConfig(bots.perps.config);
      const spot = loadConfig({ ...sc, ...(body.spot ?? {}), ...(body.breakerPct != null ? { breakerPct: body.breakerPct, breakerBase: null } : {}) });
      const perps = loadPerpsConfig({ ...pc, ...(body.perps ?? {}) });
      await setBot("spot", { config: spot });
      await setBot("perps", { config: perps });
      await autopilot(true).catch(() => null); // le nombre de positions perps peut changer le nombre de stratégies choisies
      await notify(`Protections : spot ${spot.maxPositions} position(s), coffre ${spot.vaultPct} %, prise partielle ${spot.partialTp ? "oui" : "non"}, filtre BTC ${spot.marketFilter ? "oui" : "non"} · perps ${perps.maxPositions} position(s), coffre ${perps.vaultPct} % · disjoncteur ${spot.breakerPct ? spot.breakerPct + " %" : "coupé"}`);
      return json({ ok: true, spot, perps });
    }
    if (req.method === "POST" && route === "/api/perps/config") {
      const body = (await req.json().catch(() => ({}))) as { aggr?: number; maxLev?: number; bias?: number; trend?: null };
      const current = loadPerpsConfig((await readBots()).perps.config);
      const config = loadPerpsConfig({ ...current, aggr: body.aggr ?? current.aggr, maxLev: body.maxLev ?? current.maxLev, bias: body.bias ?? current.bias });
      if (body.trend === null) { config.trend = null; config.plan = null; config.plans = []; config.autopilot = false; delete config.source; }
      await setBot("perps", { config });
      await notify(`Bot perps : agressivité ${AGGR_LEVELS[config.aggr]!.name.toLowerCase()}${effectiveAggr(config) !== config.aggr ? ` (plafonnée à ${AGGR_LEVELS[effectiveAggr(config)]!.name.toLowerCase()} en pilote automatique)` : ""}, levier max x${config.maxLev}, ${config.bias === 0 ? "longs et shorts équilibrés" : config.bias > 0 ? `longs favorisés (shorts à ${100 - config.bias} %)` : `shorts favorisés (longs à ${100 + config.bias} %)`}`);
      return json({ ok: true, config });
    }
    const m = route.match(/^\/api\/(spot|perps)\/(start|pause|stop|goal|rebase)$/);
    if (req.method === "POST" && m) {
      const kind = m[1] as BotKind, action = m[2];
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (action === "start") return json(await startMission(kind, body as { goal_usd?: number; days?: number }));
      if (action === "rebase") { // remet le point de départ à la valeur actuelle (ex. après un transfert compté comme un gain), sans toucher aux positions
        const b = (await readBots())[kind], v = Number(b.last_value_usd);
        if (!(v > 0)) return json({ error: "valeur inconnue" }, 409);
        const mem = loadMemory(b.price_history); mem.dayStartValue = v;
        await setBot(kind, { start_value_usd: v, price_history: mem as never });
        return json({ ok: true, start: v });
      }
      if (action === "pause") { await setBot(kind, { status: "paused", last_message: "En pause. Une position ouverte reste gérée par son stop." }); return json({ ok: true }); }
      if (action === "stop") { const r = await emergencyStop(kind); return json(r, r.ok ? 200 : 409); }
      if (action === "goal") {
        const goal = Number(body["goal_usd"]), days = Number(body["days"]);
        await setBot(kind, { ...(goal > 0 ? { goal_usd: goal } : {}), ...(days > 0 ? { end_at: new Date(Date.now() + days * 86_400_000).toISOString() } : {}) });
        return json({ ok: true });
      }
    }
    return json({ error: "route inconnue" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
