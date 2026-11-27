-- Extra souple réglé bot par bot : coupé pour le bot perps (demande de Ramos, 27/11), gardé pour le bot spot.
update public.bot_state set config = coalesce(config, '{}'::jsonb) || '{"extraSoft": false}'::jsonb where kind = 'perps';
