-- Réglages choisis dans l'app (stratégie du bot spot, paramètres RSI).
alter table public.bot_state add column if not exists config jsonb not null default '{}'::jsonb;
