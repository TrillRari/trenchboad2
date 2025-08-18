import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";

/**
 * =============================================================
 *  Solana Hype Dashboard — Bubble Map (with inline comments)
 * =============================================================
 *
 * ✦ Données live via DexScreener (API publique)
 * ✦ Enrichissement optionnel via Birdeye (clé API utilisateur)
 * ✦ Bulles dimensionnées par un score "hype" pondéré (prix/volume/txns/boost)
 * ✦ Drag des bulles, zoom/pan de la carte, pop-up d'infos au clic
 * ✦ Logos intégrés dans les bulles (pastille interne + clipPath)
 * ✦ Liste "Top par hype" avec CA copiable + liens DexScreener/Solscan
 *
 * REMARQUE : Ce composant est écrit en React + D3 (mode client). Les commentaires
 * détaillent les étapes un peu "piégeuses" : normalisation, force layout, zoom,
 * clipPath SVG pour les logos, et gestion des fetch en lots.
 */
export default function SolanaHypeDashboard() {
  // ------------------ UI State ------------------
  // Filtre de timeframe pour les métriques DexScreener (les clés existantes : m5, h1, h6, h24)
  const [timeframe, setTimeframe] = useState("h1");
  // Seuil minimum de liquidité en USD pour filtrer les paires trop illiquides
  const [minLiq, setMinLiq] = useState(20000);
  // Nombre maximum de tokens/bulles affichés (impacte le temps de layout)
  const [limit, setLimit] = useState(40);
  // Poids du score "hype" (0..1) — ajustables via sliders
  const [weights, setWeights] = useState({ price: 0.5, volume: 0.3, txns: 0.1, boost: 0.1 });
  // Clé API Birdeye (facultatif)
  const [birdeyeKey, setBirdeyeKey] = useState("");
  // Filtre texte (nom/symbole)
  const [query, setQuery] = useState("");
  // États de réseau et d'erreur
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Mémoire : identifiant copié (pour le feedback "Copié")
  const [copiedId, setCopiedId] = useState(null);
  // Token sélectionné (ouvre le pop-up)
  const [selected, setSelected] = useState(null);

  // ------------------ Data ------------------
  // Liste "boosts" DexScreener (proxy de buzz/visibilité)
  const [rawBoosts, setRawBoosts] = useState([]);
  // Map des meilleures paires par token { baseTokenAddress: pair }
  const [tokenPairs, setTokenPairs] = useState({});
  // Profils (icônes, liens sociaux) par CA de token
  const [profiles, setProfiles] = useState({});
  // Cache des holders par token (CA -> nombre de holders)
  const [holdersMap, setHoldersMap] = useState({});

  // ------------------ Refs (D3) ------------------
  // Référence au SVG principal (D3 interagit directement avec le DOM)
  const svgRef = useRef(null);
  // Référence pour garder l'état du comportement de zoom (pour boutons +/−/reset)
  const zoomRef = useRef(null);

  // ------------------ Utilitaires fetch ------------------
  // Petit helper générique pour fetch JSON + gestion d'erreur HTTP
  async function getJSON(url, init) {
    const r = await fetch(url, init);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }

  // 1) DexScreener : top boosts (sert d'ingrédient pour la "hype")
  async function fetchBoosts() {
    const data = await getJSON("https://api.dexscreener.com/token-boosts/top/v1");
    // On ne garde que Solana (chaînes mixtes sinon)
    return data?.filter?.(d => d.chainId?.toLowerCase?.() === "solana") ?? [];
  }

  // 2) DexScreener : métriques paires par lots de 30 adresses (limite API)
  async function fetchPairs(addresses) {
    const batches = [];
    const chunkSize = 30; // Limite API côté DexScreener
    for (let i = 0; i < addresses.length; i += chunkSize) {
      const chunk = addresses.slice(i, i + chunkSize);
      const url = `https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`;
      batches.push(getJSON(url));
    }
    // On ne laisse pas échouer tout le lot si une requête tombe (Promise.allSettled)
    const results = await Promise.allSettled(batches);
    const pairs = results.flatMap(r => (r.status === "fulfilled" ? r.value : []));

    // Réduction : on choisit la meilleure paire (plus forte liquidité) pour chaque token base
    const map = {};
    for (const p of pairs) {
      const baseAddr = p.baseToken?.address;
      if (!baseAddr) continue;
      if (!map[baseAddr]) map[baseAddr] = p;
      else {
        const liq = +(p?.liquidity?.usd || 0);
        const prevLiq = +(map[baseAddr]?.liquidity?.usd || 0);
        if (liq > prevLiq) map[baseAddr] = p;
      }
    }
    return map; // { tokenAddress: bestPair }
  }

  // 3) DexScreener : profils tokens (permet d'obtenir les icônes/logos)
  async function fetchProfiles() {
    const data = await getJSON("https://api.dexscreener.com/token-profiles/latest/v1");
    const map = {};
    for (const p of data || []) {
      if (p.chainId?.toLowerCase?.() !== "solana") continue;
      map[p.tokenAddress] = p; // clé : CA token
    }
    return map;
  }

  // 4) (Optionnel) Birdeye trending : on fusionne pour plus de signaux hype
  async function fetchBirdeyeTrending(limit = 20) {
    if (!birdeyeKey) return [];
    try {
      const url = `https://public-api.birdeye.so/defi/token_trending?chain=solana&sort_by=score&sort_type=desc&offset=0&limit=${limit}`;
      const data = await getJSON(url, { headers: { "X-API-KEY": birdeyeKey, accept: "application/json" } });
      const list = data?.data?.items || [];
      return list.map(x => ({ chainId: "solana", tokenAddress: x.address, score: x.score }));
    } catch (e) {
      console.warn("Birdeye error:", e);
      return [];
    }
  }

  // Birdeye: holders par token (on-demand pour le pop-up)
  async function fetchHolders(address){
    if (!birdeyeKey) return null;
    try {
      const url = `https://public-api.birdeye.so/defi/token_overview?address=${address}&chain=solana`;
      const data = await getJSON(url, { headers: { "X-API-KEY": birdeyeKey, accept: "application/json" } });
      const holders = data?.data?.holders ?? data?.data?.holder ?? data?.data?.holders_count ?? null;
      setHoldersMap(prev => ({ ...prev, [address]: holders }));
      return holders;
    } catch (e) {
      console.warn("Birdeye holders error:", e);
      setHoldersMap(prev => ({ ...prev, [address]: null }));
      return null;
    }
  }

  // ------------------ Chargement principal ------------------
  async function load() {
    setLoading(true); setError("");
    try {
      // a) Boosts DexScreener
      const boosts = await fetchBoosts();
      // b) Enrichissement Birdeye (si clé fournie)
      const bird = await fetchBirdeyeTrending(20);
      // c) Fusion + déduplication par adresse de token
      const merged = [...boosts, ...bird];
      const addr = Array.from(new Set(merged.map(d => d.tokenAddress))).slice(0, limit);
      // d) Récupération des paires/métriques pour ces adresses
      const pairsMap = await fetchPairs(addr);
      // e) Récupération des icônes/profils
      const profMap = await fetchProfiles();

      setRawBoosts(merged);
      setTokenPairs(pairsMap);
      setProfiles(profMap);
    } catch (e) {
      console.error(e);
      setError(e.message || "Erreur inattendue");
    } finally {
      setLoading(false);
    }
  }

  // Rechargement sur changement de limite ou de clé Birdeye
  useEffect(() => { load(); }, [limit, birdeyeKey]);

  // Quand on ouvre le pop-up, récupérer les holders si nécessaire
  useEffect(() => {
    if (selected && birdeyeKey && holdersMap[selected.id] == null) {
      fetchHolders(selected.id);
    }
  }, [selected, birdeyeKey]);

  // ------------------ Construction des nœuds (bubbles) ------------------
  // Helper pour lire une clé numérique avec fallback
  function pick(obj, key, fallback = 0) {
    if (!obj) return fallback;
    const v = obj[key];
    if (v == null) return fallback;
    return +v || 0;
  }

  // Derive la liste finale des nœuds à partir des paires
  const nodes = useMemo(() => {
    // 1) Liste brute des paires retenues
    const list = Object.values(tokenPairs);
    // 2) Filtre Solana + min liquidité
    const filtered = list.filter(p => (p.chainId || "").toLowerCase() === "solana" && +((p.liquidity||{}).usd || 0) >= minLiq);

    // 3) Prépare des échelles de normalisation pour volume et txns (dépendantes du timeframe)
    const vols = filtered.map(p => pick(p.volume, timeframe === "m5" ? "m5" : timeframe, 0));
    const volScale = d3.scaleLinear().domain([d3.min(vols) || 0, d3.max(vols) || 1]).range([0, 1]).clamp(true);
    const txns = filtered.map(p => (p.txns?.[timeframe]?.buys || 0) + (p.txns?.[timeframe]?.sells || 0));
    const txnScale = d3.scaleLinear().domain([d3.min(txns) || 0, d3.max(txns) || 1]).range([0, 1]).clamp(true);

    // 4) Boosts (on construit une map adresse -> score de boost)
    const boostMap = new Map(rawBoosts.map(b => [b.tokenAddress, (b.totalAmount ?? b.amount ?? b.score ?? 0)]));
    const boostsVals = filtered.map(p => boostMap.get(p.baseToken?.address) || 0);
    const boostScale = d3.scaleLinear().domain([d3.min(boostsVals) || 0, d3.max(boostsVals) || 1]).range([0, 1]).clamp(true);

    // 5) On assemble les infos nécessaires par nœud + calcul du score "hype"
    const out = filtered.map(p => {
      const addr = p.baseToken?.address;
      const priceChg = pick(p.priceChange, timeframe, 0); // variation %
      const vol = pick(p.volume, timeframe === "m5" ? "m5" : timeframe, 0);
      const txn = (p.txns?.[timeframe]?.buys || 0) + (p.txns?.[timeframe]?.sells || 0);
      const boost = boostMap.get(addr) || 0;

      // Normalisations :
      // - nPrice : on borne grossièrement [-50%, +50%] ⇒ [0..1] pour éviter l'explosion
      // - nVol, nTxn, nBoost : via les scales ci-dessus
      const nPrice = d3.scaleLinear().domain([-50, 50]).range([0, 1]).clamp(true)(priceChg);
      const nVol = volScale(vol);
      const nTxn = txnScale(txn);
      const nBoost = boostScale(boost);

      // Score hype pondéré
      const hype = (
        nPrice * weights.price +
        nVol   * weights.volume +
        nTxn   * weights.txns +
        nBoost * weights.boost
      );

      // Métadonnées d'affichage
      const icon = profiles[addr]?.icon || p.info?.imageUrl || "";
      const name = p.baseToken?.name || "?";
      const symbol = p.baseToken?.symbol || "?";
      const url = p.url; // lien DexScreener
      const liquidity = +((p.liquidity || {}).usd || 0);
      const priceUsd = +(p.priceUsd || 0);
      // Market cap: DexScreener expose souvent fdv (fully diluted). On prend fdv puis marketCap si dispo.
      const mc = +(p.fdv ?? p.marketCap ?? 0);

      return { id: addr, name, symbol, url, icon, hype, priceChg, vol, txn, boost, liquidity, priceUsd, mc };
    });

    // 6) Filtre texte + tri par hype (desc) et coupe par limite
    const q = query.trim().toLowerCase();
    const filt = q ? out.filter(n => n.symbol?.toLowerCase().includes(q) || n.name?.toLowerCase().includes(q)) : out;
    return filt.sort((a, b) => b.hype - a.hype).slice(0, limit);
  }, [tokenPairs, profiles, rawBoosts, timeframe, weights, minLiq, query, limit]);

  // ------------------ Layout de forces + Zoom/Pan ------------------
  // Dimensions réactives du SVG (responsive)
  const [dims, setDims] = useState({ w: 1200, h: 700 });
  useEffect(() => {
    function onResize() {
      const el = svgRef.current?.parentElement;
      if (!el) return;
      // hauteur approximative pour une bonne densité
      setDims({ w: el.clientWidth - 2, h: Math.max(420, Math.floor(el.clientWidth * 0.5)) });
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Échelle couleur : rouge → neutre → vert selon % de variation
  const color = d3.scaleLinear().domain([-20, 0, 20]).range(["#cc2442", "#8a97b2", "#14F195"]).clamp(true);

  useEffect(() => {
    // Sélection D3 du SVG et purge (on redessine à chaque dépendance majeure)
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    const { w, h } = dims;

    // Rayon des bulles = racine(hype) (évite les bulles disproportionnées)
    const r = d3.scaleSqrt()
      .domain([0, d3.max(nodes.map(n => n.hype)) || 1])
      .range([16, Math.min(100, Math.max(32, Math.min(w, h) / 7))]);

    // ---------- Décor/defs ----------
    const defs = svg.append("defs");
    // Dégradé de fond discret pour l'ambiance Solana
    const gradBG = defs.append("radialGradient").attr("id", "bg").attr("cx", "50%").attr("cy", "0%");
    gradBG.append("stop").attr("offset", "0%" ).attr("stop-color", "#9945FF").attr("stop-opacity", 0.18);
    gradBG.append("stop").attr("offset", "100%" ).attr("stop-color", "#00FFA3").attr("stop-opacity", 0.06);

    // Fond
    svg.append("rect").attr("x",0).attr("y",0).attr("width",w).attr("height",h).attr("fill","url(#bg)").attr("rx",12);

    // Groupe racine qui sera transformé par le zoom/pan
    const g = svg.append("g");

    // ---------- Tooltip HTML (flottant) ----------
    // On crée un élément HTML (div) pour le tooltip au-dessus du SVG
    const tooltip = d3
      .select("body")
      .append("div")
      .attr("class", "pointer-events-none fixed z-50 p-3 rounded-xl text-sm bg-[#0f1117]/90 border border-white/10 shadow-xl hidden text-white");

    function showTooltip(event, d){
      const { pageX, pageY } = event;
      tooltip
        .html(`
          <div class='font-semibold mb-1'>${d.symbol} · <span class='text-white/70'>${d.name}</span></div>
          <div class='grid grid-cols-2 gap-x-6 gap-y-1 text-white/80'>
            <div>Prix</div><div class='text-right'>$${d.priceUsd.toFixed(6)}</div>
            <div>Chg ${timeframe}</div><div class='text-right' style='color:${color(d.priceChg)}'>${d.priceChg?.toFixed?.(2) ?? "0.00"}%</div>
            <div>Vol ${timeframe}</div><div class='text-right'>$${d3.format(",.0f")(d.vol)}</div>
            <div>Txns ${timeframe}</div><div class='text-right'>${d.txn}</div>
            <div>Boost</div><div class='text-right'>${d.boost || 0}</div>
            <div>Liquidité</div><div class='text-right'>$${d3.format(",.0f")(d.liquidity)}</div>
          </div>
        `)
        .style("left", `${pageX + 16}px`)
        .style("top", `${pageY + 16}px`)
        .classed("hidden", false);
    }
    function hideTooltip(){ tooltip.classed("hidden", true).remove(); }

    // ---------- Zoom/Pan ----------
    // Le zoom modifie une transform appliquée au groupe g (et pas au SVG
    // lui-même), ce qui conserve le fond statique et simplifie le reset.
    const zoomBehavior = d3
      .zoom()
      .scaleExtent([0.5, 6]) // bornes du zoom
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      });
    svg.call(zoomBehavior);
    // On stocke pour les boutons +/−/reset
    zoomRef.current = { svg, zoomBehavior };

    // ---------- Layout de forces ----------
    // La simulation gère le placement non-chevauchant des bulles (forceCollide)
    const sim = d3
      .forceSimulation(nodes)
      .force("charge", d3.forceManyBody().strength(2))
      .force("collide", d3.forceCollide().radius(d => r(d.hype) + 2))
      .force("x", d3.forceX(w / 2).strength(0.05))
      .force("y", d3.forceY(h / 2).strength(0.05))
      .alpha(1)
      .alphaDecay(0.03); // décroissance pour stabiliser progressivement

    // Sélection jointe pour créer/mettre à jour les groupes "node"
    const node = g
      .selectAll("g.node")
      .data(nodes, d => d.id)
      .join(enter => {
        const wrap = enter
          .append("g")
          .attr("class", "node cursor-pointer")
          .call(drag(sim)); // drag = forces + positions fixes temporaires

        // --- Cercle principal de la bulle ---
        wrap
          .append("circle")
          .attr("r", d => r(d.hype))
          .attr("fill", d => `url(#grad-${d.id})`) // gradient unique par nœud
          .attr("stroke", "#0d1626")
          .attr("stroke-width", 1.5)
          .on("mousemove", (e, d) => showTooltip(e, d))
          .on("mouseout", hideTooltip)
          .on("click", (_, d) => setSelected(d)); // clic => pop-up

        // --- Dégradé radial par nœud (défini dans <defs>) ---
        wrap.each(function(d){
          const gId = `grad-${d.id}`;
          // Important : ne pas dupliquer un même id
          if (!document.getElementById(gId)) {
            const grad = defs.append("radialGradient").attr("id", gId);
            grad.append("stop").attr("offset","0%" ).attr("stop-color","#14F195").attr("stop-opacity",0.9);
            grad.append("stop").attr("offset","100%" ).attr("stop-color","#9945FF").attr("stop-opacity",0.6);
          }
        });

        // --- Pastille logo à l'intérieur de la bulle ---
        // On dessine une petite pastille en haut de la bulle, et on clip l'image dans un cercle.
        wrap.each(function(d){
          if(!d.icon) return; // certains tokens n'ont pas d'icône
          const R = r(d.hype);
          const size = Math.max(16, Math.min(28, R * 0.42));
          const y = - (R - (size/2 + 6)); // position interne proche du bord supérieur
          const clipId = `clip-${d.id}`;
          // Le clipPath est créé en unités objectBoundingBox pour plus de compatibilité
          if (!document.getElementById(clipId)) {
            const cp = defs.append("clipPath").attr("id", clipId).attr("clipPathUnits","objectBoundingBox");
            cp.append("circle").attr("cx", 0.5).attr("cy", 0.5).attr("r", 0.5);
          }
          // Petit fond sombre et bord Solana-style
          d3.select(this)
            .append("circle")
            .attr("cx", 0)
            .attr("cy", y)
            .attr("r", size/2 + 2)
            .attr("fill", "#0b0f14")
            .attr("stroke", "#14F195")
            .attr("stroke-width", 1)
            .attr("opacity", 1);
          // Image logo (href + xlink:href pour couvrir plus d'UA)
          d3.select(this)
            .append("image")
            .attr("href", d.icon)
            .attr("xlink:href", d.icon)
            .attr("x", -size/2)
            .attr("y", y - size/2)
            .attr("width", size)
            .attr("height", size)
            .attr("clip-path", `url(#${clipId})`)
            .attr("opacity", 1);
        });

        // --- Texte du symbole (centre de la bulle) ---
        wrap
          .append("text")
          .attr("text-anchor", "middle")
          .attr("y", 6)
          .attr("class", "select-none pointer-events-none font-semibold")
          .style("font-size", d => `${Math.max(10, Math.min(16, r(d.hype) / 2.6))}px`)
          .text(d => d.symbol);

        // --- Pourcentage sous le symbole ---
        wrap
          .append("text")
          .attr("text-anchor", "middle")
          .attr("y", d => Math.min(r(d.hype) * 0.6, r(d.hype) - 6))
          .attr("class", "select-none pointer-events-none")
          .style("font-weight", 700)
          .style("font-size", d => `${Math.max(9, r(d.hype) / 3.2)}px`)
          .style("fill", d => color(d.priceChg))
          .text(d => `${(isFinite(d.priceChg) ? d.priceChg.toFixed(2) : 0)}%`);

        return wrap;
      });

    // La simulation met à jour les positions (x,y) puis on applique via transform
    sim.on("tick", () => {
      node.attr("transform", d => `translate(${d.x || w/2},${d.y || h/2})`);
    });

    // Drag handler : fige la position pendant le drag, puis relâche après
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

    // Cleanup : on stoppe la simulation (sinon boucle CPU) et on retire le tooltip
    return () => { sim.stop(); hideTooltip(); };
  }, [nodes, dims, timeframe]);

  // ------------------ Contrôles de zoom (boutons) ------------------
  const zoomIn = () => {
    const z = zoomRef.current; if (!z) return;
    z.svg.transition().duration(200).call(z.zoomBehavior.scaleBy, 1.25);
  };
  const zoomOut = () => {
    const z = zoomRef.current; if (!z) return;
    z.svg.transition().duration(200).call(z.zoomBehavior.scaleBy, 0.8);
  };
  const resetZoom = () => {
    const z = zoomRef.current; if (!z) return;
    z.svg.transition().duration(200).call(z.zoomBehavior.transform, d3.zoomIdentity);
  };

  // ------------------ Helpers UI ------------------
  // Raccourci visuel du CA (ex: 4 chars + … + 4 chars)
  const short = (a) => (a ? `${a.slice(0,4)}…${a.slice(-4)}` : "");

  // Copier dans le presse-papiers avec feedback simple
  function handleCopy(id){
    try {
      navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(()=> setCopiedId(null), 1200);
    } catch {}
  }

// Nettoie et convertit en nombre (gère "$", virgules, strings, bigint…)
const toNum = (v) => {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-eE]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const getMC = (n) => {
  const candidates = [
    n?.mcapUsd, n?.mcap, n?.marketCapUsd, n?.marketCap,
    n?.fdvUsd, n?.fdv,
    n?.token?.mcapUsd, n?.token?.marketCapUsd, n?.token?.fdvUsd,
    n?.metrics?.marketCapUsd, n?.metrics?.fdvUsd
  ];
  for (const v of candidates) {
    const num = toNum(v);
    if (num != null) return num;
  }
  // fallback : prix * supply si dispo
  if (n?.priceUsd && n?.circulatingSupply) {
    const p = toNum(n.priceUsd), s = toNum(n.circulatingSupply);
    if (p != null && s != null) {
      const num = p * s;
      return Number.isFinite(num) ? num : null;
    }
  }
  return null;
};

const formatUSD0 = (v) => (v == null ? "—" : `$${d3.format(",.0f")(v)}`);

  
  // ------------------ Render ------------------
  return (
    <div className="min-h-screen w-full bg-[#090a0f] text-white">
      {/* Barre supérieure sticky avec bouton de refresh */}
      <header className="sticky top-0 z-20 backdrop-blur bg-[#0a0b10]/70 border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl md:text-2xl font-extrabold tracking-tight">
            <span className="bg-gradient-to-r from-[#9945FF] via-[#14F195] to-[#00FFA3] bg-clip-text text-transparent">Trench Dashboard</span>
          </h1>
          <button onClick={load} className="rounded-xl px-4 py-2 bg-[#141a26] border border-white/10 hover:border-white/20">
            {loading ? "Chargement…" : "Rafraîchir"}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Panneau de contrôle (filtres/poids) */}
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
                <input type="number" className="w-full mt-1 bg-[#0b0f14] border border-white/10 rounded-lg p-2" value={limit} onChange={e=>setLimit(Math.max(5, Math.min(100, +e.target.value || 20)))} />
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
            <div className="text-xs text-white/60 mt-2">Astuce: le boost (DexScreener) mesure la mise en avant sur la plateforme et reflète souvent le buzz court terme.</div>
          </div>

       

          {error && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-200">{error}</div>}
        </section>

        {/* Bubble chart */}
        <section className="lg:col-span-8 p-2 rounded-2xl border border-white/10 bg-[#0f1117]/60">
          <div className="relative">
            {/* Le SVG principal ; le groupe <g> interne est déplacé par le zoom */}
            <svg ref={svgRef} width={dims.w} height={dims.h} />
            {/* Contrôles de zoom flottants */}
            <div className="absolute right-3 top-3 flex flex-col gap-2">
              <button onClick={zoomIn} className="w-9 h-9 rounded-lg bg-[#0b0f14]/80 border border-white/10 hover:border-white/30">+
              </button>
              <button onClick={zoomOut} className="w-9 h-9 rounded-lg bg-[#0b0f14]/80 border border-white/10 hover:border-white/30">−
              </button>
              <button onClick={resetZoom} className="w-9 h-9 text-xs rounded-lg bg-[#0b0f14]/80 border border-white/10 hover:border-white/30">100%
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between px-2 pb-2 text-xs text-white/60">
            <div>{nodes.length} tokens · timeframe {timeframe}</div>
            <div>Zoom: molette/pinch · Drag: déplacer · Clic: pop-up d'infos</div>
          </div>
        </section>

        {/* Liste Top par hype (cartes) */}
        <section className="lg:col-span-12 p-4 rounded-2xl border border-white/10 bg-[#0f1117]/60">
          <div className="text-sm text-white/70 mb-2">Top par hype</div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {nodes.slice(0, 24).map(n => (
              <a key={n.id} href={n.url} target="_blank" className="group rounded-xl border border-white/10 p-3 hover:border-white/30 bg-[#0b0f14]">
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

                  
                  <div>Chg {timeframe}</div><div className="text-right" style={{color: color(n.priceChg)}}>{n.priceChg?.toFixed?.(2) ?? "0.00"}%</div>
                  <div>MC</div><div className="text-right">{formatUSD0(getMC(n))}</div>
                  <div>Vol {timeframe}</div><div className="text-right">${d3.format(",.0f")(n.vol)}</div>
                  <div>LiQ</div><div className="text-right">${d3.format(",.0f")(n.liquidity)}</div>
                  <div>Boost</div><div className="text-right">{n.boost || 0}</div>
                </div>
                {/* CA copiable + lien Solscan ; on stopPropagation pour ne pas ouvrir Dex en même temps */}
                <div className="mt-2 flex items-center justify-between text-xs">
                  <a href={`https://solscan.io/token/${n.id}`} target="_blank" rel="noopener" onClick={(e)=> e.stopPropagation()} className="text-blue-300 hover:underline">{short(n.id)}</a>
                  <button
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-white/10 hover:border-white/30"
                    onClick={(e)=>{ e.preventDefault(); e.stopPropagation(); handleCopy(n.id); }}
                    title="Copier le CA"
                  >
                    <CopyIcon className="w-3 h-3" /> {copiedId===n.id ? "Copié" : "Copy"}
                  </button>
                </div>
              </a>
            ))}
          </div>
        </section>
      </main>

      {/* ------- Pop-up d'infos détaillées ------- */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={()=>setSelected(null)}>
          {/* stopPropagation pour éviter de fermer si on clique à l'intérieur */}
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1117]" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center gap-3 p-4 border-b border-white/10">
              <div className="w-8 h-8 rounded-full overflow-hidden border border-white/10">
                {selected.icon ? <img src={selected.icon} alt="" className="w-full h-full object-cover"/> : <div className="w-full h-full bg-gradient-to-br from-[#14F195] to-[#9945FF]"/>}
              </div>
              <div className="font-bold">{selected.symbol}</div>
              <div className="text-xs text-white/60 truncate">{selected.name}</div>
              <button className="ml-auto p-1 rounded hover:bg-white/10" onClick={()=>setSelected(null)} aria-label="Fermer">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="p-4 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">MC<br/><span className="font-semibold">{selected.mc ? `$${d3.format(",.0f")(selected.mc)}` : "—"}</span></div>
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">Chg {timeframe}<br/><span className="font-semibold" style={{color: color(selected.priceChg)}}>{selected.priceChg?.toFixed?.(2) ?? 0}%</span></div>
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">Liquidité<br/><span className="font-semibold">${d3.format(",.0f")(selected.liquidity)}</span></div>
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">Vol {timeframe}<br/><span className="font-semibold">${d3.format(",.0f")(selected.vol)}</span></div>
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">Holders<br/><span className="font-semibold">{holdersMap[selected.id] != null ? d3.format(",.0f")(holdersMap[selected.id]) : (birdeyeKey ? "…" : "—")}</span></div>
              <div className="rounded-xl border border-white/10 bg-[#0b0f14] p-3">Prix<br/><span className="font-semibold">{`$${selected.priceUsd?.toFixed?.(6) ?? "0.000000"}`}</span></div>
            </div>
            <div className="p-4 border-t border-white/10 flex items-center justify-between text-xs">
              <a href={`https://solscan.io/token/${selected.id}`} target="_blank" rel="noopener" className="text-blue-300 hover:underline">{short(selected.id)}</a>
              <div className="flex items-center gap-2">
                <button className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-white/10 hover:border-white/30" onClick={()=>handleCopy(selected.id)}>
                  <CopyIcon className="w-3 h-3"/> {copiedId===selected.id?"Copié":"Copy CA"}
                </button>
                <a className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-white/10 hover:border-white/30" href={selected.url} target="_blank" rel="noopener">DexScreener</a>
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="max-w-7xl mx-auto px-4 py-8 text-center text-xs text-white/40">
        Données: DexScreener (API publique). Birdeye optionnel. Ceci n'est pas un conseil financier.
      </footer>
    </div>
  );
}

// --------- Composants utilitaires ---------
function Slider({ label, value, onChange }) {
  return (
    <div className="grid grid-cols-[90px_1fr_60px] items-center gap-2 py-1">
      <div className="text-sm text-white/80">{label}</div>
      {/* input range natif ; accent pour la couleur du curseur */}
      <input type="range" min={0} max={1} step={0.05} value={value} onChange={e=>onChange(+e.target.value)} className="w-full accent-[#14F195]" />
      <div className="text-right text-xs text-white/70">{value.toFixed(2)}</div>
    </div>
  );
}

function CopyIcon({ className }){
  // Petite icône "copy" en SVG (compatible tailwind classes)
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="9" y="9" width="13" height="13" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  );
}
