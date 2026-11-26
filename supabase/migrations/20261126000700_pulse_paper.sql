-- Mode paper trade : portefeuille fictif par bot, trades fictifs marqués, résultats paper par stratégie
alter table public.bot_state add column if not exists paper jsonb;
alter table public.trades add column if not exists paper boolean not null default false;
alter table public.research add column if not exists paper jsonb;
-- un bot déjà en mission réelle (ou avec une position) reste en RÉEL ; les autres démarrent en paper par défaut
update public.bot_state set paper = '{"on": false, "startUsd": 100}'::jsonb
 where paper is null and (status in ('running', 'paused') or position_mint is not null or position_side is not null);
