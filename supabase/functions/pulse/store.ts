// Stockage dans la base Supabase (Postgres).
// - Un VERROU par bot (colonne lock_until) : deux ticks ne peuvent jamais trader en même temps.
// - Seuls les champs modifiés par le moteur sont réécrits : une pause demandée depuis l'app pendant un tick n'est jamais écrasée.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { env } from "./engine/solana.ts";

export type BotKind = "spot" | "perps";
export type BotStatus = "stopped" | "running" | "paused" | "success" | "destroyed";

export interface BotState {
  kind: BotKind;
  status: BotStatus;
  goal_usd: number;
  end_at: string | null;
  started_at: string | null;
  start_value_usd: number | null;
  wallet_address: string | null;
  position_mint: string | null;
  entry_price: number | null;
  position_pubkey: string | null;
  position_asset: string | null;
  position_side: string | null;
  price_history: unknown;
  config: unknown;                 // réglages choisis dans l'app (stratégie spot, paramètres RSI)
  last_value_usd: number | null;
  last_tick_at: string | null;
  last_message: string | null;
}

export interface TradeRow {
  side?: string | null; action?: string; symbol?: string; asset?: string; mint?: string;
  amount_usd?: number; collateral_usd?: number; price?: number; pnl_usd?: number; reason?: string; signature?: string | null; source?: string; detail?: Record<string, unknown>;
}

/** Interface utilisée par le moteur (identique à la version serveur). */
export interface Store {
  bot(kind: BotKind): BotState;
  update(kind: BotKind, patch: Partial<BotState>): void;
  addTrade(kind: BotKind, row: TradeRow): void;
  /** Alerte envoyée sur le téléphone (en plus des trades). */
  alert?(text: string): void;
}

const LOCK_MS = 140_000;

export class DbStore implements Store {
  private dirty: Partial<BotState> = {};
  private inserts: (TradeRow & { bot: BotKind })[] = [];
  private messages: string[] = [];

  private db: SupabaseClient;
  private kind: BotKind;
  private row: BotState;

  private constructor(db: SupabaseClient, kind: BotKind, row: BotState) {
    this.db = db; this.kind = kind; this.row = row;
  }

  /** Prend le verrou du bot. Renvoie null si un autre tick est déjà en cours. */
  static async claim(db: SupabaseClient, kind: BotKind): Promise<DbStore | null> {
    const now = new Date();
    const { data, error } = await db.from("bot_state")
      .update({ lock_until: new Date(now.getTime() + LOCK_MS).toISOString() })
      .eq("kind", kind)
      .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
      .select("*");
    if (error) throw new Error(`base : ${error.message}`);
    const row = data?.[0] as (BotState & { lock_until?: string }) | undefined;
    if (!row) return null;
    delete row.lock_until;
    return new DbStore(db, kind, row);
  }

  /** Attend le verrou (pour l'arrêt d'urgence). */
  static async claimWait(db: SupabaseClient, kind: BotKind, ms: number): Promise<DbStore | null> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const s = await DbStore.claim(db, kind);
      if (s) return s;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  }

  bot(kind: BotKind): BotState {
    if (kind !== this.kind) throw new Error(`verrou pris sur ${this.kind}, pas ${kind}`);
    return structuredClone(this.row);
  }

  update(kind: BotKind, patch: Partial<BotState>): void {
    if (kind !== this.kind) throw new Error(`verrou pris sur ${this.kind}, pas ${kind}`);
    const before = this.row.status;
    Object.assign(this.row, patch);
    Object.assign(this.dirty, patch);
    const after = this.row.status;
    if (after !== before && ["success", "destroyed", "stopped"].includes(after)) {
      this.messages.push(`${kind === "spot" ? "Bot spot" : "Bot perps"} : ${this.row.last_message ?? after}`);
    }
  }

  addTrade(kind: BotKind, row: TradeRow): void {
    this.inserts.push({ ...row, bot: kind });
    const raw = (row.action ?? row.side ?? "").toUpperCase();
    const what = ({ BUY: "ACHAT", SELL: "VENTE", OPEN: "OUVERTURE", CLOSE: "FERMETURE", DEPOSIT: "DÉPÔT", WITHDRAW: "RETRAIT" } as Record<string, string>)[raw] ?? raw;
    const pnl = typeof row.pnl_usd === "number" ? ` · ${row.pnl_usd >= 0 ? "+" : ""}${row.pnl_usd.toFixed(2)} $` : "";
    this.messages.push(`${what} ${row.symbol ?? row.asset ?? ""}${pnl}${row.reason ? ` (${row.reason})` : ""}`);
  }

  alert(text: string): void { this.messages.push(text); }

  /** Écrit les trades puis les champs modifiés, libère le verrou, envoie les notifications. */
  async release(): Promise<void> {
    if (this.inserts.length) {
      const { error } = await this.db.from("trades").insert(this.inserts);
      if (error) console.error("insertion trades :", error.message);
    }
    const { error } = await this.db.from("bot_state").update({ ...this.dirty, lock_until: null }).eq("kind", this.kind);
    if (error) console.error("mise à jour bot :", error.message);
    await Promise.allSettled(this.messages.map(notify));
  }
}

/** Notifications push sur le téléphone (branché par la fonction principale, qui a accès à la base). */
export const pushHook: { send: null | ((text: string) => Promise<void>) } = { send: null };

export async function notify(text: string): Promise<void> {
  console.log(text);
  await pushHook.send?.(text).catch(() => {});
  const token = env("TELEGRAM_BOT_TOKEN"), chat = env("TELEGRAM_CHAT_ID");
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: `Pulse · ${text}` }), signal: AbortSignal.timeout(8_000),
  }).catch(() => {});
}
