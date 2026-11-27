-- Lot 2 : univers de tokens (sélectionneur + nouveaux tokens), arbitrage éclaireur, notifications push, réglages internes.

-- Tokens ajoutés par les agents (le bot spot et le chercheur s'en servent en plus de la liste fixe)
create table if not exists public.token_universe (
  mint         text primary key,
  kind         text not null,               -- 'selection' (sélectionneur) ou 'nouveau' (agent nouveaux tokens)
  symbol       text not null,
  decimals     integer not null,
  pool         text,                        -- pool le plus liquide (historique GeckoTerminal)
  liquidity    double precision,
  volume_24h   double precision,
  age_days     double precision,
  score        double precision,
  active       boolean not null default true,
  why          text,
  data         jsonb,
  added_at     timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  seen_at      timestamptz,
  removed_at   timestamptz
);
grant select, insert, update, delete on public.token_universe to service_role;
alter table public.token_universe enable row level security;
revoke all on public.token_universe from anon, authenticated;

-- Arbitrage (éclaireur, sans argent) : opportunités observées, frais déduits
create table if not exists public.arb_log (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  kind        text not null,
  token       text not null,
  detail      text,
  gross_pct   double precision,
  net_pct     double precision
);
create index if not exists arb_log_created on public.arb_log (created_at desc);
grant select, insert, update, delete on public.arb_log to service_role;
grant usage, select on sequence public.arb_log_id_seq to service_role;
alter table public.arb_log enable row level security;
revoke all on public.arb_log from anon, authenticated;

-- Abonnements aux notifications push (un par téléphone / navigateur)
create table if not exists public.push_subs (
  endpoint    text primary key,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
grant select, insert, update, delete on public.push_subs to service_role;
alter table public.push_subs enable row level security;
revoke all on public.push_subs from anon, authenticated;

-- Réglages internes du serveur (clés VAPID des notifications) : jamais lisibles depuis l'app
create table if not exists public.app_kv (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
grant select, insert, update, delete on public.app_kv to service_role;
alter table public.app_kv enable row level security;
revoke all on public.app_kv from anon, authenticated;
