-- Extra souple gardé pour le bot spot (demande de Ramos, 27/11) : remis après une bascule involontaire depuis l'ancienne app.
update public.bot_state set config = coalesce(config, '{}'::jsonb) || '{"extraSoft": true}'::jsonb where kind = 'spot';
