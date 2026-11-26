-- Apprentissage croisé : chaque trade réel sait quelle stratégie l'a ouvert ; le chercheur garde les résultats réels.
alter table public.trades add column if not exists source text;
alter table public.research add column if not exists live jsonb;

-- Journal des agents (agent swap : reventes de restes, comptes fermés, SOL récupéré).
create table if not exists public.agent_log (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  agent       text not null,
  wallet      text not null,
  action      text not null,
  detail      text,
  sol         double precision,
  usd         double precision,
  signature   text
);
create index if not exists agent_log_created on public.agent_log (created_at desc);
grant select, insert, update, delete on public.agent_log to service_role;
grant usage, select on sequence public.agent_log_id_seq to service_role;
alter table public.agent_log enable row level security;
revoke all on public.agent_log from anon, authenticated;
