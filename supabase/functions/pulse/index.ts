// Fonction Supabase « pulse » : appelée chaque minute par le cron (tick des deux bots) et par l'app (API).
//   POST /pulse/tick                 cron (en-tête x-cron-secret)
//   GET  /pulse/api/state            état des deux missions
//   POST /pulse/api/{spot|perps}/{start|pause|stop|goal|paper}
//   GET  /pulse/api/backtest?market=N
import { createClient } from "npm:@supabase/supabase-js@2";
import { riskPerTrade } from "./engine/brain.ts";
import { candles as getCandles, hourlyCandles } from "./engine/candles.ts";
import { env } from "./engine/solana.ts";
import { currentPerpsValue, getPerpsWalletAddress, liquidatePerps, runPerpsTick } from "./engine/perps.ts";
import { currentValue, getWalletAddress, liquidate, runTick } from "./engine/spot.ts";
import { AGGRESSIVE, backtest, backtestRsi, loadConfig, loadMemory, loadPerpsConfig, PERPS_ASSETS, PERPS_RULES, PRESETS, RISK, RULES, sanitizeRsi, sanitizeTrend, STRATEGY, TOKENS, type Interval, type Params, type PerpsPlan, type RsiParams, type SpotPlan } from "./engine/strategy.ts";
import { candidateKey, describe, evaluate, mutate, randomCandidate, seeded, type Candidate, type Market } from "./engine/research.ts";
import { DbStore, notify, type BotKind, type BotState } from "./store.ts";
import { cleanWallet, CLEANER } from "./engine/cleaner.ts";
import { analyze, propose } from "./engine/math.ts";
import { freshPaper, loadPaper, PAPER, PAPER_ADDRESS } from "./engine/venue.ts";

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

