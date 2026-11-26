// Fonction Supabase « pulse » : appelée chaque minute par le cron (tick des deux bots) et par l'app (API).
//   POST /pulse/tick                 cron (en-tête x-cron-secret)
//   GET  /pulse/api/state            état des deux missions
//   POST /pulse/api/{spot|perps}/{start|pause|stop|goal}
//   GET  /pulse/api/backtest?market=N
import { createClient } from "npm:@supabase/supabase-js@2";
import { riskPerTrade } from "./engine/brain.ts";
import { hourlyCandles } from "./engine/candles.ts";
import { env } from "./engine/solana.ts";
import { currentPerpsValue, getPerpsWalletAddress, liquidatePerps, runPerpsTick } from "./engine/perps.ts";
import { currentValue, getWalletAddress, liquidate, runTick } from "./engine/spot.ts";
import { backtest, loadMemory, PERPS_RULES, PRESETS, RISK, RULES, STRATEGY, TOKENS } from "./engine/strategy.ts";
import { DbStore, notify, type BotKind, type BotState } from "./store.ts";

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
  if (isNew) {
    try { startValue = (kind === "spot" ? await currentValue() : await currentPerpsValue()).valueUsd; } catch { startValue = null; }
  }
  await setBot(kind, {
    status: "running", goal_usd: goal,
    ...(isNew ? { started_at: new Date().toISOString(), start_value_usd: startValue, end_at: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
    last_message: isNew ? "Mission lancée. J'analyse le marché." : "Je reprends la mission.",
  });
  await notify(`${kind === "spot" ? "Bot spot" : "Bot perps"} : mission ${isNew ? "lancée" : "reprise"} (objectif ${goal} $)`);
  return { ok: true };
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
      ...b, price_history: undefined, lock_until: undefined,
      memory: { stop: mem.stop, best: mem.best, signal: mem.signal, mindset: mem.mindset, live: mem.live, asset: mem.asset, side: mem.side, openedAt: mem.openedAt, costUsd: mem.costUsd, pending: mem.pending ? { kind: mem.pending.kind, at: mem.pending.at } : null },
      brain: mem.brain ? { risk: riskPerTrade(mem.brain), streak: mem.brain.streak, benched: mem.brain.benched, disabled: mem.brain.disabled, report: mem.brain.report ?? {}, preset: mem.brain.preset } : null,
      trades: trades ?? [],
    };
  }
  const [spotWallet, perpsWallet] = await Promise.all([getWalletAddress(), getPerpsWalletAddress()]);
  return {
    now: new Date().toISOString(), wallets: { spot: spotWallet, perps: perpsWallet }, bots: out, markets: MARKETS.map((m) => m.name),
    secrets: { spotWallet: !!env("BOT_WALLET_PRIVATE_KEY"), perpsWallet: !!env("PERPS_WALLET_PRIVATE_KEY"), customRpc: !!env("SOLANA_RPC_URL"), telegram: !!(env("TELEGRAM_BOT_TOKEN") && env("TELEGRAM_CHAT_ID")), cron: cronReady },
    rules: { strategy: STRATEGY, risk: RISK, perps: PERPS_RULES, rules: RULES, presets: PRESETS },
  };
}

/** Un marché par appel : reste sous la limite de 2 s de calcul des fonctions Supabase. */
async function backtestMarket(i: number) {
  const m = MARKETS[i];
  if (!m) throw new Error("marché inconnu");
  const candles = await hourlyCandles(m.product, 1440);
  const presets = Object.entries(PRESETS).map(([name, params]) => {
    const r = backtest(candles, { allowShort: m.allowShort, feePct: m.feePct, hourlyCost: m.hourlyCost, leverageCap: m.cap, params });
    return { name, trades: r.trades, winRate: r.winRate, profitFactor: Number.isFinite(r.profitFactor) ? r.profitFactor : null, returnPct: r.returnPct, maxDrawdownPct: r.maxDrawdownPct };
  });
  return { market: m.name, days: Math.round(candles.length / 24), presets };
}

// ------------------------------------------------------------------ routeur
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*?\/pulse/, "") || "/";
  if (!db) return json({ error: "Clé service Supabase introuvable : ajoute le secret PULSE_SERVICE_KEY (Project Settings → API Keys → clé secret/service_role)." }, 500);
  try {
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
    if (req.method === "GET" && route === "/api/backtest") return json(await backtestMarket(Number(url.searchParams.get("market") ?? 0)));
    const m = route.match(/^\/api\/(spot|perps)\/(start|pause|stop|goal)$/);
    if (req.method === "POST" && m) {
      const kind = m[1] as BotKind, action = m[2];
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (action === "start") return json(await startMission(kind, body as { goal_usd?: number; days?: number }));
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
