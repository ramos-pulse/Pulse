-- 28/11 : après chaque mise à jour, plusieurs appels de l'app réinstallaient le cron EN MÊME TEMPS
-- (« cron : tuple concurrently deleted »). Désormais : un seul à la fois (verrou), et rien n'est touché si le cron est déjà bon.
create or replace function public.pulse_install_cron(fn_url text, secret text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  research_url text := replace(fn_url, '/tick', '/research');
  tick_cmd text := format($cmd$select net.http_post(url := %L, headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', %L), body := '{}'::jsonb, timeout_milliseconds := 150000)$cmd$, fn_url, secret);
  research_cmd text := format($cmd$select net.http_post(url := %L, headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', %L), body := '{}'::jsonb, timeout_milliseconds := 150000)$cmd$, research_url, secret);
begin
  perform pg_advisory_xact_lock(hashtext('pulse_install_cron'));
  if exists (select 1 from cron.job where jobname = 'pulse-tick' and schedule = '* * * * *' and command = tick_cmd)
     and exists (select 1 from cron.job where jobname = 'pulse-research' and schedule = '*/5 * * * *' and command = research_cmd) then
    return; -- déjà installé à l'identique
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname in ('pulse-tick', 'pulse-research');
  perform cron.schedule('pulse-tick', '* * * * *', tick_cmd);
  perform cron.schedule('pulse-research', '*/5 * * * *', research_cmd);
end;
$$;
revoke all on function public.pulse_install_cron(text, text) from public, anon, authenticated;
grant execute on function public.pulse_install_cron(text, text) to service_role;