async function startMission(kind: BotKind, body: { goal_usd?: number; days?: number }) {
  const bot = (await readBots())[kind];
  if (bot.status === "running") return { ok: true };
  const isNew = !bot.started_at || ["success", "destroyed", "stopped"].includes(bot.status);
  const goal = Number(body.goal_usd ?? bot.goal_usd) || 5000;
  const days = Number(body.days ?? 30) || 30;
  let startValue = bot.start_value_usd;
  const paper = loadPaper(bot.paper);
  if (isNew && paper.on) {
    // nouvelle mission paper : portefeuille fictif remis à neuf, aucun wallet ni clé nécessaire
    const fresh = { ...freshPaper(paper.startUsd), since: new Date().toISOString() };
    await setBot(kind, { paper: fresh, wallet_address: PAPER_ADDRESS, position_mint: null, position_pubkey: null, position_asset: null, position_side: null, entry_price: null, price_history: resetPositionMemory(bot.price_history) });
    startValue = fresh.startUsd;
  } else if (isNew) {
    try { startValue = (kind === "spot" ? await currentValue() : await currentPerpsValue()).valueUsd; } catch { startValue = null; }
  }
  await setBot(kind, {
    status: "running", goal_usd: goal,
    ...(isNew ? { started_at: new Date().toISOString(), start_value_usd: startValue, end_at: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
    last_message: isNew ? `Mission ${paper.on ? "PAPER (argent fictif) " : ""}lancée. J'analyse le marché.` : "Je reprends la mission.",
  });
  await notify(`${kind === "spot" ? "Bot spot" : "Bot perps"} : mission ${paper.on ? "PAPER " : ""}${isNew ? "lancée" : "reprise"} (objectif ${goal} $)`);
  return { ok: true };
}

/** Mémoire de position effacée (le cerveau, lui, est gardé) : utile au passage réel ⇄ paper. */
function resetPositionMemory(ph: unknown) {
  const mem = loadMemory(ph) as unknown as Record<string, unknown>;
  for (const k of ["pending", "stop", "best", "initialRisk", "openedAt", "costUsd", "openValueUsd", "asset", "side", "stopCandle", "live", "strategy", "posParams", "posInterval", "source"]) delete mem[k];
  return mem;
}

const isBusy = (b: BotState) => b.status === "running" || b.status === "paused" || !!b.position_mint || !!b.position_side;

/** Passe un bot en paper ou en réel. Seulement quand il ne trade pas : jamais de bascule avec une position ouverte. */
async function setPaper(kind: BotKind, body: { on?: boolean; startUsd?: number }) {
  const bot = (await readBots())[kind];
  const cur = loadPaper(bot.paper);
  const on = body.on ?? cur.on;
  if (isBusy(bot) && on !== cur.on) return { ok: false, error: "Arrête d'abord la mission (arrêt d'urgence) avant de passer du réel au paper ou l'inverse." };
  const startUsd = body.startUsd ?? cur.startUsd;
  const next = isBusy(bot) ? { ...cur, startUsd: freshPaper(startUsd).startUsd } : freshPaper(startUsd, on);
  await setBot(kind, { paper: next, ...(isBusy(bot) ? {} : { wallet_address: on ? PAPER_ADDRESS : null, start_value_usd: null, started_at: null, last_value_usd: on ? next.startUsd : null }) });
  return { ok: true, paper: { on: next.on, startUsd: next.startUsd } };
}

/** Teste une stratégie trouvée en paper : le bot (paper) la trade seule, pilote automatique coupé. */
async function paperTest(id: number) {
  const { data } = await db.from("research").select("*").eq("id", id).limit(1);
  const r = data?.[0] as ResearchRow | undefined;
  if (!r) return { ok: false, error: "stratégie introuvable" };
  const kind: BotKind = r.kind;
  const bot = (await readBots())[kind];
  if (!loadPaper(bot.paper).on) {
    if (isBusy(bot)) return { ok: false, error: `Le bot ${kind} est en mission RÉELLE : arrête-le d'abord, puis relance le test.` };
    await setPaper(kind, { on: true });
  }
  if (kind === "spot") {
    const cur = loadConfig((await readBots()).spot.config);
    await setBot("spot", { config: { ...cur, autopilot: false, plans: [toSpotPlan(r)] } });
  } else {
    const cur = loadPerpsConfig((await readBots()).perps.config);
    await setBot("perps", { config: { ...cur, autopilot: false, mode: "normal", plan: toPerpsPlan(r) } });
  }
  const fresh = (await readBots())[kind];
  if (fresh.status !== "running" && fresh.status !== "paused") await startMission(kind, {});
  await notify(`Paper : stratégie #${r.id} (${r.market}) en test sur le bot ${kind}`);
  return { ok: true, kind, started: fresh.status !== "running" };
}

async function paperCandidates() {
  const { data } = await db.from("research").select("*").neq("verdict", "rejetée").order("score", { ascending: false }).limit(60);
  return { list: ((data ?? []) as ResearchRow[]).sort(byRank).slice(0, 40).map((r) => ({ id: r.id, kind: r.kind, market: r.market, family: r.family, verdict: r.verdict, origin: r.origin ?? "chercheur",
    description: describe({ ...r, interval: r.interval === "15m" ? "15m" : "1h" }), test: r.test, paper: r.paper ?? null, live: r.live ?? null })) };
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

async function state() {
  const bots = await readBots();
  const out: Record<string, unknown> = {};
  for (const k of KINDS) {
    const b = bots[k];
    const mem = loadMemory(b.price_history);
    const { data: trades } = await db.from("trades").select("*").eq("bot", k).order("created_at", { ascending: false }).limit(60);
    out[k] = {
      ...b, price_history: undefined, lock_until: undefined, paper: (({ on, startUsd, since }) => ({ on, startUsd, since }))(loadPaper(b.paper)), config: k === "spot" ? loadConfig(b.config) : loadPerpsConfig(b.config),
      memory: { strategy: mem.strategy, stop: mem.stop, best: mem.best, signal: mem.signal, mindset: mem.mindset, live: mem.live, asset: mem.asset, side: mem.side, openedAt: mem.openedAt, costUsd: mem.costUsd, pending: mem.pending ? { kind: mem.pending.kind, at: mem.pending.at } : null },
      brain: mem.brain ? { risk: riskPerTrade(mem.brain), streak: mem.brain.streak, benched: mem.brain.benched, disabled: mem.brain.disabled, report: mem.brain.report ?? {}, preset: mem.brain.preset } : null,
      trades: trades ?? [],
    };
  }
  const [spotWallet, perpsWallet] = await Promise.all([getWalletAddress(), getPerpsWalletAddress()]);
  return {
    now: new Date().toISOString(), wallets: { spot: spotWallet, perps: perpsWallet }, bots: out, markets: MARKETS.map((m) => m.name),
    secrets: { anthropic: !!env("ANTHROPIC_API_KEY"), spotWallet: !!env("BOT_WALLET_PRIVATE_KEY"), perpsWallet: !!env("PERPS_WALLET_PRIVATE_KEY"), customRpc: !!env("SOLANA_RPC_URL"), telegram: !!(env("TELEGRAM_BOT_TOKEN") && env("TELEGRAM_CHAT_ID")), cron: cronReady },
    paperRules: PAPER,
    rules: { strategy: STRATEGY, risk: RISK, perps: PERPS_RULES, rules: RULES, presets: PRESETS, aggressive: AGGRESSIVE },
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
type ResearchRow = { id: number; created_at: string; market: string; product: string; symbol?: string | null; interval?: string | null; kind: "spot" | "perps"; family: "tendance" | "rsi"; params: Candidate["params"]; train: Record<string, number>; test: Record<string, number>; score: number; verdict: string; why: string; live?: LiveStats | null; paper?: Omit<LiveStats, "confirmed" | "failed"> | null; origin?: string | null; rationale?: string | null };

// ------------------------------------------------------------------ apprentissage croisé : le chercheur apprend des vrais trades des bots
const LIVE = { minTrades: 4, failPF: 0.8, confirmPF: 1.2, boost: 1.3, days: 45 };
/** Score effectif : une stratégie confirmée en réel passe devant, une stratégie qui déçoit en réel est écartée par son verdict. */
const effScore = (r: ResearchRow) => r.score * (r.live?.confirmed ? LIVE.boost : r.live?.failed ? 0 : 1);
// le réel prime sur le backtest : confirmées d'abord, puis non testées, déçues en dernier
const tier = (r: ResearchRow) => (r.live?.confirmed ? 2 : r.live?.failed ? 0 : 1);
const byRank = (a: ResearchRow, b: ResearchRow) => tier(b) - tier(a) || effScore(b) - effScore(a);

async function learnFromBots(): Promise<string[]> {
  const since = new Date(Date.now() - LIVE.days * 86_400_000).toISOString();
  const { data } = await db.from("trades").select("*").gt("created_at", since).limit(5000);
  const by = new Map<number, { pnl: number[]; lastAt: string }>();
  const byPaper = new Map<number, { pnl: number[]; lastAt: string }>();
  for (const t of (data ?? []) as { source?: string | null; pnl_usd?: number | null; created_at: string; paper?: boolean | null }[]) {
    const m = /chercheur #(\d+)/.exec(t.source ?? "");
    if (!m || typeof t.pnl_usd !== "number") continue; // seuls les trades clôturés comptent
    const map = t.paper ? byPaper : by; // le paper ne compte JAMAIS comme « confirmé en réel »
    const e = map.get(+m[1]!) ?? { pnl: [], lastAt: t.created_at };
    e.pnl.push(t.pnl_usd); if (t.created_at > e.lastAt) e.lastAt = t.created_at;
    map.set(+m[1]!, e);
  }
  const statsOf = (pnl: number[]) => {
    const wins = pnl.filter((x) => x > 0), gw = wins.reduce((a, x) => a + x, 0), gl = -pnl.filter((x) => x <= 0).reduce((a, x) => a + x, 0);
    return { trades: pnl.length, wins: wins.length, pnlUsd: Math.round((gw - gl) * 100) / 100, profitFactor: Math.round((gl > 0 ? gw / gl : gw > 0 ? 99 : 0) * 100) / 100 };
  };
  for (const [id, e] of byPaper) await db.from("research").update({ paper: { ...statsOf(e.pnl), lastAt: e.lastAt } }).eq("id", id);
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
const RESEARCH_MARKETS: Market[] = INTERVALS.flatMap((interval) => [
  ...TOKENS.filter((t) => t.symbol !== "JUP").map((t) => ({ name: `Spot ${t.symbol}${interval === "15m" ? " · 15 min" : ""}`, product: t.candles, symbol: t.symbol,
    kind: "spot" as const, interval, feePct: 0.003, hourlyCost: 0, cap: RISK.maxSpotFraction })),
  ...PERPS_ASSETS.map((a) => ({ name: `Perps ${a.asset}${interval === "15m" ? " · 15 min" : ""}`, product: a.candles, symbol: a.asset,
    kind: "perps" as const, interval, feePct: 0.0012, hourlyCost: 0.00008, cap: PERPS_RULES.maxLeverage })),
]);
/** Historique utilisé : 90 jours en 1 h, 30 jours en 15 min (2/3 pour régler, 1/3 jamais vu pour valider). */
const HISTORY: Record<Interval, number> = { "1h": 2160, "15m": 2880 };
const RESEARCH_BUDGET_MS = 1000; // sous la limite de 2 s de calcul des fonctions Supabase
const RESEARCH_MAX = 40;

async function runResearch() {
  const cycle = Math.floor(Date.now() / 300_000);
  const m = RESEARCH_MARKETS[cycle % RESEARCH_MARKETS.length]!;
  let candles;
  try { candles = await getCandles(m.product, m.interval, HISTORY[m.interval]); }
  catch (e) { return { market: m.name, tested: 0, note: `historique indisponible : ${(e as Error).message}` }; }
  if (candles.length < HISTORY[m.interval] * 0.6) return { market: m.name, tested: 0, note: "historique insuffisant" };
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
  // 1. le mathématicien analyse la partie entraînement (jamais la période de validation) et propose ses stratégies en premier
  const train = candles.slice(0, Math.floor(candles.length * 2 / 3));
  const insight = analyze(train);
  let proposed = 0;
  for (const pr of propose(train, m, insight)) {
    const key = candidateKey(pr.candidate);
    if (seen.has(key)) continue;
    seen.add(key); proposed++;
    const e = evaluate(pr.candidate, candles, m);
    rows.push({ key, market: pr.candidate.market, product: pr.candidate.product, symbol: pr.candidate.symbol, interval: pr.candidate.interval, kind: pr.candidate.kind, family: pr.candidate.family, params: pr.candidate.params, train: e.train, test: e.test, score: e.score, verdict: e.verdict, why: e.why, origin: "mathématicien", rationale: pr.rationale });
  }
  await db.from("math_insights").upsert({ key: `${m.product}|${m.kind}|${m.interval}`, updated_at: new Date().toISOString(), market: m.name, kind: m.kind, interval: m.interval, regime: insight.regime, hurst: insight.hurst, ac1: insight.ac1, half_life: insight.halfLife, significant: insight.significant, vr: insight.vr, note: insight.note, proposed }, { onConflict: "key" });
  // 2. le chercheur : moitié améliorations des meilleures (y compris celles du mathématicien), moitié idées nouvelles
  let tries = 0;
  while (rows.length < RESEARCH_MAX && performance.now() - t0 < RESEARCH_BUDGET_MS && tries < RESEARCH_MAX * 5) {
    tries++;
    // moitié améliorations des meilleures, moitié idées nouvelles
    const c = parents.length && rnd() < 0.5 ? mutate(rnd, parents[Math.floor(rnd() * parents.length)]!) : randomCandidate(rnd, m);
    const key = candidateKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    const e = evaluate(c, candles, m);
    rows.push({ key, market: c.market, product: c.product, symbol: c.symbol, interval: c.interval, kind: c.kind, family: c.family, params: c.params, train: e.train, test: e.test, score: e.score, verdict: e.verdict, why: e.why, origin: "chercheur", rationale: null });
  }
  if (rows.length) {
    const { error } = await db.from("research").upsert(rows, { onConflict: "key", ignoreDuplicates: true });
    if (error) throw new Error(`recherche : ${error.message}`);
  }
  // ménage : les stratégies rejetées depuis plus de 3 jours sont oubliées
  await db.from("research").delete().eq("verdict", "rejetée").lt("created_at", new Date(Date.now() - 3 * 86_400_000).toISOString());
  const learned = await learnFromBots().catch(() => [] as string[]);
  const pilot = await autopilot().catch((e) => `pilote : ${(e as Error).message}`);
  const math = rows.filter((r) => r.origin === "mathématicien");
  return { market: m.name, tested: rows.length, promising: rows.filter((r) => r.verdict === "prometteuse").length, math: { regime: insight.regime, proposed: math.length, promising: math.filter((r) => r.verdict === "prometteuse").length }, learned, pilot };
}

// ------------------------------------------------------------------ pilote automatique
/** Critères stricts : seule une stratégie solide sur la période jamais vue peut piloter un bot. */
const QUALIFY = { minTestTrades: 5, minTestPF: 1.3, maxTestDD: 10, maxAgeDays: 14 };
function qualifies(r: ResearchRow): boolean {
  return r.verdict === "prometteuse" && (r.test.trades ?? 0) >= QUALIFY.minTestTrades && (r.test.profitFactor ?? 0) >= QUALIFY.minTestPF
    && (r.test.maxDrawdownPct ?? 99) <= QUALIFY.maxTestDD && Date.now() - Date.parse(r.created_at) < QUALIFY.maxAgeDays * 86_400_000;
}
const symbolOfRow = (r: ResearchRow) => r.symbol ?? r.market.replace(/^(Spot|Perps) /, "").split(" ")[0]!;
const confidenceOf = (r: ResearchRow) => (r.live?.confirmed ? "confirmée" as const : "nouvelle" as const);
const toSpotPlan = (r: ResearchRow): SpotPlan => ({ symbol: symbolOfRow(r), family: r.family, params: r.family === "rsi" ? sanitizeRsi({ ...(r.params as RsiParams), riskPct: 1, naive: false }) : sanitizeTrend(r.params)!,
  interval: r.interval === "15m" ? "15m" : "1h", source: `chercheur #${r.id} · ${r.market}`, score: effScore(r), confidence: confidenceOf(r) });
const toPerpsPlan = (r: ResearchRow): PerpsPlan => ({ asset: symbolOfRow(r), params: sanitizeTrend(r.params) as Params, interval: r.interval === "15m" ? "15m" : "1h", source: `chercheur #${r.id} · ${r.market}`, score: effScore(r), confidence: confidenceOf(r) });

/** Choisit tout seul les tokens et stratégies des bots dont le pilote est activé. Renvoie un résumé des changements. */
async function autopilot(): Promise<string> {
  const bots = await readBots();
  const spotCfg = loadConfig(bots.spot.config), perpsCfg = loadPerpsConfig(bots.perps.config);
  if (!spotCfg.autopilot && !perpsCfg.autopilot) return "désactivé";
  const { data } = await db.from("research").select("*").eq("verdict", "prometteuse").order("score", { ascending: false }).limit(200);
  const good = ((data ?? []) as ResearchRow[]).filter(qualifies).sort(byRank);
  const changes: string[] = [];
  if (spotCfg.autopilot) {
    const spotRows = good.filter((r) => r.kind === "spot");
    // garde les plans actuels encore qualifiés (évite de changer d'avis toutes les 5 minutes), complète avec les meilleurs, 3 tokens max
    const keep = spotRows.slice(0, 10).filter((r) => spotCfg.plans.some((p) => p.source === `chercheur #${r.id} · ${r.market}`)).map(toSpotPlan);
    const plans = [...keep];
    for (const r of spotRows) { if (plans.length >= 3) break; const pl = toSpotPlan(r); if (!plans.some((x) => x.symbol === pl.symbol)) plans.push(pl); }
    const sig = (l: SpotPlan[]) => l.map((p) => `${p.source}:${p.confidence}`).join("|");
    const before = sig(spotCfg.plans), after = sig(plans);
    if (before !== after) {
      await setBot("spot", { config: { ...spotCfg, plans } });
      changes.push(plans.length ? `spot → ${plans.map((p) => `${p.symbol} (${p.family === "rsi" ? "RSI" : "tendance"}, ${p.interval === "15m" ? "15 min" : "1 h"})`).join(", ")}` : "spot → aucune stratégie validée, en attente");
    }
  }
  if (perpsCfg.autopilot) {
    const best = good.find((r) => r.kind === "perps");
    const kept = good.slice(0, 20).find((r) => r.kind === "perps" && `chercheur #${r.id} · ${r.market}` === perpsCfg.plan?.source);
    const plan = kept ? toPerpsPlan(kept) : best ? toPerpsPlan(best) : null;
    if (`${plan?.source}:${plan?.confidence}` !== `${perpsCfg.plan?.source}:${perpsCfg.plan?.confidence}` || perpsCfg.mode !== "normal") {
      await setBot("perps", { config: { ...perpsCfg, plan, mode: "normal" } });
      changes.push(plan ? `perps → ${plan.asset} (${plan.interval === "15m" ? "15 min" : "1 h"}), mode normal` : "perps → aucune stratégie validée, en attente");
    }
  }
  if (changes.length) await notify(`Pilote automatique : ${changes.join(" ; ")}`);
  return changes.join(" ; ") || "inchangé";
}



async function researchBoard() {
  const [{ count }, { data: top }, { data: last }] = await Promise.all([
    db.from("research").select("id", { count: "exact", head: true }),
    db.from("research").select("*").neq("verdict", "rejetée").order("score", { ascending: false }).limit(16),
    db.from("research").select("created_at").order("created_at", { ascending: false }).limit(1),
  ]);
  return {
    tested: count ?? 0, lastAt: last?.[0]?.created_at ?? null,
    best: ((top ?? []) as ResearchRow[]).sort(byRank).map((r) => ({ ...r, description: describe({ ...r, interval: r.interval === "15m" ? "15m" : "1h" }), qualifies: qualifies(r) })),
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
  const config = { ...cur, plan: toPerpsPlan(r) };
  await setBot("perps", { config });
  await notify(`Chercheur : stratégie #${r.id} appliquée au bot perps (${config.plan.asset}, ${desc})`);
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
  };
}

// ------------------------------------------------------------------ discussion avec le chercheur
async function agentChat(messages: { role: string; content: string }[]) {
  const board = await researchBoard();
  const st = await state();
  const bots = st.bots as Record<string, { status: string; last_value_usd: number | null; last_message: string | null; config: unknown; memory: { mindset?: string; signal?: string } }>;
  const context = {
    date: new Date().toISOString(),
    bots: Object.fromEntries(Object.entries(bots).map(([k, b]) => [k, { statut: b.status, valeur_usd: b.last_value_usd, derniere_action: b.last_message, pensee: b.memory?.mindset, analyse: b.memory?.signal, reglages: b.config }])),
    recherche: { strategies_testees: board.tested, meilleures: board.best.slice(0, 8).map((r) => ({ id: r.id, marche: r.market, type: r.family, description: r.description, verdict: r.verdict, entrainement: r.train, validation_jamais_vue: r.test, resultats_reels: r.live ?? "pas encore tradée", score: r.score, origine: r.origin ?? "chercheur", justification_mathematique: r.rationale ?? undefined })) },
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
      const research = await runResearch();
      const swap = (await swapAgentDue().catch(() => false)) ? await runSwapAgent("auto").catch((e) => `erreur : ${(e as Error).message}`) : "pas encore l'heure";
      return json({ research, swap });
    }
    if (route === "/tick" && req.method === "POST") {
      if (!TOKEN || !safeEqual(req.headers.get("x-cron-secret") ?? "", await cronSecret())) return json({ error: "interdit" }, 403);
      // les deux bots tournent en parallèle et indépendamment : la panne de l'un ne bloque jamais l'autre
      const results = await Promise.all(KINDS.map((k) => tickBot(k).catch((e: unknown) => `erreur : ${String(e)}`)));
      return json({ spot: results[0], perps: results[1] });
    }
    if (!route.startsWith("/api/")) return json({ ok: true, app: "pulse" });
    if (!TOKEN) return json({ error: "Secret DASHBOARD_TOKEN manquant dans Supabase" }, 401);
    if (!safeEqual((req.headers.get("x-token") ?? "").trim(), TOKEN)) return json({ error: "token invalide" }, 401);
    await ensureCron();

    if (req.method === "GET" && route === "/api/state") return json(await state());
    if (req.method === "GET" && route === "/api/research") return json(await researchBoard());
    if (req.method === "POST" && route === "/api/research/apply") {
      const body = (await req.json().catch(() => ({}))) as { id?: number };
      return json(await applyResearch(Number(body.id)));
    }
    if (req.method === "POST" && route === "/api/research/run") return json(await runResearch()); // lancer une recherche tout de suite
    if (req.method === "GET" && route === "/api/agents") return json(await agentsBoard());
    if (req.method === "GET" && route === "/api/paper/candidates") return json(await paperCandidates());
    if (req.method === "POST" && route === "/api/paper/test") {
      const body = (await req.json().catch(() => ({}))) as { id?: number };
      const r = await paperTest(Number(body.id)); return json(r, r.ok ? 200 : 409);
    }
    if (req.method === "POST" && route === "/api/agents/swap/run") return json(await runSwapAgent("manuel"));
    if (req.method === "POST" && route === "/api/agents/swap/auto") {
      const body = (await req.json().catch(() => ({}))) as { on?: boolean };
      const sc = loadConfig((await readBots()).spot.config);
      await setBot("spot", { config: { ...sc, swapAuto: body.on !== false } });
      return json({ ok: true, auto: body.on !== false });
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
    if (req.method === "POST" && route === "/api/perps/config") {
      const body = (await req.json().catch(() => ({}))) as { mode?: string; bias?: number; trend?: null };
      const current = loadPerpsConfig((await readBots()).perps.config);
      const config = loadPerpsConfig({ ...current, mode: body.mode ?? current.mode, bias: body.bias ?? current.bias });
      if (body.trend === null) { config.trend = null; config.plan = null; config.autopilot = false; delete config.source; }
      await setBot("perps", { config });
      await notify(`Bot perps : mode ${config.mode}, ${config.bias === 0 ? "longs et shorts équilibrés" : config.bias > 0 ? `longs favorisés (shorts à ${100 - config.bias} %)` : `shorts favorisés (longs à ${100 + config.bias} %)`}`);
      return json({ ok: true, config });
    }
    const m = route.match(/^\/api\/(spot|perps)\/(start|pause|stop|goal|paper)$/);
    if (req.method === "POST" && m) {
      const kind = m[1] as BotKind, action = m[2];
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (action === "start") return json(await startMission(kind, body as { goal_usd?: number; days?: number }));
      if (action === "paper") { const r = await setPaper(kind, body as { on?: boolean; startUsd?: number }); return json(r, r.ok ? 200 : 409); }
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
