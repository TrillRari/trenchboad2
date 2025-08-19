import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";

/**
 * Solana Trench Board — Dashboard (React + D3)
 * - Bandeau pub 1 slot (texte centré), rotation ~8s, fade simple
 * - Bubble map + Top par hype (MC sous Chg)
 * - Pop-up: boutons Axiom & Trojan à côté de DexScreener et Copy CA
 * - Cartes Top par hype: clic ouvre Axiom (ref @lehunnid), plus d’ancres imbriquées
 */

// URL helpers
function buildAxiomUrl(ca, username = "lehunnid") {
  return `https://axiom.trade/t/${ca}/@${username}`;
}
function buildTrojanUrl(ca, ref = "reelchasin") {
  return `https://t.me/solana_trojanbot?start=r-${ref}-${ca}`;
}

export default function App() {
  // ------------------ UI State ------------------
  const [timeframe, setTimeframe] = useState("h1"); // m5|h1|h6|h24
  const [minLiq, setMinLiq] = useState(20000);
  const [limit, setLimit] = useState(40);
  const [weights, setWeights] = useState({ price: 0.5, volume: 0.3, txns: 0.1, boost: 0.1 });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState(null);
  const [selected, setSelected] = useState(null);

  // ------------------ Data ------------------
  const [rawBoosts, setRawBoosts] = useState([]);   // DexScreener boosts
  const [tokenPairs, setTokenPairs] = useState({}); // { baseTokenAddress: bestPair }
  const [profiles, setProfiles] = useState({});     // token profiles (logos)

  // ------------------ Refs (D3) ------------------
  const svgRef = useRef(null);
  const zoomRef = useRef(null);

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
      const liq = +((p.liquidity||{}).usd || 0);
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
    setLoading(true); setError("");
    try {
      const boosts = await fetchBoosts();
      const SAMPLE = Math.max(limit * 5, 120);
      const addrList = Array.from(new Set(boosts.map(b => b.tokenAddress))).slice(0, SAMPLE);
      const pairsMap = await fetchPairs(addrList);
      const profMap  = await fetchProfiles();
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

  useEffect(() => { load(); }, [limit]);

  // ------------------ Helpers ------------------
  const pick = (obj, key, fallback = 0) => (obj && obj[key] != null ? (+obj[key] || 0) : fallback);

  // ------------------ Nœuds (bubbles) ------------------
  const nodes = useMemo(() => {
    const list = Object.values(tokenPairs)
      .filter(p => (p.chainId || "").toLowerCase() === "solana" && +((p.liquidity||{}).usd || 0) >= minLiq);

    const vols = list.map(p => pick(p.volume, timeframe === "m5" ? "m5" : timeframe, 0));
    const txns = list.map(p => (p.txns?.[timeframe]?.buys || 0) + (p.txns?.[timeframe]?.sells || 0));
    const volScale = d3.scaleLinear().domain([d3.min(vols) || 0, d3.max(vols) || 1]).range([0, 1]).clamp(true);
    const txnScale = d3.scaleLinear().domain([d3.min(txns) || 0, d3.max(txns) || 1]).range([0, 1]).clamp(true);

    const boostMap = new Map(rawBoosts.map(b => [b.tokenAddress, (b.totalAmount ?? b.amount ?? b.score ?? 0)]));
    const boostVals = list.map(p => boostMap.get(p.baseToken?.address) || 0);
    const boostScale = d3.scaleLinear().domain([d3.min(boostVals) || 0, d3.max(boostVals) || 1]).range([0, 1]).clamp(true);

    const out = list.map(p => {
      const addr  = p.baseToken?.address;
      const vol   = pick(p.volume, timeframe === "m5" ? "m5" : timeframe, 0);
      const txn   = (p.txns?.[timeframe]?.buys || 0) + (p.txns?.[timeframe]?.sells || 0);
      const txnH1 = (p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0); // pop-up
      const priceChg = pick(p.priceChange, timeframe, 0);
      const boost = boostMap.get(addr) || 0;

      const nPrice = d3.scaleLinear().domain([-50, 50]).range([0, 1]).clamp(true)(priceChg);
      const nVol   = volScale(vol);
      const nTxn   = txnScale(txn);
      const nBoost = boostScale(boost);
      const hype   = nPrice * weights.price + nVol * weights.volume + nTxn * weights.txns + nBoost * weights.boost;

      const icon   = profiles[addr]?.icon || p.info?.imageUrl || "";
      const name   = p.baseToken?.name   || "?";
      const symbol = p.baseToken?.symbol || "?";
      const url    = p.url;
      const liquidity = +((p.liquidity || {}).usd || 0);
      const priceUsd  = +(p.priceUsd || 0);
      const mc        = +(p.fdv ?? p.marketCap ?? 0);

      return { id: addr, name, symbol, url, icon, hype, priceChg, vol, txn, txnH1, boost, liquidity, priceUsd, mc };
    });

    const q = query.trim().toLowerCase();
    const filtered = q ? out.filter(n => n.symbol?.toLowerCase().includes(q) || n.name?.toLowerCase().includes(q)) : out;

    return filtered.sort((a, b) => b.hype - a.hype).slice(0, limit);
  }, [tokenPairs, profiles, rawBoosts, timeframe, weights, minLiq, query, limit]);

  // ------------------ Layout + Zoom/Pan (D3) ------------------
  const [dims, setDims] = useState({ w: 1200, h: 700 });
  useEffect(() => {
    const onResize = () => {
      const el = svgRef.current?.parentElement;
      if (!el) return;
      setDims({ w: el.clientWidth - 2, h: Math.max(420, Math.floor(el.clientWidth * 0.5)) });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const color = d3.scaleLinear().domain([-20, 0, 20]).range(["#cc2442", "#8a97b2", "#14F195"]).clamp(true);

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    const { w, h } = dims;

    const maxR = Math.min(90, Math.max(24, Math.min(w, h) / 9));
    const minR = nodes.length > 150 ? 5 : nodes.length > 100 ? 7 : nodes.length > 60 ? 9 : 12;
    const r = d3.scaleSqrt()
      .domain([0, d3.max(nodes.map(n => n.hype)) || 1])
      .range([minR, maxR]);

    const defs = svg.append("defs");
    const gradBG = defs.append("radialGradient").attr("id", "bg").attr("cx", "50%").attr("cy", "0%");
    gradBG.append("stop").attr("offset", "0%").attr("stop-color", "#9945FF").attr("stop-opacity", 0.18);
    gradBG.append("stop").attr("offset", "100%").attr("stop-color", "#00FFA3").attr("stop-opacity", 0.06);

    svg.append("rect").attr("x",0).attr("y",0).attr("width",w).attr("height",h).attr("fill","url(#bg)").attr("rx",12);

    const g = svg.append("g");

    const tooltip = d3.select("body").append("div")
      .attr("class", "pointer-events-none fixed z-50 p-3 rounded-xl text-sm bg-[#0f1117]/90 border border-white/10 shadow-xl hidden text-white");

    function showTooltip(event, d) {
      tooltip.html(
        `<div class='font-semibold mb-1'>${d.symbol} · <span class='text-white/70'>${d.name}</span></div>
         <div class='grid grid-cols-2 gap-x-6 gap-y-1 text-white/80'>
           <div>MC</div><div class='text-right'>${d.mc ? '$' + d3.format(",.0f")(d.mc) : '—'}</div>
           <div>Chg ${timeframe}</div><div class='text-right' style='color:${color(d.priceChg)}'>${(isFinite(d.priceChg)?d.priceChg.toFixed(2):0)}%</div>
           <div>Prix</div><div class='text-right'>$${d.priceUsd.toFixed(6)}</div>
           <div>Vol ${timeframe}</div><div class='text-right'>$${d3.format(",.0f")(d.vol)}</div>
           <div>Txns ${timeframe}</div><div class='text-right'>${d.txn}</div>
           <div>Boost</div><div class='text-right'>${d.boost || 0}</div>
           <div>Liquidité</div><div class='text-right'>$${d3.format(",.0f")(d.liquidity)}</div>
         </div>`
      )
      .style("left", `${event.pageX + 16}px`)
      .style("top",  `${event.pageY + 16}px`)
      .classed("hidden", false);
    }
    function hideTooltip(){ tooltip.classed("hidden", true); } // ne pas remove()

    const zoomBehavior = d3.zoom().scaleExtent([0.5, 6]).on("zoom", (ev) => {
      g.attr("transform", ev.transform);
    });
    svg.call(zoomBehavior);
    zoomRef.current = { svg, zoomBehavior };

    const sim = d3.forceSimulation(nodes)
      .velocityDecay(0.35)
      .force("charge", d3.forceManyBody().strength(1.5))
      .force("collide", d3.forceCollide().radius(d => r(d.hype) + 1.5).iterations(2))
      .force("x", d3.forceX(w / 2).strength(0.03))
      .force("y", d3.forceY(h / 2).strength(0.03))
      .alpha(0.7).alphaDecay(0.015)
      .alphaTarget(0.02);

    // Légère dérive du centre pour un mouvement continu
    const drift = d3.timer((elapsed) => {
      const t = elapsed / 1000;
      const cx = w / 2 + Math.sin(t * 0.20) * 12;
      const cy = h / 2 + Math.cos(t * 0.17) * 12;
      sim.force("x", d3.forceX(cx).strength(0.03));
      sim.force("y", d3.forceY(cy).strength(0.03));
    });

    const node = g.selectAll("g.node").data(nodes, d => d.id).join(enter => {
      const wrap = enter.append("g").attr("class", "node cursor-pointer").call(drag(sim));

      wrap.append("circle")
        .attr("r", d => r(d.hype))
        .attr("fill", d => `url(#grad-${d.id})`)
        .attr("stroke", "#0d1626").attr("stroke-width", 1.5)
        .on("mousemove", (e, d) => showTooltip(e, d))
        .on("mouseout", hideTooltip)
        .on("click", (_, d) => setSelected(d));

      wrap.each(function(d){
        const gid = `grad-${d.id}`;
        if (!document.getElementById(gid)) {
          const g1 = defs.append("radialGradient").attr("id", gid);
          g1.append("stop").attr("offset","0%").attr("stop-color","#14F195").attr("stop-opacity",0.9);
          g1.append("stop").attr("offset","100%").attr("stop-color","#9945FF").attr("stop-opacity",0.6);
        }
      });

      // Pastille logo
      wrap.each(function(d){
        if(!d.icon) return;
        const R = r(d.hype);
        const size = Math.max(16, Math.min(28, R * 0.42));
        const y = -(R - (size/2 + 6));
        const clipId = `clip-${d.id}`;
        if (!document.getElementById(clipId)) {
          const cp = defs.append("clipPath").attr("id", clipId).attr("clipPathUnits","objectBoundingBox");
          cp.append("circle").attr("cx", 0.5).attr("cy", 0.5).attr("r", 0.5);
        }
        d3.select(this).append("circle")
          .attr("cx", 0).attr("cy", y).attr("r", size/2 + 2)
          .attr("fill", "#0b0f14").attr("stroke", "#14F195").attr("stroke-width", 1);
        d3.select(this).append("image")
          .attr("href", d.icon)
          .attr("xlink:href", d.icon)
          .attr("x", -size/2).attr("y", y - size/2)
          .attr("width", size).attr("height", size)
          .attr("clip-path", `url(#${clipId})`);
      });

      // Symbole
      wrap.append("text")
        .attr("text-anchor", "middle")
        .attr("y", 6)
        .attr("class", "select-none pointer-events-none font-semibold")
        .style("font-size", d => `${Math.max(10, Math.min(16, r(d.hype) / 2.6))}px`)
        .text(d => d.symbol);

      // %
      wrap.append("text")
        .attr("text-anchor", "middle")
        .attr("y", d => Math.min(r(d.hype) * 0.6, r(d.hype) - 6))
        .attr("class", "select-none pointer-events-none")
        .style("font-weight", 700)
        .style("font-size", d => `${Math.max(9, r(d.hype) / 3.2)}px`)
        .style("fill", d => color(d.priceChg))
        .text(d => `${(isFinite(d.priceChg) ? d.priceChg.toFixed(2) : 0)}%`);

      return wrap;
    });

    sim.on("tick", () => {
      node.attr("transform", d => `translate(${d.x || w/2},${d.y || h/2})`);
    });

    function drag(sim){
      function dragstarted(event) {
        if (!event.active) sim.alphaTarget(0.2).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      }
      function dragged(event) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      }
      function dragended(event) {
        if (!event.active) sim.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      }
      return d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended);
    }

    return () => { sim.stop(); drift.stop(); hideTooltip(); };
  }, [nodes, dims, timeframe]);

  // ------------------ Zoom buttons ------------------
  const zoomIn = () => { const z = zoomRef.current; if (z) z.svg.transition().duration(200).call(z.zoomBehavior.scaleBy, 1.25); };
  const zoomOut = () => { const z = zoomRef.current; if (z) z.svg.transition().duration(200).call(z.zoomBehavior.scaleBy, 0.8); };
  const resetZoom = () => { const z = zoomRef.current; if (z) z.svg.transition().duration(200).call(z.zoomBehavior.transform, d3.zoomIdentity); };

  // ------------------ Helpers UI ------------------
  const short = (a) => (a ? `${a.slice(0,4)}…${a.slice(-4)}` : "");
  function handleCopy(id){
    try {
      navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(()=> setCopiedId(null), 1200);
    } catch {}
  }

  // ------------------ Ads (bandeau, 1 slot, centré) ------------------
  const ads = [
    { id: "axiom",   label: "Trade faster with ", brand: "Axiom", href: "https://axiom.trade/@lehunnid", note: "Low fees. Fast fills." },
    { id: "trenchor",label: "Copy-trade the best traders with ", brand: "Trenchor Bot", href: "https://t.me/Trenchor_bot?start=5691367640", note: "Auto copy-trade on Telegram", emoji: "🪖" },
    { id: "photon",  label: "Be the first on any token with ", brand: "Photon", href: "https://photon-sol.tinyastro.io/@cryptohustlers", note: "Catch listings first. Move fast." },
    { id: "ad_contact", label: "Your link here? ", brand: "Contact us", href: "https://t.me/reelchasin" }
  ];

  // ------------------ Render ------------------
  return (
    <div className="min-h-screen w-full bg-[#090a0f] text-white">
      <header className="sticky top-0 z-20 backdrop-blur bg-[#0a0b10]/70 border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl md:text-2xl font-extrabold tracking-tight">
            <span className="bg-gradient-to-r from-[#9945FF] via-[#14F195] to-[#00FFA3] bg-clip-text text-transparent">Trench Board</span>
          </h1>
          <button onClick={load} className="rounded-xl px-4 py-2 bg-[#141a26] border border-white/10 hover:border-white/20">
            {loading ? "Chargement…" : "Rafraîchir"}
          </button>
        </div>
      </header>

      <AdBanner ads={ads} intervalMs={8000} selectedCA={selected?.id} />

      <main className="max-w-7xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Panneau de contrôle */}
        <section className="lg:col-span-4 space-y-4">
          <div className="p-4 rounded-2xl border border-white/10 bg-[#0f1117]/60">
            <div className="text-sm text-white/70 mb-2">Paramètres</div>
            <div className="grid grid-cols-2 gap-4">
              <label className="text-sm">Timeframe
                <select className="w-full mt-1 bg-[#0b0f14] border border-white/10 rounded-lg p-2" value={timeframe} onChange={e=>setTimeframe(e.target.value)}>
                  <option value="m5">5m</option>
                  <option value="h1">1h</option>
                  <option value="h6">6h</option>
                  <option value="h24">24h</option>
                </select>
              </label>
              <label className="text-sm">Min Liquidité ($)
                <input type="number" className="w-full mt-1 bg-[#0b0f14] border border-white/10 rounded-lg p-2" value={minLiq} onChange={e=>setMinLiq(+e.target.value || 0)} />
              </label>
              <label className="text-sm">Nombre de tokens
                <input type="number" className="w-full mt-1 bg-[#0b0f14] border border-white/10 rounded-lg p-2" value={limit} onChange={e=>setLimit(Math.max(5, Math.min(300, +e.target.value || 20)))} />
              </label>
              <label className="text-sm">Filtre (nom/symbole)
                <input className="w-full mt-1 bg-[#0b0f14] border border-white/10 rounded-lg p-2" placeholder="ex: JUP, BONK" value={query} onChange={e=>setQuery(e.target.value)} />
              </label>
            </div>
          </div>

          <div className="p-4 rounded-2xl border border-white/10 bg-[#0f1117]/60">
            <div className="text-sm text-white/70 mb-2">Poids du score "hype"</div>
            <Slider label="Prix"    value={weights.price} onChange={v=>setWeights(s=>({...s, price:v}))} />
            <Slider label="Volume"  value={weights.volume} onChange={v=>setWeights(s=>({...s, volume:v}))} />
            <Slider label="Transactions" value={weights.txns} onChange={v=>setWeights(s=>({...s, txns:v}))} />
            <Slider label="Boosts"  value={weights.boost} onChange={v=>setWeights(s=>({...s, boost:v}))} />
            <div className="text-xs text-white/60 mt-2">Astuce : “Boost” reflète la mise en avant DexScreener (buzz court terme).</div>
          </div>

          {error && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-200">{error}</div>}
        </section>

        {/* Bubble chart */}
        <section className="lg:col-span-8 p-2 rounded-2xl border border-white/10 bg-[#0f1117]/60">
          <div className="relative">
            <svg ref={svgRef} width={dims.w} height={dims.h} />
            <div className="absolute right-3 top-3 flex flex-col gap-2">
              <button onClick={zoomIn} className="w-9 h-9 rounded-lg bg-[#0b0f14]/80 border border-white/10 hover:border-white/30">+</button>
              <button onClick={zoomOut} className="w-9 h-9 rounded-lg bg-[#0b0f14]/80 border border-white/10 hover:border-white/30">−</button>
              <button onClick={resetZoom} className="w-9 h-9 text-xs rounded-lg bg-[#0b0f14]/80 border border-white/10 hover:border-white/30">100%</button>
            </div>
          </div>
          <div className="flex items-center justify-between px-2 pb-2 text-xs text-white/60">
            <div>{nodes.length} tokens · timeframe {timeframe}</div>
            <div>Zoom: molette/pinch · Drag: déplacer · Clic: pop-up d'infos</div>
          </div>
        </section>

        {/* Top par hype */}
        <section className="lg:col-span-12 p-4 rounded-2xl border border-white/10 bg-[#0f1117]/60">
          <div className="text-sm text-white/70 mb-2">Top par hype</div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {nodes.slice(0, 24).map(n => (
              <div
                key={n.id}
                role="link"
                tabIndex={0}
                onClick={() => window.open(buildAxiomUrl(n.id), "_blank", "noopener,noreferrer")}
                onKeyDown={(e) => { if (e.key === "Enter") window.open(buildAxiomUrl(n.id), "_blank", "noopener,noreferrer"); }}
                className="group rounded-xl border border-white/10 p-3 hover:border-white/30 bg-[#0b0f14] cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full overflow-hidden border border-white/10">
                    {n.icon ? (
                      <img src={n.icon} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-[#14F195] to-[#9945FF]" />
                    )}
                  </div>
                  <div className="font-semibold">{n.symbol}</div>
                  <div className="text-xs text-white/60 truncate flex-1">{n.name}</div>
                </div>
                <div className="mt-2 grid grid-cols-2 text-xs gap-x-2 text-white/70">
                  <div>Chg {timeframe}</div><div className="text-right" style={{color: color(n.priceChg)}}>{(isFinite(n.priceChg)?n.priceChg.toFixed(2):0)}%</div>
                  <div>MC</div><div className="text-right">{n.mc ? `$${d3.format(",.0f")(n.mc)}` : "—"}</div>
                  <div>Vol {timeframe}</div><div className="text-right">${d3.format(",.0f")(n.vol)}</div>
                  <div>LiQ</div><div className="text-right">${d3.format(",.0f")(n.liquidity)}</div>
                  <div>Boost</div><div className="text-right">{n.boost || 0}</div>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <button
                    className="text-blue-300 hover:underline"
                    onClick={(e)=>{ e.stopPropagation(); window.open(`https://solscan.io/token/${n.id}`, "_blank", "noopener,noreferrer"); }}
                    title="Voir sur Solscan"
                  >
                    {short(n.id)}
                  </button>
                  <button
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-white/10 hover:border-white/30"
                    onClick={(e)=>{ e.stopPropagation(); handleCopy(n.id); }}
                    title="Copier le CA"
                  >
                    <CopyIcon className="w-3 h-3" /> {copiedId===n.id ? "Copié" : "Copy"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Pop-up d'infos */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={()=>setSelected(null)}>
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1117]" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center gap-3 p-4 border-b border-white/10">
              <div className="w-8 h-8 rounded-full overflow-hidden border border-white/10">
                {selected.icon ? (
                  <img src={selected.icon} alt="" className="w-full h-full object-cover"/>
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-[#14F195] to-[#9945FF]" />
                )}
              </div>
              <div className="font-bold">{selected.symbol}</div>
              <div className="text-xs text-white/60 truncate">{selected.name}</div>
              <button className="ml-auto p-1 rounded hover:bg-white/10" onClick={()=>setSelected(null)} aria-label="Fermer">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <div className="p-4 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">MC<br/><span className="font-semibold">{selected.mc ? `$${d3.format(",.0f")(selected.mc)}` : "—"}</span></div>
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">Chg {timeframe}<br/><span className="font-semibold" style={{color: color(selected.priceChg)}}>{(isFinite(selected.priceChg)?selected.priceChg.toFixed(2):0)}%</span></div>
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">Liquidité<br/><span className="font-semibold">${d3.format(",.0f")(selected.liquidity)}</span></div>
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">Vol {timeframe}<br/><span className="font-semibold">${d3.format(",.0f")(selected.vol)}</span></div>
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">Txns 1h<br/><span className="font-semibold">{selected.txnH1}</span></div>
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">Prix<br/><span className="font-semibold">${(selected.priceUsd ?? 0).toFixed(6)}</span></div>
            </div>

            {/* BOUTONS: Copy CA, DexScreener, Axiom, Trojan */}
            <div className="p-4 border-t border-white/10 flex items-center justify-between text-xs">
              <a href={`https://solscan.io/token/${selected.id}`} target="_blank" rel="noreferrer" className="text-blue-300 hover:underline">{short(selected.id)}</a>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-white/10 hover:border-white/30"
                  onClick={()=>handleCopy(selected.id)}
                >
                  <CopyIcon className="w-3 h-3"/> {copiedId===selected.id ? "Copié" : "Copy CA"}
                </button>
                <a className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-white/10 hover:border-white/30" href={selected.url} target="_blank" rel="noreferrer">
                  DexScreener
                </a>
                <a className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-white/10 hover:border-white/30" href={buildAxiomUrl(selected.id)} target="_blank" rel="noreferrer">
                  Axiom
                </a>
                <a className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-white/10 hover:border-white/30" href={buildTrojanUrl(selected.id)} target="_blank" rel="noreferrer">
                  Trojan
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="max-w-7xl mx-auto px-4 py-8 text-center text-xs text-white/40">
        Données: DexScreener (API publique). Ceci n'est pas un conseil financier.
      </footer>
    </div>
  );
}

/* --------- Bandeau pub (1 slot, centré, fade) --------- */
function AdBanner({ ads = [], intervalMs = 8000, selectedCA }) {
  const [i, setI] = React.useState(0);
  useEffect(() => {
    if (!ads.length) return;
    const t = setInterval(() => setI(v => (v + 1) % ads.length), intervalMs);
    return () => clearInterval(t);
  }, [ads.length, intervalMs]);

  const ad = ads.length ? ads[i % ads.length] : null;
  if (!ad) return null;

  return (
    <section className="bg-[#0f1117]/60 border-b border-white/10">
      {/* Fade simple via keyframes */}
      <style>{`@keyframes adFade{from{opacity:0}to{opacity:1}} .ad-fade{animation:adFade .9s ease-in-out}`}</style>
      <div className="max-w-7xl mx-auto px-4">
        <div key={ad.id} className="ad-fade">
          <div className="h-10 md:h-12 flex items-center justify-center text-center">
            {ad.emoji ? <span className="mr-2 text-base md:text-lg" aria-hidden="true">{ad.emoji}</span> : null}
            <span className="text-sm">
              <span className="text-white/80">{ad.label}</span>
              <a href={ad.href} target="_blank" rel="noreferrer" className="font-semibold underline hover:opacity-80">{ad.brand}</a>
              {ad.note ? <span className="text-white/50"> — {ad.note}</span> : null}
            </span>
          </div>

          {selectedCA && (
            <div className="pb-3 flex items-center justify-center gap-2 flex-wrap">
              <a
                href={buildAxiomUrl(selectedCA)}
                target="_blank" rel="noreferrer"
                className="px-3 py-1.5 text-xs rounded-lg border border-white/15 bg-white/5 hover:bg-white/10"
              >Axiom</a>
              <a
                href={buildTrojanUrl(selectedCA)}
                target="_blank" rel="noreferrer"
                className="px-3 py-1.5 text-xs rounded-lg border border-white/15 bg-white/5 hover:bg-white/10"
              >Trojan</a>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* --------- Composants utilitaires --------- */
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
        onChange={e=>onChange(+e.target.value)}
        className="w-full accent-[#14F195]"
      />
      <div className="text-right text-xs text-white/70">{value.toFixed(2)}</div>
    </div>
  );
}

function CopyIcon({ className }){
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="9" y="9" width="13" height="13" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  );
}
