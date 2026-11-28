-- 28/11 : la sortie de l'ETH à l'équilibre (−0,08 $ de frais, stop remonté à l'entrée) avait été comptée comme une perte par le
-- cerveau du bot 2 (risque ramené à 90 %). Correction ponctuelle : forme rétablie à 100 %, une victoire d'affilée (le XMR +1,03 $).
update bot_state
set price_history = jsonb_set(jsonb_set(price_history, '{brain,riskMult}', '1'::jsonb), '{brain,streak}', '1'::jsonb)
where kind = 'perps'
  and (price_history->'brain'->>'riskMult')::numeric = 0.9
  and jsonb_array_length(coalesce(price_history->'brain'->'trades', '[]'::jsonb)) = 2;
