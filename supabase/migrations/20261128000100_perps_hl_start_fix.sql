-- 28/11 : le transfert Spot → Perps de Ramos (son propre compte) a été compté à tort comme un dépôt de 39,17 $.
-- Point de départ, perte du jour et courbe du bot perps remis à la valeur réelle du compte ; ligne « dépôt » erronée retirée.
update public.bot_state
   set start_value_usd = last_value_usd,
       price_history = coalesce(price_history, '{}'::jsonb) || jsonb_build_object('curve', '[]'::jsonb, 'dayStartValue', last_value_usd)
 where kind = 'perps' and start_value_usd > last_value_usd * 1.9 and last_value_usd > 0;
delete from public.trades where bot = 'perps' and action = 'deposit' and reason = 'send' and created_at > '2026-11-28 00:30:00+00' and created_at < '2026-11-28 00:45:00+00';
