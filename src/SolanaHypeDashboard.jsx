import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";

/**
 * Trench Board — Dashboard (React + D3)
 */

// URL helpers
function buildAxiomUrl(ca, username = "trenchapp") {
  return `https://axiom.trade/t/${ca}/@${username}`;
}
function buildTrojanUrl(ca, ref = "trenchor_suppor") {
  return `https://t.me/solana_trojanbot?start=r-${ref}-${ca}`;
}
function buildPhotonUrl(ca, refHandle = "trenchboard") {
  return `https://photon-sol.tinyastro.io/en/r/@${refHandle}/${ca}`;
}

export default function App() {
  // ------------------ UI State ------------------
  const [timeframe, setTimeframe] = useState("h1");
  const [minLiq, setMinLiq] = useState(10000);
  const [limit, setLimit] = useState(20);
  const [weights, setWeights] = useState({ price: 0.5, volume: 0.3, txns: 0.1, boost: 0.1 });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState(null);
  const [selected, setSelected] = useState(null);

  // ------------------ Data ------------------
  const [rawBoosts, setRawBoosts] = useState([]);
  const [tokenPairs, setTokenPairs] = useState({});
  const [profiles, setProfiles] = useState({});

  // ------------------ Refs (D3) ------------------
  const svgRef = useRef(null);
  const zoomRef = useRef(null);
  const isTouchRef = useRef(false);

  useEffect(() => {
    isTouchRef.current =
      typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 0 || navigator.msMaxTouchPoints > 0);
  }, []);

  // ------------------ Fetch helpers ------------------
  async function getJSON(url, init) {
    const r = await fetch(url, init);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }

  async function fetchBoosts() {
    const data = await getJSON("https://api.dexscreener.com/token-boosts/top/v1");
    return data?.filter?.(d => d.chainId?.toLowerCase?.() === "solana") ?? [];
  }

  async function fetchPairs(addresses) {
    const chunkSize = 30;
    const batches = [];
    for (let i = 0; i < addresses.length; i += chunkSize) {
      const chunk = addresses.slice(i, i + chunkSize).join(",");
      batches.push(getJSON(`https://api.dexscreener.com/tokens/v1/solana/${chunk}`));
    }
    const settled = await Promise.allSettled(batches);
    const pairs = settled.flatMap(s => (s.status === "fulfilled" ? s.value : []));
    const map = {};
    for (const p of pairs) {
      const base = p.baseToken?.address;
      if (!base) continue;
      const liq = +((p.liquidity || {}).usd || 0);
      const prev = map[base]?.liquidity?.usd || 0;
      if (!map[base] || liq > prev) map[base] = p;
    }
    return map;
  }

  async function fetchProfiles() {
    const arr = await getJSON("https://api.dexscreener.com/token-profiles/latest/v1");
    const map = {};
    for (const p of arr || []) {
      if (p.chainId?.toLowerCase?.() !== "solana") continue;
      map[p.tokenAddress] = p;
    }
    return map;
  }

  // ------------------ Chargement principal ------------------
  async function load() {
    setLoading(true);
    setError("");
    try {
      const boosts = await fetchBoosts();
      const SAMPLE = Math.max(limit * 5, 120);
      const addrList = Array.from(new Set(boosts.map(b => b.tokenAddress))).slice(0, SAMPLE);
      const pairsMap = await fetchPairs(addrList);
      const profMap = await fetchProfiles();
      setRawBoosts(boosts);
      setTokenPairs(pairsMap);
      setProfiles(profMap);
    } catch (e) {
      console.error(e);
      setError(e.message || "Erreur inattendue");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [limit]);

  useEffect(() => {
    const id = setInterval(() => {
      load();
    }, 60000);
    return () => clearInterval(id);
  }, [limit, timeframe, minLiq, weights, query]);

  // ------------------ Helpers ------------------
  const pick = (obj, key, fallback = 0) =>
    obj && obj[key] != null ? +obj[key] || 0 : fallback;

  // ------------------ Nœuds (bubbles) ------------------
  const nodes = useMemo(() => {
    const list = Object.values(tokenPairs).filter(
      p =>
        (p.chainId || "").toLowerCase() === "solana" &&
        +((p.liquidity || {}).usd || 0) >= minLiq
    );

    const vols = list.map(p => pick(p.volume, timeframe === "m5" ? "m5" : timeframe, 0));
    const txns = list.map(
      p =>
        (p.txns?.[timeframe]?.buys || 0) +
        (p.txns?.[timeframe]?.sells || 0)
    );
    const volScale = d3
      .scaleLinear()
      .domain([d3.min(vols) || 0, d3.max(vols) || 1])
      .range([0, 1])
      .clamp(true);
    const txnScale = d3
      .scaleLinear()
      .domain([d3.min(txns) || 0, d3.max(txns) || 1])
      .range([0, 1])
      .clamp(true);

    const boostMap = new Map(
      rawBoosts.map(b => [b.tokenAddress, b.totalAmount ?? b.amount ?? b.score ?? 0])
    );
    const boostVals = list.map(p => boostMap.get(p.baseToken?.address) || 0);
    const boostScale = d3
      .scaleLinear()
      .domain([d3.min(boostVals) || 0, d3.max(boostVals) || 1])
      .range([0, 1])
      .clamp(true);

    const out = list.map(p => {
      const addr = p.baseToken?.address;
      const vol = pick(p.volume, timeframe === "m5" ? "m5" : timeframe, 0);
      const txn =
        (p.txns?.[timeframe]?.buys || 0) +
        (p.txns?.[timeframe]?.sells || 0);
      const txnH1 =
        (p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0);
      const priceChg = pick(p.priceChange, timeframe, 0);
      const priceChgH1 = pick(p.priceChange, "h1", 0);
      const boost = boostMap.get(addr) || 0;

      const nPrice = d3
        .scaleLinear()
        .domain([-50, 50])
        .range([0, 1])
        .clamp(true)(priceChg);
      const nVol = volScale(vol);
      const nTxn = txnScale(txn);
      const nBoost = boostScale(boost);
      const hype =
        nPrice * weights.price +
        nVol * weights.volume +
        nTxn * weights.txns +
        nBoost * weights.boost;

      const icon = profiles[addr]?.icon || p.info?.imageUrl || "";
      const name = p.baseToken?.name || "?";
      const symbol = p.baseToken?.symbol || "?";
      const url = p.url;
      const liquidity = +((p.liquidity || {}).usd || 0);
      const priceUsd = +(p.priceUsd || 0);
      const mc = +(p.fdv ?? p.marketCap ?? 0);

      return {
        id: addr,
        name,
        symbol,
        url,
        icon,
        hype,
        priceChg,
        priceChgH1,
        vol,
        txn,
        txnH1,
        boost,
        liquidity,
        priceUsd,
        mc,
      };
    });

    const q = query.trim().toLowerCase();
    const filtered = q
      ? out.filter(
          n =>
            n.symbol?.toLowerCase().includes(q) ||
            n.name?.toLowerCase().includes(q)
        )
      : out;

    return filtered.sort((a, b) => b.hype - a.hype).slice(0, limit);
  }, [tokenPairs, profiles, rawBoosts, timeframe, weights, minLiq, query, limit]);

  // ------------------ Layout + Zoom/Pan (D3) ------------------
  const [dims, setDims] = useState({ w: 1200, h: 700 });
  useEffect(() => {
    const onResize = () => {
      const el = svgRef.current?.parentElement;
      if (!el) return;
      setDims({
        w: el.clientWidth - 2,
        h: Math.max(420, Math.floor(el.clientWidth * 0.5)),
      });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const color = d3
    .scaleLinear()
    .domain([-20, 0, 20])
    .range(["#cc2442", "#8a97b2", "#14F195"])
    .clamp(true);

  // ------------------ Ads ------------------
  const ads = [
    {
      id: "axiom",
      label: "Trade faster with ",
      brand: "Axiom",
      href: "https://axiom.trade/@trenchapp",
      note: "Low fees. Fast fills.",
    },
    {
      id: "trenchor",
      label: "Copy-trade the best traders with ",
      brand: "Trenchor Bot",
      href: "https://t.me/Trenchor_bot?start=5691367640",
      note: "Auto copy-trade on Telegram",
      emoji: "🪖",
    },
    {
      id: "photon",
      label: "Be the first on any token with ",
      brand: "Photon",
      href: "https://photon-sol.tinyastro.io/@trenchboard",
      note: "Catch listings first. Move fast.",
    },
    {
      id: "ad_contact",
      label: "Your link here? ",
      brand: "Contact us",
      href: "https://t.me/trenchor_support",
    },
  ];

  // ------------------ Render ------------------
  return (
    <div className="min-h-screen w-full bg-[#090a0f] text-white">
      <header className="sticky top-0 z-20 backdrop-blur bg-[#0a0b10]/70 border-b border-white/10 gap-x-10">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center">
          <img
            src="/favicon.png"
            alt="Trench Board Logo"
            style={{
              height: "30px",
              width: "auto",
              borderRadius: "10px",
              marginRight: "5px",
            }}
          />
          <h1 className="text-xl md:text-2xl font-extrabold tracking-tight">
            <span className="text-white font-semibold text-xl">
              Trench Board
            </span>
          </h1>

          <button
            onClick={load}
            className="ml-auto rounded-xl px-4 py-2 bg-[#141a26] border border-white/10 hover:border-white/20"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

      <AdBanner ads={ads} intervalMs={6000} selectedCA={selected?.id} />

      {/* le reste du code est inchangé */}
    </div>
  );
}

/* --------- Bandeau pub --------- */
function AdBanner({ ads = [], intervalMs = 6000 }) {
  const [index, setIndex] = useState(0);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setIndex(prev => (prev + 1) % ads.length);
        setFade(true);
      }, 300);
    }, intervalMs);
    return () => clearInterval(interval);
  }, [ads.length, intervalMs]);

  const nextAd = () => {
    setFade(false);
    setTimeout(() => {
      setIndex(prev => (prev + 1) % ads.length);
      setFade(true);
    }, 300);
  };

  const prevAd = () => {
    setFade(false);
    setTimeout(() => {
      setIndex(prev => (prev - 1 + ads.length) % ads.length);
      setFade(true);
    }, 300);
  };

  if (!ads.length) return null;

  return (
    <div className="flex items-center justify-center gap-4 px-4 py-3 rounded-xl border border-white/10 bg-[#0f1117]/60 text-white relative overflow-hidden transition-all">
      <button
        onClick={prevAd}
        className="text-white/70 hover:text-white text-xl transition"
        aria-label="Previous ad"
      >
        ⬅
      </button>

      <div
        className={`flex-1 text-center text-sm sm:text-base font-medium transition-opacity duration-300 ${
          fade ? "opacity-100" : "opacity-0"
        }`}
      >
        {ads[index]}
      </div>

      <button
        onClick={nextAd}
        className="text-white/70 hover:text-white text-xl transition"
        aria-label="Next ad"
      >
        ➡
      </button>
    </div>
  );
}

/* --------- Utilitaires --------- */
function Slider({ label, value, onChange }) {
  return (
    <div className="grid grid-cols-[90px_1fr_60px] items-center gap-2 py-1">
      <div className="text-sm text-white/80">{label}</div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={e => onChange(+e.target.value)}
        className="w-full accent-[#14F195]"
      />
      <div className="text-right text-xs text-white/70">
        {value.toFixed(2)}
      </div>
    </div>
  );
}

function CopyIcon({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="9" y="9" width="13" height="13" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  );
}
