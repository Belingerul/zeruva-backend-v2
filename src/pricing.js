const DEFAULT_SOL_USD_FALLBACK = Number(process.env.USD_PER_SOL || 100);
const PRICE_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS || 60_000);

let cache = { value: null, ts: 0 };

async function fetchSolUsdFromCoinGecko() {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";
  const res = await fetch(url, {
    headers: {
      // Friendly UA; some public APIs rate-limit anonymous traffic.
      "user-agent": "zeruva-backend/1.0 (+https://zeruva)",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const json = await res.json();
  const price = Number(json?.solana?.usd);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid SOL/USD price");
  return price;
}

async function getSolUsdPrice({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.value && now - cache.ts < PRICE_CACHE_TTL_MS) {
    return { solUsd: cache.value, source: "cache" };
  }

  try {
    const solUsd = await fetchSolUsdFromCoinGecko();
    cache = { value: solUsd, ts: now };
    return { solUsd, source: "coingecko" };
  } catch (e) {
    // Fallback to env-configured constant.
    return { solUsd: DEFAULT_SOL_USD_FALLBACK, source: "fallback" };
  }
}

function usdToLamports({ usd, solUsd }) {
  // round *up* so user never underpays due to rounding.
  const lamports = Math.ceil((usd / solUsd) * 1e9);
  return lamports;
}

module.exports = { getSolUsdPrice, usdToLamports };
