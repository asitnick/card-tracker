// card-tracker/fetch-prices.js
// Runs on a schedule via GitHub Actions.
// Reads watchlist from Supabase, fetches prices from JustTCG, stores results,
// and sends Discord alerts when a threshold is crossed.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK; // optional

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- JustTCG ---

async function fetchPrices(tcgNames) {
  // JustTCG allows up to 20 cards per request on the free tier.
  // We chunk the watchlist just in case it ever grows past 20.
  const chunks = chunkArray(tcgNames, 20);
  const results = {};

  for (const chunk of chunks) {
    const params = new URLSearchParams();
    chunk.forEach(name => params.append('names', name));
    params.append('game', 'Star Wars: Unlimited');

    const res = await fetch(
      `https://api.justtcg.com/v1/prices?${params.toString()}`,
      { headers: { 'x-api-key': JUSTTCG_API_KEY } }
    );

    if (!res.ok) {
      console.error(`JustTCG error ${res.status}:`, await res.text());
      continue;
    }

    const data = await res.json();

    // Expected shape: { prices: [{ name, market_price, low_price, mid_price }, ...] }
    // Adjust this if JustTCG's actual response shape differs.
    for (const item of data.prices ?? []) {
      results[item.name] = {
        market_price: item.market_price ?? null,
        low_price:    item.low_price    ?? null,
        mid_price:    item.mid_price    ?? null,
      };
    }
  }

  return results;
}

// --- Supabase ---

async function getWatchlist() {
  const { data, error } = await supabase
    .from('watchlist')
    .select('id, base_name, tcg_name, threshold')
    .eq('active', true);

  if (error) throw new Error(`Supabase watchlist read failed: ${error.message}`);
  return data;
}

async function storePriceSnapshots(snapshots) {
  const { error } = await supabase
    .from('price_history')
    .insert(snapshots);

  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
}

// --- Alerts ---

async function sendDiscordAlert(alerts) {
  if (!DISCORD_WEBHOOK || alerts.length === 0) return;

  const lines = alerts.map(a =>
    `**${a.base_name}** (${a.tcg_name})\n` +
    `  Current: $${a.market_price.toFixed(2)} — at or below your $${a.threshold.toFixed(2)} alert`
  );

  const body = {
    content: `🚨 **Card Price Alert** — ${alerts.length} card${alerts.length > 1 ? 's' : ''} hit your threshold:\n\n${lines.join('\n\n')}`,
  };

  const res = await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) console.error('Discord webhook failed:', res.status);
  else console.log(`Alert sent for: ${alerts.map(a => a.tcg_name).join(', ')}`);
}

// --- Utilities ---

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// --- Main ---

async function main() {
  console.log('Starting price fetch:', new Date().toISOString());

  const watchlist = await getWatchlist();
  if (watchlist.length === 0) {
    console.log('Watchlist is empty — nothing to fetch.');
    return;
  }
  console.log(`Fetching prices for ${watchlist.length} card(s)...`);

  const tcgNames = watchlist.map(c => c.tcg_name);
  const prices   = await fetchPrices(tcgNames);

  const snapshots = [];
  const alerts    = [];

  for (const card of watchlist) {
    const price = prices[card.tcg_name];

    if (!price) {
      console.warn(`No price returned for: ${card.tcg_name}`);
      continue;
    }

    snapshots.push({
      watchlist_id: card.id,
      market_price: price.market_price,
      low_price:    price.low_price,
      mid_price:    price.mid_price,
    });

    if (
      card.threshold !== null &&
      price.market_price !== null &&
      price.market_price <= card.threshold
    ) {
      alerts.push({ ...card, market_price: price.market_price });
    }

    console.log(`${card.tcg_name}: $${price.market_price?.toFixed(2) ?? 'n/a'}`);
  }

  await storePriceSnapshots(snapshots);
  console.log(`Stored ${snapshots.length} price snapshot(s).`);

  await sendDiscordAlert(alerts);

  console.log('Done:', new Date().toISOString());
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
