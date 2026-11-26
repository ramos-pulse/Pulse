-- Agent chercheur : stratégies testées (une ligne par stratégie, jamais testée deux fois).
create table if not exists public.research (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  key         text not null unique,
  market      text not null,
  product     text not null,
  kind        text not null check (kind in ('spot', 'perps')),
  family      text not null check (family in ('tendance', 'rsi')),
  params      jsonb not null,
  train       jsonb not null,
  test        jsonb not null,
  score       double precision not null,
  verdict     text not null,
  why         text
);
create index if not exists research_score on public.research (score desc);

grant select, insert, update, delete on public.research to service_role;
grant usage, select on sequence public.research_id_seq to service_role;
alter table public.research enable row level security;
revoke all on public.research from anon, authenticated;

-- Installe les deux minuteurs : les bots chaque minute, le chercheur toutes les 5 minutes.
create or replace function public.pulse_install_cron(fn_url text, secret text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  research_url text := replace(fn_url, '/tick', '/research');
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('pulse-tick', 'pulse-research');
  perform cron.schedule('pulse-tick', '* * * * *', format(
    $cmd$select net.http_post(url := %L, headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', %L), body := '{}'::jsonb, timeout_milliseconds := 150000)$cmd$,
    fn_url, secret));
  perform cron.schedule('pulse-research', '*/5 * * * *', format(
    $cmd$select net.http_post(url := %L, headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', %L), body := '{}'::jsonb, timeout_milliseconds := 150000)$cmd$,
    research_url, secret));
end;
$$;
revoke all on function public.pulse_install_cron(text, text) from public, anon, authenticated;
grant execute on function public.pulse_install_cron(text, text) to service_role;
