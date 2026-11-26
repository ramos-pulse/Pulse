-- Pulse : tables des deux bots, historique des trades et planification du tick chaque minute.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table if not exists public.bot_state (
  kind             text primary key check (kind in ('spot', 'perps')),
  status           text not null default 'stopped',
  goal_usd         double precision not null default 5000,
  end_at           timestamptz,
  started_at       timestamptz,
  start_value_usd  double precision,
  wallet_address   text,
  position_mint    text,
  entry_price      double precision,
  position_pubkey  text,
  position_asset   text,
  position_side    text,
  price_history    jsonb,              -- mémoire du bot : stop, transaction en attente, apprentissage
  last_value_usd   double precision,
  last_tick_at     timestamptz,
  last_message     text,
  lock_until       timestamptz         -- verrou : un seul tick à la fois par bot
);

insert into public.bot_state (kind, last_message) values
  ('spot', 'Mission pas encore lancée.'),
  ('perps', 'Mission pas encore lancée.')
on conflict (kind) do nothing;

create table if not exists public.trades (
  id              bigserial primary key,
  bot             text not null check (bot in ('spot', 'perps')),
  created_at      timestamptz not null default now(),
  side            text,
  action          text,
  symbol          text,
  asset           text,
  mint            text,
  amount_usd      double precision,
  collateral_usd  double precision,
  price           double precision,
  pnl_usd         double precision,
  reason          text,
  signature       text
);
create index if not exists trades_bot_created on public.trades (bot, created_at desc);

-- Personne d'autre que la fonction (clé service) ne peut lire ou écrire ces tables.
alter table public.bot_state enable row level security;
alter table public.trades enable row level security;

-- Installe (ou réinstalle) le tick chaque minute. Appelée automatiquement par la fonction au premier usage de l'app.
create or replace function public.pulse_install_cron(fn_url text, secret text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'pulse-tick';
  perform cron.schedule(
    'pulse-tick',
    '* * * * *',
    format(
      $cmd$select net.http_post(url := %L, headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', %L), body := '{}'::jsonb, timeout_milliseconds := 150000)$cmd$,
      fn_url, secret
    )
  );
end;
$$;
revoke all on function public.pulse_install_cron(text, text) from public, anon, authenticated;
grant execute on function public.pulse_install_cron(text, text) to service_role;
