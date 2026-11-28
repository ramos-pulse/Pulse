-- 28/11 : le dépôt de 10,68 USDC (bot 1, 9 h 00) a eu lieu avant que le « plus haut » du cerveau suive les dépôts.
-- Rattrapage ponctuel : +10,675391 $, seulement si ce plus haut n'en tient pas déjà compte (< 20 $).
update bot_state
set price_history = jsonb_set(price_history, '{brain,equityHigh}', to_jsonb(round(((price_history->'brain'->>'equityHigh')::numeric + 10.675391), 2)))
where kind = 'spot'
  and price_history->'brain'->>'equityHigh' is not null
  and (price_history->'brain'->>'equityHigh')::numeric < 20;
