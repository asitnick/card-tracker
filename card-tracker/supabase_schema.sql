-- Card Price Tracker: Supabase Schema
-- Run this in your Supabase project's SQL Editor

-- Watchlist: one row per card variant you're tracking
create table watchlist (
  id           uuid primary key default gen_random_uuid(),
  base_name    text not null,           -- e.g. "Luke Skywalker"
  tcg_name     text not null unique,    -- e.g. "Luke Skywalker - Showcase Foil" (used for API lookups)
  set_name     text not null,           -- e.g. "Spark of Rebellion"
  game         text not null default 'Star Wars: Unlimited',  -- future-proofing for other games
  threshold    numeric(10,2),           -- alert when price drops to or below this
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Price history: one row per poll per card
create table price_history (
  id           uuid primary key default gen_random_uuid(),
  watchlist_id uuid not null references watchlist(id) on delete cascade,
  market_price numeric(10,2),           -- TCGPlayer market price
  low_price    numeric(10,2),           -- lowest listed price
  mid_price    numeric(10,2),           -- mid price
  fetched_at   timestamptz not null default now()
);

-- Index for fast lookups of a card's price history, newest first
create index price_history_watchlist_fetched
  on price_history(watchlist_id, fetched_at desc);

-- Convenience view: watchlist joined with its most recent price snapshot
create view watchlist_current as
select
  w.id,
  w.base_name,
  w.tcg_name,
  w.set_name,
  w.game,
  w.threshold,
  w.active,
  w.created_at,
  ph.market_price,
  ph.low_price,
  ph.mid_price,
  ph.fetched_at as last_fetched,
  case
    when ph.market_price is not null and w.threshold is not null
    then ph.market_price <= w.threshold
    else false
  end as alert_triggered
from watchlist w
left join lateral (
  select market_price, low_price, mid_price, fetched_at
  from price_history
  where watchlist_id = w.id
  order by fetched_at desc
  limit 1
) ph on true
where w.active = true;
