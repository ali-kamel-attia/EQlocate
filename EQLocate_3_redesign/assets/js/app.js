/* ---------- Application (DOM, canvas, map) ---------- */
const C = LocCore;
const APP_VERSION = "3.0.0";      // interface 3.0; numerical core unchanged from 2.7.1

/* ---------- Theme palette for canvases and map symbols (read from the CSS custom properties) ---------- */
const TH = {};
function refreshTheme(){
  const cs = getComputedStyle(document.documentElement), v = k => cs.getPropertyValue(k).trim();
  Object.assign(TH, {ink:v("--ink"), ink2:v("--ink-2"), ink3:v("--ink-3"), plot:v("--plot"), trace:v("--trace"), grid:v("--grid"), axis:v("--axis"),
    hair:v("--hair"), p:v("--p"), s:v("--s"), chord:v("--chord"), joint:v("--joint"), post:v("--post"), ref:v("--ref"), sheet:v("--sheet"),
    land:v("--land"), sea:v("--sea"), coast:v("--coast"), border:v("--border-line"), graticule:v("--graticule"),
    sans:'Archivo, "EQ Greek Sans", system-ui, sans-serif', mono:'"Plex Mono", "EQ Greek Mono", ui-monospace, monospace'});
  TH.alpha = (c, a) => { const m = /^#?([0-9a-f]{6})$/i.exec(c); if(!m) return c; const n = parseInt(m[1], 16); return `rgba(${n>>16},${(n>>8)&255},${n&255},${a})`; };
}
refreshTheme();

/* ---------- HiDPI Canvas ---------- */
function setupHiDPICanvas(canvas, boxEl, maxDPR=3){
  const dpr = Math.min(window.devicePixelRatio || 1, maxDPR);
  const rect = boxEl.getBoundingClientRect();
  const titlebar = boxEl.querySelector(".titlebar");
  const titleH = titlebar ? titlebar.getBoundingClientRect().height : 0;
  const cssW = Math.max(10, rect.width);
  const cssH = Math.max(10, rect.height - titleH);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return {ctx, cssW, cssH, dpr};
}
function canvasEventToCssPx(ev, canvas){
  const r = canvas.getBoundingClientRect();
  return {x:(ev.clientX-r.left), y:(ev.clientY-r.top), rect:r};
}

/* ---------- Tick utilities ---------- */
function niceStep(raw){
  if(!(raw>0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  let n = 1;
  if(m >= 7.5) n = 10;
  else if(m >= 3.5) n = 5;
  else if(m >= 1.5) n = 2;
  return n * p;
}
function ticks(min, max, approxCount){
  if(!(max>min)) return [min];
  const step = niceStep((max - min) / Math.max(2, approxCount));
  const start = Math.ceil(min / step) * step;
  const out = [];
  for(let v = start; v <= max + 1e-12; v += step) out.push(v);
  return out;
}
function fmtTick(v){
  const av = Math.abs(v);
  if(av >= 1000) return v.toFixed(0);
  if(av >= 100) return v.toFixed(1);
  if(av >= 10) return v.toFixed(2);
  if(av >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

/* ---------- State + DOM ---------- */
const state = {
  stations:{},        // code -> {code, lat, lon, elev_m, comps:{name:trace}, comp, ref:{evla,evlo,evdp}}
  order:[],
  jointExcluded:new Set(),   // used stations not trusted for the joint inversion (section 7)
  kappaAuto:true,            // Vp/Vs taken from the Wadati fit (false once the user types a value)
  vpEst:null,                // automatic apparent-Vp estimate (section 5)
  picks:{},           // code -> {p, s} absolute epoch seconds, pSrc, sSrc
  use:{},             // code -> bool
  pickMode:"P",
  current:null,
  wadati:null,
  chord:null,
  joint:null,
  reference:null,
  view:{xmin:0,xmax:10,ymin:-1,ymax:1},
  base:{xmin:0,xmax:10},
  isDragging:false, dragStart:null, dragMoved:false,
  map:null, baseLayers:{}, activeBase:null,
  mapLayers:{stations:null, circles:null, chords:null, epicenter:null, joint:null, reference:null},
};
const $ = id => document.getElementById(id);
const els = new Proxy({}, {get:(_, k) => $(k)});

function hhmmss_msec_utc(epochSec){
  if(epochSec == null || !Number.isFinite(epochSec)) return "-";
  const d = new Date(Math.round(epochSec*1000));
  return d.toISOString().slice(11, 23);
}
function hhmmss_utc(epochSec){
  if(epochSec == null || !Number.isFinite(epochSec)) return "-";
  return new Date(Math.round(epochSec*1000)).toISOString().slice(11, 19);
}
function escapeHtml(s){
  if(s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
const num = (id, def) => { const v = Number($(id).value); return Number.isFinite(v) ? v : def; };
const fx = (v, d) => Number.isFinite(v) ? v.toFixed(d) : "-";

/* ---------- Station helpers ---------- */
function hasPS(code){ const p = state.picks[code]; return !!p && Number.isFinite(p.p) && Number.isFinite(p.s) && p.s > p.p; }
function hasAny(code){ const p = state.picks[code]; return !!p && (Number.isFinite(p.p) || Number.isFinite(p.s)) && !(Number.isFinite(p.p) && Number.isFinite(p.s) && p.s <= p.p); }
/* usable = ticked “Use”, has coordinates and at least one valid pick (Wadati and circle methods additionally need both) */
/* Two levels of usability (the original code required coordinates for both, so stations without STLA/STLO silently lost their picks):
   usable()   : ticked "Use" and at least one valid pick - enough for the Wadati regression and S-P analysis;
   usableLoc(): additionally has coordinates - required by every location method. */
function hasCoords(code){ const s = state.stations[code]; return !!s && Number.isFinite(s.lat) && Number.isFinite(s.lon); }
function usable(code){ return !!state.use[code] && hasAny(code); }
function usableLoc(code){ return usable(code) && hasCoords(code); }
function timingCodes(){ return state.order.filter(usable); }
function usedCodes(){ return state.order.filter(usableLoc); }
/* explains why a location method cannot start (never a silent failure) */
function locationBlocker(){
  const withPicks = timingCodes().filter(hasAny), noC = withPicks.filter(c => !hasCoords(c));
  if(!withPicks.length) return "No station has a valid, ticked pick.";
  if(noC.length) return `Station coordinates are missing for ${noC.join(", ")} (${noC.length} of ${withPicks.length} stations with picks; the SAC headers do not define STLA/STLO). `
    + "The picks are intact and the Wadati regression works; location methods need coordinates: use “Import station table” (CSV: code, lat, lon, elev_m) in section 1.";
  return "";
}
/* stations selected (trusted) for the joint inversion: used stations whose box in section 7 is ticked */
function jointCodes(){ return usedCodes().filter(c => !state.jointExcluded.has(c)); }
function chordCodes(){ return [...els.triChecks.querySelectorAll("input[type=checkbox]:checked")].map(cb => cb.dataset.code).filter(c => hasPS(c)); }


/* ---------- Map ---------- */
function mapOK(){ return typeof L !== "undefined"; }
function initMapIfNeeded(){
  if(state.map) return true;
  if(!mapOK()){
    els.map.innerHTML = '<div class="small" style="padding:14px">Map unavailable: the Leaflet library could not be loaded. All calculations still work.</div>';
    return false;
  }
  state.map = L.map("map", {preferCanvas:false, worldCopyJump:true, zoomControl:false}).setView([36.0,128.0],6);
  L.control.zoom({position:"topright"}).addTo(state.map);
  const esri = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {maxZoom:19, attribution:"Esri, Maxar, Earthstar Geographics"});
  const otm = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    {maxZoom:17, attribution:"OpenTopoMap (CC-BY-SA)"});
  state.baseLayers = {offline:offlineBasemap(), imagery:esri, topo:otm, gsat:null, ghyb:null};
  [esri, otm].forEach(watchTiles);
  for(const k of Object.keys(state.mapLayers)) state.mapLayers[k] = L.layerGroup().addTo(state.map);
  L.control.scale({imperial:false, metric:true, position:"bottomleft"}).addTo(state.map);
  state.map.on("mousemove", e => { els.coordBox.textContent = `lat=${e.latlng.lat.toFixed(5)} lon=${e.latlng.lng.toFixed(5)}`; });
  els.basemapSel.addEventListener("change", () => setBasemap(els.basemapSel.value));
  // satellite by default: Google when an API key is saved, otherwise Esri imagery; offline coastlines if tiles cannot load
  watchMapBox();
  els.basemapSel.value = googleKey() ? "gsat" : "imagery";
  setBasemap(els.basemapSel.value);
  return true;
}
/* ---------- Basemaps ---------- */
function showBase(key, layer){
  if(state.activeBase) state.map.removeLayer(state.activeBase);
  state.activeBaseKey = key; els.basemapSel.value = key;
  state.activeBase = layer.addTo(state.map);
  state.activeBase.bringToBack && state.activeBase.bringToBack();
  updateMapStations(false); drawReference();
}
async function setBasemap(key){
  if(!state.map) return;
  els.basemapSel.value = key;
  if(key === "gsat" || key === "ghyb"){
    const k = googleKey();
    if(!k){ alert("Google Satellite needs your own Google Maps Platform API key with the Map Tiles API enabled. Enter it under “Google Satellite key” below the map; Esri imagery is shown meanwhile."); showBase("imagery", state.baseLayers.imagery); return; }
    try{
      if(!state.baseLayers[key]) state.baseLayers[key] = await googleLayer(k, key === "ghyb");
      if(els.basemapSel.value !== key) return;            // the user picked another basemap while the session was created
      showBase(key, state.baseLayers[key]);
    }catch(e){
      alert("Google Satellite could not start: " + e.message + "\nShowing Esri imagery instead.");
      showBase("imagery", state.baseLayers.imagery);
    }
    return;
  }
  showBase(key, state.baseLayers[key] || state.baseLayers.offline);
}
/* online tiles that fail before any tile has loaded (offline, blocked, bad key) → offline coastlines */
function watchTiles(layer){
  let ok = 0, bad = 0;
  layer.on("tileload", () => { ok++; });
  layer.on("tileerror", () => {
    if(ok || ++bad < 6 || state.activeBase !== layer) return;
    bad = -1e9;
    alert("Online map tiles could not be loaded (no network, blocked host or invalid key). Switched to the offline coastline map.");
    showBase("offline", state.baseLayers.offline);
  });
  layer.on("add", () => { ok = 0; bad = Math.max(bad, 0); });
}
const GKEY = "eqlocate-google-maps-key";
function googleKey(){ try{ return localStorage.getItem(GKEY) || ""; }catch(e){ return ""; } }
function setGoogleKey(k){
  try{ if(k) localStorage.setItem(GKEY, k); else localStorage.removeItem(GKEY); }catch(e){}
  for(const key of ["gsat", "ghyb"]){ if(state.baseLayers[key] && state.map && state.activeBase === state.baseLayers[key]) state.map.removeLayer(state.baseLayers[key]); state.baseLayers[key] = null; }
}
/* Google satellite imagery through the official Map Tiles API (2D tiles). The key is the user's own; it is stored only in
   this browser and sent only to tile.googleapis.com. A session token (valid about two weeks) is created per map type. */
async function googleLayer(key, labels){
  const body = {mapType:"satellite", language:navigator.language || "en-US", region:"US"};
  if(labels) body.layerTypes = ["layerRoadmap"];
  const r = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
  const j = await r.json().catch(() => ({}));
  if(!r.ok || !j.session) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
  const base = "https://tile.googleapis.com/v1";
  const lyr = L.tileLayer(`${base}/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(j.session)}&key=${encodeURIComponent(key)}`,
    {maxZoom:22, maxNativeZoom:21, tileSize:256, attribution:'<b class="g-logo">Google</b>'});
  watchTiles(lyr);
  // Google requires the attribution of the imagery in view: read it from the viewport endpoint after each move
  let timer = null, last = "";
  const upd = () => { clearTimeout(timer); timer = setTimeout(async () => {
    if(!state.map.hasLayer(lyr)) return;
    const b = state.map.getBounds(), q = `session=${encodeURIComponent(j.session)}&key=${encodeURIComponent(key)}&zoom=${state.map.getZoom()}`
      + `&north=${b.getNorth().toFixed(5)}&south=${b.getSouth().toFixed(5)}&east=${b.getEast().toFixed(5)}&west=${b.getWest().toFixed(5)}`;
    try{
      const v = await (await fetch(`https://tile.googleapis.com/tile/v1/viewport?${q}`)).json();
      const txt = '<b class="g-logo">Google</b> ' + escapeHtml(v.copyright || "");
      if(txt !== last){ state.map.attributionControl.removeAttribution(lyr.options.attribution); lyr.options.attribution = txt; state.map.attributionControl.addAttribution(txt); last = txt; }
    }catch(e){}
  }, 400); };
  lyr.on("add", () => { state.map.on("moveend", upd); upd(); });
  lyr.on("remove", () => state.map.off("moveend", upd));
  return lyr;
}
/* Offline basemap: Natural Earth 1:50m land and borders (assets/data/world50m.js) plus a zoom-dependent graticule.
   No tiles, no network: the map works from a USB stick or file://. */
function offlineBasemap(){
  const g = L.layerGroup(), rend = L.svg({padding:0.5});
  const W = window.EQ_WORLD;
  const dec = a => { const out = []; let x = 0, y = 0; for(let i=0;i<a.length;i+=2){ x += a[i]; y += a[i+1]; out.push([y/100, x/100]); } return out; };
  let landLayer = null, bordLayer = null;
  if(W){
    landLayer = L.polygon(W.land.map(dec), {renderer:rend, stroke:true, color:TH.coast, weight:0.8, fillColor:TH.land, fillOpacity:1, interactive:false, smoothFactor:1});
    bordLayer = L.polyline(W.borders.map(dec), {renderer:rend, color:TH.border, weight:0.7, dashArray:"3 2", interactive:false});
    g.addLayer(landLayer); g.addLayer(bordLayer);
  }
  const grat = L.layerGroup(); g.addLayer(grat);
  function drawGrat(){
    if(!state.map || !state.map.hasLayer(g)) return;
    grat.clearLayers();
    const b = state.map.getBounds().pad(0.1), sz = state.map.getSize();
    const want = (state.map.getBounds().getEast() - state.map.getBounds().getWest())/Math.max(2, sz.x/120);   // about one line per 120 px
    const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30].find(v => v >= want) || 30;
    const s0 = Math.max(-85, Math.floor(b.getSouth()/step)*step), n0 = Math.min(85, Math.ceil(b.getNorth()/step)*step);
    const w0 = Math.floor(b.getWest()/step)*step, e0 = Math.ceil(b.getEast()/step)*step;
    if((n0 - s0)/step > 80 || (e0 - w0)/step > 120) return;
    const st = {color:TH.graticule, weight:1, interactive:false, renderer:rend};
    const dp = step < 0.1 || step === 0.25 ? 2 : step < 1 ? 1 : 0;
    for(let la = s0; la <= n0 + 1e-9; la += step) grat.addLayer(L.polyline([[la, w0], [la, e0]], st));
    for(let lo = w0; lo <= e0 + 1e-9; lo += step) grat.addLayer(L.polyline([[s0, lo], [n0, lo]], st));
    const ll = state.map.getBounds();
    for(let la = s0; la <= n0 + 1e-9; la += step) if(la > ll.getSouth() && la < ll.getNorth())
      grat.addLayer(L.marker([la, ll.getWest()], {interactive:false, keyboard:false, icon:L.divIcon({className:"grat-label", html:`${Math.abs(la).toFixed(dp)}°${la >= 0 ? "N" : "S"}`, iconSize:null, iconAnchor:[-6, 13]})}));
    for(let lo = w0; lo <= e0 + 1e-9; lo += step) if(lo > ll.getWest() && lo < ll.getEast())
      grat.addLayer(L.marker([ll.getNorth(), lo], {interactive:false, keyboard:false, icon:L.divIcon({className:"grat-label", html:`${Math.abs(((lo + 540) % 360) - 180).toFixed(dp)}°${((lo + 540) % 360) - 180 >= 0 ? "E" : "W"}`, iconSize:null, iconAnchor:[-3, -4]})}));
  }
  g.on("add", () => { state.map.on("moveend zoomend", drawGrat); setTimeout(drawGrat, 0); state.map.getContainer().style.background = TH.sea; });
  g.on("remove", () => { state.map.off("moveend zoomend", drawGrat); grat.clearLayers(); state.map.getContainer().style.background = ""; });
  g.restyle = () => {
    if(landLayer) landLayer.setStyle({color:TH.coast, fillColor:TH.land});
    if(bordLayer) bordLayer.setStyle({color:TH.border});
    if(state.map && state.map.hasLayer(g)){ state.map.getContainer().style.background = TH.sea; drawGrat(); }
  };
  if(W) g.getAttribution = () => "Natural Earth (public domain)";
  return g;
}
/* fitBounds that survives a hidden map (inactive tab): the bounds are applied when the map becomes visible */
function fitMap(bounds){
  if(!state.map) return;
  const el = state.map.getContainer();
  if(el.offsetWidth === 0 || el.offsetHeight === 0){ state.pendingBounds = bounds; return; }
  state.pendingBounds = null; state.lastFit = bounds; state.userMoved = false;
  state.map.invalidateSize(false);                 // the map box may have just moved into another workspace
  state.map.fitBounds(bounds, {animate:false});    // instant: an animation can be cut short by a basemap switch or a resize
}
/* keep the map sized to its box; re-apply the last automatic fit unless the user has moved the map since */
function watchMapBox(){
  if(!state.map || !("ResizeObserver" in window)) return;
  const el = state.map.getContainer();
  ["mousedown", "wheel", "touchstart", "keydown"].forEach(ev => el.addEventListener(ev, () => { state.userMoved = true; }, {passive:true}));
  let t = null;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => {
    if(!el.offsetWidth) return;
    state.map.invalidateSize(false);
    if(state.pendingBounds) fitMap(state.pendingBounds);
    else if(state.lastFit && !state.userMoved) state.map.fitBounds(state.lastFit, {animate:false});
  }, 60); }).observe(el);
}
function dot(color, size){
  if(!mapOK()) return null;
  return L.divIcon({className:"", html:`<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1.5px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.35);"></div>`,
    iconSize:[size+4,size+4], iconAnchor:[(size+4)/2,(size+4)/2]});
}
function updateMapStations(fit){
  if(!initMapIfNeeded()) return;
  state.mapLayers.stations.clearLayers();
  const pts = [];
  for(const code of state.order){
    const s = state.stations[code];
    if(!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    pts.push([s.lat, s.lon]);
    const color = usableLoc(code) ? (state.activeBaseKey === "offline" ? TH.ink : "#ffffff") : "rgba(140,140,140,.75)", lab = state.activeBaseKey === "offline" ? TH.ink : "#fff", halo = state.activeBaseKey === "offline" ? TH.sea : "#000";
    const icon = L.divIcon({className:"", html:`<div style="display:flex;align-items:center;gap:3px"><div style="width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:12px solid ${color};filter:drop-shadow(0 0 1px ${halo})"></div><span style="font:600 11px ${TH.mono};color:${lab};text-shadow:0 0 3px ${halo},0 0 2px ${halo}">${escapeHtml(code)}</span></div>`,
      iconSize:[60,14], iconAnchor:[7,8]});
    L.marker([s.lat, s.lon], {icon}).addTo(state.mapLayers.stations)
      .bindPopup(`<b>${escapeHtml(code)}</b><br/>lat=${s.lat.toFixed(4)} lon=${s.lon.toFixed(4)}<br/>elev=${fx(s.elev_m,0)} m`);
  }
  if(fit && pts.length) fitMap(L.latLngBounds(pts).pad(0.2));
}
function drawReference(){
  if(!initMapIfNeeded()) return;
  state.mapLayers.reference.clearLayers();
  const r = state.reference;
  if(!r) return;
  const icon = L.divIcon({className:"", html:`<div style="font:700 22px system-ui;color:${TH.ref};text-shadow:0 0 3px #fff,0 0 2px #fff;line-height:20px">×</div>`, iconSize:[20,20], iconAnchor:[6,11]});
  L.marker([r.lat, r.lon], {icon}).addTo(state.mapLayers.reference)
    .bindPopup(`<b>SAC-header reference</b><br/>lat=${r.lat.toFixed(4)} lon=${r.lon.toFixed(4)}<br/>depth=${fx(r.depth,2)} km`);
}
function xyLL(p, c0){ const ll = C.xyToLatLon(p.x, p.y, c0.lat, c0.lon); return [ll.lat, ll.lon]; }

/* ---------- UI lists ---------- */
function setPickMode(m){ state.pickMode = m; els.pickMode.textContent = m; }
function renderStationList(){
  els.stationList.innerHTML = "";
  state.order.forEach(code => {
    const s = state.stations[code];
    const div = document.createElement("div");
    div.className = "list-item" + (state.current === code ? " active" : "");
    div.innerHTML = `<span>${escapeHtml(code)} <span class="tag">${escapeHtml(Object.keys(s.comps).join(" "))}</span></span>`
      + `<span class="tag">${fx(s.lat,3)}, ${fx(s.lon,3)}</span>`;
    div.onclick = () => { selectStation(code); };
    els.stationList.appendChild(div);
  });
}
function selectStation(code){
  state.current = code;
  renderCompSel(); resetViewToCurrent(); renderStationList(); drawWave();
}
function renderCompSel(){
  els.compSel.innerHTML = "";
  const s = state.current ? state.stations[state.current] : null;
  if(!s) return;
  for(const c of Object.keys(s.comps)){
    const o = document.createElement("option"); o.value = c; o.textContent = c || "(none)"; if(c === s.comp) o.selected = true;
    els.compSel.appendChild(o);
  }
}
function renderPicks(){
  els.picksTable.innerHTML = "";
  const wFlags = state.wadati?.flagged || {};
  state.order.forEach(code => {
    const pk = state.picks[code] || {};
    const tr = document.createElement("tr");
    const dt = hasPS(code) ? (pk.s - pk.p).toFixed(3) : "-";
    const src = [pk.pSrc, pk.sSrc].filter(Boolean).join("/") || "-";
    tr.innerHTML = `<td><input type="checkbox" data-code="${escapeHtml(code)}" ${state.use[code] ? "checked" : ""}/></td>`
      + `<td class="mono${wFlags[code] ? " warn" : ""}">${escapeHtml(code)}${wFlags[code] ? " ⚠" : ""}</td>`
      + `<td class="mono">${hhmmss_msec_utc(pk.p)}</td><td class="mono">${hhmmss_msec_utc(pk.s)}</td>`
      + `<td class="mono">${dt}</td><td class="tag">${escapeHtml(src)}</td>`;
    tr.querySelector("input").onchange = ev => { state.use[code] = ev.target.checked; updateMapStations(false); renderJointChecks(); };
    els.picksTable.appendChild(tr);
  });
}
function renderTriChecks(){
  const prev = new Set(chordCodes());
  els.triChecks.innerHTML = "";
  state.order.forEach(code => {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.dataset.code = code; cb.checked = prev.has(code);
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(code));
    els.triChecks.appendChild(lab);
  });
}

function renderJointChecks(){
  els.jointChecks.innerHTML = "";
  state.order.forEach(code => {
    const pk = state.picks[code], ok = usableLoc(code);
    const lab = document.createElement("label"), cb = document.createElement("input");
    cb.type = "checkbox"; cb.dataset.code = code; cb.checked = ok && !state.jointExcluded.has(code); cb.disabled = !ok;
    cb.onchange = () => { if(cb.checked) state.jointExcluded.delete(code); else state.jointExcluded.add(code); updateJointSel(); };
    const tag = (Number.isFinite(pk.p) ? "P" : "") + (Number.isFinite(pk.s) ? "S" : "");
    lab.title = ok ? `${code}: picks ${tag || "none"}` : `${code}: ${hasCoords(code) ? "not used in section 3 or no picks" : "no station coordinates (import a station table)"}`;
    if(!ok) lab.style.opacity = 0.45;
    lab.appendChild(cb); lab.appendChild(document.createTextNode(`${code}${tag ? " (" + tag + ")" : ""}`));
    els.jointChecks.appendChild(lab);
  });
  updateJointSel();
}
function updateJointSel(){
  const used = usedCodes(), sel = jointCodes(), off = used.filter(c => state.jointExcluded.has(c));
  els.jointSelOut.textContent = used.length ? `${sel.length} of ${used.length} used stations selected` + (off.length ? ` (excluded: ${off.join(", ")})` : "") : "-";
}
function setAllJoint(on){ state.jointExcluded = new Set(on ? [] : usedCodes()); renderJointChecks(); }

/* ---------- Plot axes ---------- */
function plotArea(w,h){ return {L:70, R:20, T:24, B:54, w, h, x0:70, y0:24, pw:(w-70-20), ph:(h-24-54)}; }
function drawAxesWithTicks(ctx, area, xmin, xmax, ymin, ymax, xTitle, yTitle, xTickFormatter, yTickFormatter){
  const {x0,y0,pw,ph,h,B} = area;
  const x1 = x0+pw, y1 = y0+ph;
  ctx.fillStyle = TH.plot;
  ctx.fillRect(x0,y0,pw,ph);
  const xt = ticks(xmin, xmax, Math.max(2, Math.min(6, Math.floor(pw/(xTickFormatter ? 105 : 70))))), yt = ticks(ymin, ymax, Math.max(2, Math.min(5, Math.floor(ph/45))));
  const dec = t => t.length > 1 ? Math.max(0, Math.min(4, -Math.floor(Math.log10(t[1]-t[0] + 1e-12) + 1e-9))) : 2;
  const dx = dec(xt), dy = dec(yt);
  xTickFormatter = xTickFormatter || (v => v.toFixed(dx)); yTickFormatter = yTickFormatter || (v => v.toFixed(dy));
  ctx.strokeStyle = TH.grid; ctx.lineWidth = 1;
  for(const xv of xt){ const px = x0 + (xv-xmin)/(xmax-xmin)*pw; ctx.beginPath(); ctx.moveTo(px,y0); ctx.lineTo(px,y1); ctx.stroke(); }
  for(const yv of yt){ const py = y1 - (yv-ymin)/(ymax-ymin)*ph; ctx.beginPath(); ctx.moveTo(x0,py); ctx.lineTo(x1,py); ctx.stroke(); }
  ctx.strokeStyle = TH.axis; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x0,y1); ctx.lineTo(x1,y1); ctx.stroke();
  ctx.fillStyle = TH.ink2; ctx.font = `11px ${TH.mono}`; ctx.textBaseline = "middle";
  for(const yv of yt){
    const py = y1 - (yv-ymin)/(ymax-ymin)*ph;
    ctx.beginPath(); ctx.moveTo(x0-6,py); ctx.lineTo(x0,py); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(yTickFormatter ? yTickFormatter(yv) : fmtTick(yv), x0-10, py);
  }
  ctx.textBaseline = "top";
  for(const xv of xt){
    const px = x0 + (xv-xmin)/(xmax-xmin)*pw;
    ctx.beginPath(); ctx.moveTo(px,y1); ctx.lineTo(px,y1+6); ctx.stroke();
    ctx.textAlign = "center"; ctx.fillText(xTickFormatter ? xTickFormatter(xv) : fmtTick(xv), px, y1+10);
  }
  ctx.fillStyle = TH.ink2; ctx.font = `600 11.5px ${TH.sans}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillText(xTitle, x0+pw/2, h-B+28);
  ctx.save(); ctx.translate(18, y0+ph/2); ctx.rotate(-Math.PI/2); ctx.fillText(yTitle, 0, 0); ctx.restore();
}

/* ---------- Waveform canvas (all components of the selected station, synchronized) ---------- */
let waveCtxInfo = null;
function getWaveCtx(){ if(!waveCtxInfo) waveCtxInfo = setupHiDPICanvas(els.waveCanvas, els.waveBox); return waveCtxInfo; }
const COMP_ORDER = c => /Z$/i.test(c) ? 0 : /[N1]$/i.test(c) ? 1 : /[E2]$/i.test(c) ? 2 : 3;
function stationTraces(){
  const s = state.current ? state.stations[state.current] : null;
  if(!s) return [];
  const comps = Object.keys(s.comps).sort((a,b) => COMP_ORDER(a) - COMP_ORDER(b) || a.localeCompare(b));
  const shown = els.showAllComp.checked ? comps : [s.comp];
  return shown.map(c => ({comp:c, tr:s.comps[c]}));
}
function stationT0(){        // common time origin of the station's traces (earliest start)
  const t = stationTraces().map(o => o.tr.start_epoch);
  return t.length ? Math.min(...t) : 0;
}
function filterKey(){ return `${els.filterSel.value}|${els.fminIn.value}|${els.fmaxIn.value}|${els.polesSel.value}`; }
function displayData(tr){
  const key = filterKey();
  if(tr._dispKey !== key){
    let y = tr.data;
    const type = els.filterSel.value;
    if(type !== "none") y = C.filterTrace(tr.data, tr.delta, type, num("fminIn", 0), num("fmaxIn", 0), Number(els.polesSel.value));
    let amp = 0; for(const v of y) if(Math.abs(v) > amp) amp = Math.abs(v);
    tr._disp = amp > 0 ? y.map(v => v/amp) : y.slice();
    tr._dispKey = key;
  }
  return tr._disp;
}
function resetViewToCurrent(){
  const trs = stationTraces(); if(!trs.length) return;
  const t0 = stationT0();
  state.base.xmin = 0;
  state.base.xmax = Math.max(...trs.map(o => o.tr.start_epoch - t0 + (o.tr.npts-1)*o.tr.delta));
  const pk = state.picks[state.current] || {};
  const pRel = Number.isFinite(pk.p) ? pk.p - t0 : NaN;
  if(Number.isFinite(pRel) && pRel > 0 && pRel < state.base.xmax){
    state.view.xmin = Math.max(0, pRel - 3); state.view.xmax = Math.min(state.base.xmax, state.view.xmin + 12);
  } else { state.view.xmin = 0; state.view.xmax = Math.min(20, state.base.xmax); }
}
function waveBands(area, n){
  const gap = 8, bh = (area.ph - gap*(n-1))/n;
  return [...Array(n)].map((_,k) => ({y0:area.y0 + k*(bh+gap), h:bh}));
}
function xToPx(x, area){ const {xmin,xmax} = state.view; return area.x0 + (x-xmin)/(xmax-xmin)*area.pw; }
function pxToX(px, area){ const {xmin,xmax} = state.view; return xmin + ((px-area.x0)/area.pw)*(xmax-xmin); }
function drawWave(){
  const {ctx, cssW:w, cssH:h} = getWaveCtx();
  ctx.clearRect(0,0,w,h);
  const trs = stationTraces();
  if(!trs.length){
    ctx.fillStyle = TH.ink3; ctx.font = `600 13px ${TH.sans}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(state.order.length ? "Select a station in the list on the left." : "No records yet — load SAC files in Data & audit (1).", w/2, h/2); els.waveMeta.textContent = "-"; return;
  }
  const t0 = stationT0(), area = plotArea(w,h);
  drawAxesWithTicks(ctx, area, state.view.xmin, state.view.xmax, 0, 1, `Time since ${hhmmss_msec_utc(t0)} UTC (s)`, "", null, () => "");
  const bands = waveBands(area, trs.length);
  const pk = state.picks[state.current] || {};
  trs.forEach((o, k) => {
    const tr = o.tr, Y = displayData(tr), dt = tr.delta, off = tr.start_epoch - t0, band = bands[k];
    const i0 = Math.max(0, Math.floor((state.view.xmin - off)/dt)), i1 = Math.min(Y.length-1, Math.ceil((state.view.xmax - off)/dt));
    let ymin = Infinity, ymax = -Infinity;
    for(let i=i0;i<=i1;i++){ if(Y[i] < ymin) ymin = Y[i]; if(Y[i] > ymax) ymax = Y[i]; }
    if(!(ymax > ymin)){ ymin = -1; ymax = 1; }
    const pad = 0.08*(ymax-ymin), yy = v => band.y0 + band.h - (v - ymin + pad)/(ymax - ymin + 2*pad)*band.h;
    ctx.save(); ctx.beginPath(); ctx.rect(area.x0, band.y0, area.pw, band.h); ctx.clip();
    ctx.strokeStyle = TH.hair; ctx.strokeRect(area.x0, band.y0, area.pw, band.h);
    ctx.strokeStyle = TH.trace; ctx.lineWidth = 1; ctx.beginPath();
    const step = Math.max(1, Math.floor((i1-i0)/6000));
    for(let i=i0;i<=i1;i+=step){ const X = xToPx(off + i*dt, area), Yp = yy(Y[i]); if(i === i0) ctx.moveTo(X,Yp); else ctx.lineTo(X,Yp); }
    ctx.stroke();
    for(const [lab, t, col] of [["P", pk.p, TH.p], ["S", pk.s, TH.s]]){
      if(!Number.isFinite(t)) continue;
      const X = xToPx(t - t0, area);
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([6,4]); ctx.beginPath(); ctx.moveTo(X, band.y0); ctx.lineTo(X, band.y0+band.h); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.font = `700 12px ${TH.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(lab, X+4, band.y0+4);
    }
    ctx.restore();
    ctx.fillStyle = TH.ink; ctx.font = `600 11.5px ${TH.mono}`; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(o.comp, area.x0 - 8, band.y0 + band.h/2);
  });
  const s = state.stations[state.current], tr = trs[0].tr;
  const f = els.filterSel.value;
  els.waveMeta.textContent = `${s.code} | ${trs.map(o => o.comp).join(", ")} | Δ=${tr.delta.toFixed(4)} s`
    + (f === "none" ? "" : ` | ${f.toUpperCase()} ${f === "lp" ? "" : els.fminIn.value}${f === "bp" ? "–" : ""}${f === "hp" ? "" : els.fmaxIn.value} Hz, ${els.polesSel.value} poles, zero-phase`);
}
els.waveCanvas.addEventListener("dblclick", () => { if(!stationTraces().length) return; resetViewToCurrent(); drawWave(); });
els.waveCanvas.addEventListener("wheel", ev => {
  ev.preventDefault();
  if(!stationTraces().length) return;
  const {cssW:w, cssH:h} = getWaveCtx(), area = plotArea(w,h);
  const x = pxToX(canvasEventToCssPx(ev, els.waveCanvas).x, area);
  const span = state.view.xmax - state.view.xmin;
  const newSpan = Math.max(0.02, span*(ev.deltaY < 0 ? 1/1.2 : 1.2));
  let xmin = x - (x - state.view.xmin)/span*newSpan, xmax = xmin + newSpan;
  xmin = Math.max(state.base.xmin, xmin); xmax = Math.min(state.base.xmax, xmax);
  if(xmax - xmin < 0.02) xmax = xmin + 0.02;
  state.view.xmin = xmin; state.view.xmax = xmax;
  drawWave();
}, {passive:false});
const DRAG_PX_THRESHOLD = 4;
els.waveCanvas.addEventListener("mousedown", ev => {
  if(!stationTraces().length) return;
  const {cssW:w, cssH:h} = getWaveCtx(), area = plotArea(w,h), p = canvasEventToCssPx(ev, els.waveCanvas);
  if(p.x < area.x0 || p.x > area.x0+area.pw || p.y < area.y0 || p.y > area.y0+area.ph) return;
  state.isDragging = true; state.dragMoved = false;
  state.dragStart = {px:p.x, py:p.y, xmin:state.view.xmin, xmax:state.view.xmax, area};
});
window.addEventListener("mouseup", () => { state.isDragging = false; state.dragStart = null; });
window.addEventListener("mousemove", ev => {
  if(!state.isDragging || !state.dragStart) return;
  const r = els.waveCanvas.getBoundingClientRect();
  const dxPx = ev.clientX - r.left - state.dragStart.px, dyPx = ev.clientY - r.top - state.dragStart.py;
  if(!state.dragMoved && (Math.abs(dxPx) > DRAG_PX_THRESHOLD || Math.abs(dyPx) > DRAG_PX_THRESHOLD)) state.dragMoved = true;
  if(!state.dragMoved) return;
  const span = state.dragStart.xmax - state.dragStart.xmin, dx = dxPx/state.dragStart.area.pw*span;
  let xmin = state.dragStart.xmin - dx, xmax = state.dragStart.xmax - dx;
  if(xmin < state.base.xmin){ xmin = state.base.xmin; xmax = xmin + span; }
  if(xmax > state.base.xmax){ xmax = state.base.xmax; xmin = xmax - span; }
  state.view.xmin = xmin; state.view.xmax = xmax;
  drawWave();
});
els.waveCanvas.addEventListener("click", ev => {
  if(state.dragMoved){ state.dragMoved = false; return; }
  if(!stationTraces().length) return;
  const {cssW:w, cssH:h} = getWaveCtx(), area = plotArea(w,h), p = canvasEventToCssPx(ev, els.waveCanvas);
  if(p.x < area.x0 || p.x > area.x0+area.pw || p.y < area.y0 || p.y > area.y0+area.ph) return;
  const t = stationT0() + pxToX(p.x, area), code = state.current;     // a pick belongs to the station, not to one trace
  if(!state.picks[code]) state.picks[code] = {p:NaN, s:NaN};
  if(state.pickMode === "P"){ state.picks[code].p = t; state.picks[code].pSrc = "manual"; }
  else { state.picks[code].s = t; state.picks[code].sSrc = "manual"; }
  renderPicks(); updateMapStations(false); drawWave(); drawWadati(); runPickDiagnostics();
});

/* ---------- Wadati ---------- */
let wadatiCtxInfo = null;
function getWadatiCtx(){ if(!wadatiCtxInfo) wadatiCtxInfo = setupHiDPICanvas(els.wadatiCanvas, els.wadatiBox); return wadatiCtxInfo; }
function drawWadati(){
  const {ctx, cssW:w, cssH:h} = getWadatiCtx();
  ctx.clearRect(0,0,w,h);
  const area = plotArea(w,h);
  const pts = state.order.filter(hasPS).map(c => ({c, x:state.picks[c].p, y:state.picks[c].s - state.picks[c].p, use:usable(c), flag:!!state.wadati?.flagged?.[c]}));
  if(pts.length < 2){
    drawAxesWithTicks(ctx, area, 0, 10, 0, 10, "P arrival time (UTC)", "S − P (s)");
    ctx.fillStyle = TH.ink3; ctx.font = `12px ${TH.sans}`; ctx.textAlign = "left";
    ctx.fillText("Need ≥ 2 stations with P and S picks.", area.x0+10, area.y0+20);
    els.wadatiMeta.textContent = "-"; return;
  }
  const W = state.wadati;
  let xmin = Math.min(...pts.map(p => p.x)), xmax = Math.max(...pts.map(p => p.x));
  if(W) xmin = Math.min(xmin, W.To);
  let ymax = Math.max(...pts.map(p => p.y));
  const xpad = (xmax-xmin || 1)*0.06; xmin -= xpad; xmax += xpad;
  const ymin = 0; ymax += (ymax || 1)*0.1;
  drawAxesWithTicks(ctx, area, xmin, xmax, ymin, ymax, "P arrival time (UTC)", "S − P (s)", v => hhmmss_utc(v));
  const X = v => area.x0 + (v-xmin)/(xmax-xmin)*area.pw, Y = v => (area.y0+area.ph) - (v-ymin)/(ymax-ymin)*area.ph;
  ctx.save(); ctx.beginPath(); ctx.rect(area.x0, area.y0, area.pw, area.ph); ctx.clip();
  if(W){
    ctx.strokeStyle = TH.chord; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(X(W.To), Y(0)); ctx.lineTo(X(xmax), Y((W.kappa-1)*(xmax-W.To))); ctx.stroke();
    ctx.fillStyle = TH.chord; ctx.beginPath(); ctx.moveTo(X(W.To), Y(0)-2); ctx.lineTo(X(W.To)-6, Y(0)-12); ctx.lineTo(X(W.To)+6, Y(0)-12); ctx.closePath(); ctx.fill();
  }
  ctx.font = `10.5px ${TH.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  for(const p of pts){
    const px = X(p.x), py = Y(p.y);
    ctx.beginPath(); ctx.arc(px, py, 4, 0, 2*Math.PI);
    if(p.use){ ctx.fillStyle = p.flag ? TH.p : TH.joint; ctx.fill(); }
    else { ctx.strokeStyle = TH.ink3; ctx.lineWidth = 1.2; ctx.stroke(); }
    ctx.fillStyle = TH.ink2; ctx.fillText(p.c, px+5, py-3);
  }
  ctx.restore();
  els.wadatiMeta.textContent = W ? `Vp/Vs=${W.kappa.toFixed(3)} To=${hhmmss_msec_utc(W.To)}` : "fit not computed";
}
function computeWadati(silent){
  const codes = timingCodes().filter(hasPS);                       // the Wadati regression needs picks only, not coordinates
  if(codes.length < 2){ if(!silent) alert(`Need P and S picks at ≥ 2 ticked stations (found ${codes.length}; ${state.order.filter(hasPS).length} station(s) have P and S picks).`); return null; }
  const W = C.wadatiFit(codes.map(c => state.picks[c].p), codes.map(c => state.picks[c].s), els.wadMethod.value, {robust:els.wadRobust.checked});
  if(!W.ok){ if(!silent) alert("Wadati fit failed: " + W.reason); return null; }
  W.codes = codes;
  W.flagged = {}; codes.forEach((c,i) => { if(W.outlier[i]) W.flagged[c] = W.loo[i]; });
  state.wadati = W;
  els.vpvsOut.textContent = `${W.kappa.toFixed(4)} ± ${fx(W.seKappa,4)}`;
  els.originTime.textContent = `${hhmmss_msec_utc(W.To)} ± ${fx(W.seTo,3)} s`;
  els.wadFitOut.textContent = `n=${W.n}, RMS(Δt)=${(W.rms*1000).toFixed(0)} ms, ${W.method === "ts" ? "Ts vs Tp" : "Δt vs Tp"}${W.robust ? ", Huber" : ""}`;
  const fl = Object.entries(W.flagged);
  els.wadFlagOut.textContent = fl.length ? "⚠ Possible outliers (leave-one-out Δt residual): " + fl.map(([c,r]) => `${c} (${r > 0 ? "+" : ""}${r.toFixed(2)} s)`).join(", ") : "";
  els.vpvsIn.value = W.kappa.toFixed(4); state.kappaAuto = true;
  renderPicks(); drawWadati();
  return W;
}

/* ---------- Timing ---------- */
const timings = {};
function timed(label, fn){
  const t0 = performance.now(), out = fn();
  timings[label] = performance.now() - t0;
  els.perfOut.textContent = Object.entries(timings).map(([k,v]) => `${k} ${v < 10 ? v.toFixed(1) : v.toFixed(0)} ms`).join(" · ");
  return out;
}

/* ---------- Apparent Vp estimated from the data (section 5) ---------- */
function vpSignature(){
  const codes = jointCodes();
  return JSON.stringify([codes, codes.map(c => [state.picks[c].p, state.picks[c].s]), els.wadMethod.value, els.wadRobust.checked, els.useElev.checked,
    num("sigPIn", 0.05), num("sigSIn", 0.1), els.clockMode.value, num("seedIn", 1)]);
}
function ensureVpEstimate(force){
  const auto = els.vpEstMode.value === "auto";
  els.vpIn.readOnly = auto; els.sigVpIn.readOnly = auto;
  if(!auto){ els.vpEstOut.textContent = state.vpEst && state.vpEst.ok ? `user value in use (last estimate ${state.vpEst.Vp.toFixed(3)} ± ${fx(state.vpEst.sigmaMC, 3)} km/s)` : "user value in use"; return null; }
  const sig = vpSignature();
  if(force || !state.vpEst || state.vpEst.sig !== sig){
    const ji = jointInput(), {codes, inp, tref} = ji;
    if(codes.filter(c => Number.isFinite(state.picks[c].p) || Number.isFinite(state.picks[c].s)).length < 4){
      state.vpEst = {sig, ok:false, reason:"fewer than four selected stations with picks"};
    } else {
      const base = {...inp, solveVp:true, solveKappa:false, huber:false, prior:null};
      const E = timed("apparent Vp", () => C.estimateApparentVp(base, {clock:els.clockMode.value}));
      if(E.ok){
        // Monte Carlo σVp: perturbed picks, Wadati line refitted without the clock-corrected stations
        const clk = E.clock.map(t => codes[t.i]), wad = codes.filter(c => hasPS(c) && !clk.includes(c));
        const mc = C.mcJoint({trials:200, seed:num("seedIn", 1), sigP:inp.sigP, sigS:inp.sigS, base:{...base, clock:E.J.clock, c0:E.J.clockTerms.map(t => t.c), kappaFromWadati:null},
          kappa:E.kappa, tp:inp.tp, ts:inp.ts, m0:E.J.m, refitWadati:wad.length >= 3, wadMethod:els.wadMethod.value,
          wadTp:wad.map(c => state.picks[c].p - tref), wadTs:wad.map(c => state.picks[c].s - tref), wadMap:wad.map(c => codes.indexOf(c))});
        E.sigmaMC = mc.m.length > 20 ? C.summarize(mc.m.map(v => v[4])).sigma : E.sigma;
        E.mcN = mc.m.length; E.codes = codes; E.clockCodes = clk; E.depth = E.J.m[2];
      }
      state.vpEst = {sig, ...E, J:undefined};
    }
  }
  const E = state.vpEst;
  if(E.ok && E.reliable){
    els.vpIn.value = E.Vp.toFixed(3); els.sigVpIn.value = Math.max(E.sigmaMC, E.sigma).toFixed(3);
    if(state.kappaAuto) els.vpvsIn.value = E.kappa.toFixed(4);
  } else {
    els.vpIn.value = num("vpRegIn", 6).toFixed(3); els.sigVpIn.value = "0.500";     // regional value with the prior uncertainty
  }
  els.vpEstOut.textContent = !E.ok ? `not estimated (${E.reason}); regional Vp ${num("vpRegIn", 6).toFixed(2)} km/s used`
    : `${E.Vp.toFixed(3)} ${E.reliable ? `± ${fx(E.sigmaMC, 3)} km/s (MC ${E.mcN}; asymptotic ± ${fx(E.sigma, 3)})` : "km/s (unconstrained)"} from ${E.nSta} stations, Vp/Vs ${E.kappa.toFixed(3)}, depth ${E.depth.toFixed(2)} km, r(h,Vp) ${E.corrHVp.toFixed(2)}`
      + (E.clockCodes.length ? `, clock term ${E.clock.map((t,k) => `${E.clockCodes[k]} ${t.c.toFixed(2)} s`).join(", ")}` : "")
      + (E.tt ? `; P travel-time curve ${E.tt.V.toFixed(3)} ± ${fx(E.tt.sigma, 3)} km/s (${E.tt.n} stations, RMS ${(E.tt.rms*1000).toFixed(0)} ms)` : "")
      + (E.reliable ? "" : ` — ⚠ unreliable (${E.warnings.join("; ")}): regional Vp ${num("vpRegIn", 6).toFixed(2)} km/s used`)
      + (E.reliable && E.warnings.length ? ` — note: ${E.warnings.join("; ")}` : "");
  return E;
}

/* ---------- Three-circle (radical-centre) + three-sphere solution ---------- */
function solveChord(){
  ensureVpEstimate();
  const codes = chordCodes();
  if(codes.length < 3){ alert("Tick at least 3 stations with P and S picks in section 6." + (locationBlocker() ? "\n\n" + locationBlocker() : "")); return; }
  const sts = codes.map(c => state.stations[c]);
  if(sts.some(s => !Number.isFinite(s.lat) || !Number.isFinite(s.lon))){ alert("A selected station has no coordinates (STLA/STLO)."); return; }
  const kappa = num("vpvsIn", NaN);
  let Vp = num("vpIn", NaN), sigVp = Math.max(0, num("sigVpIn", 0)), vpNote = "input";
  if(els.vpSource.value === "joint"){
    if(!state.joint){ alert("Run the joint inversion (section 7) first, or choose 'Vp input'."); return; }
    Vp = state.joint.m[4]; sigVp = state.joint.mcSigma?.[4] ?? state.joint.sigma?.[4] ?? sigVp; vpNote = "joint LS";
    if(!state.joint.solveVp){ sigVp = Math.max(0, num("sigVpIn", 0)); vpNote = "fixed Vp of the joint inversion"; }
  }
  const useElev = els.useElev.checked, sigP = num("sigPIn",0.05), sigS = num("sigSIn",0.1);
  const dt = codes.map(c => state.picks[c].s - state.picks[c].p);
  const sol = C.chordSolve(sts, dt, Vp, kappa, {elev:useElev, sigP, sigS});
  clearSolveLayers(["circles","chords","epicenter"]);
  if(!sol.ok){ alert("Three-circle solution failed: " + sol.reason); return; }

  // Monte Carlo: perturb every pick, refit Wadati on the used stations, perturb Vp
  const allCodes = [...new Set([...usedCodes().filter(hasPS), ...codes])];
  const idx = c => allCodes.indexOf(c);
  const trials = Math.max(0, Math.round(num("mcIn", 400)));
  let mc = null;
  if(trials > 0){
    // Wadati refit in every trial over the stations that define Vp/Vs: the selected stations without clock terms
    const clkSet = new Set([...(state.vpEst && state.vpEst.clockCodes || []), ...(state.joint && state.joint.clock || [])]);
    const wadIdx = (state.vpEst && state.vpEst.codes ? state.vpEst.codes : usedCodes()).filter(c => hasPS(c) && !clkSet.has(c)).map(idx).filter(i => i >= 0);
    mc = timed("three-circle MC", () => C.mcChord({trials, seed:num("seedIn",1), sigP, sigS, sigVp, elev:useElev,
      tpAll:allCodes.map(c => state.picks[c].p), tsAll:allCodes.map(c => state.picks[c].s), stAll:allCodes.map(c => state.stations[c]),
      selIdx:codes.map(idx), wadIdx, refitWadati:wadIdx.length >= 3, wadMethod:els.wadMethod.value, kappa, Vp}));
  }
  const latS = mc ? C.summarize(mc.lat) : null, lonS = mc ? C.summarize(mc.lon) : null, depS = mc ? C.summarize(mc.depth) : null;
  const sphS = mc ? C.summarize(mc.sphereDepth) : null;
  const kmLat = v => v*Math.PI/180*C.R_EARTH, kmLon = v => v*Math.PI/180*C.R_EARTH*Math.cos(sol.epi.lat*Math.PI/180);
  const mcTxt = mc ? ` [MC ${mc.total - mc.failed}/${mc.total}]` : "";
  els.epiOut.textContent = `${sol.epi.lat.toFixed(4)}°N ${sol.epi.lon.toFixed(4)}°E`
    + (mc && latS.n > 2 ? ` ± ${kmLat(latS.sigma).toFixed(2)} km (N–S), ± ${kmLon(lonS.sigma).toFixed(2)} km (E–W)` : "") + mcTxt;
  els.depthOut.textContent = `${sol.depth.toFixed(2)} km below station level (Eq. 11, median of ${sol.nValid})`
    + (mc && depS.n > 2 ? `; MC 68%: ${depS.q16.toFixed(2)}–${depS.q84.toFixed(2)} km` : "");
  const sp = sol.sphere;
  const depthRef = useElev ? "below sea level" : "below station level";
  els.sphereOut.textContent = sp && sp.ok
    ? `${sp.epi.lat.toFixed(4)}°N ${sp.epi.lon.toFixed(4)}°E, depth ${sp.h.toFixed(2)} ± ${fx(sp.sigma?.[2],2)} km ${depthRef}`
      + (mc && sphS.n > 2 ? ` (MC 68%: ${sphS.q16.toFixed(2)}–${sphS.q84.toFixed(2)} km)` : "") + `; RMS sphere misfit ${sp.rmsD.toFixed(2)} km`
      + (sp.atBound ? " ⚠ at the surface: the spheres do not meet below ground" : "")
    : "-";
  els.geomOut.textContent = `${codes.length} stations, inconsistency ${sol.inconsistencyKm < 1e-6 ? "0 (three circles always concur)" : sol.inconsistencyKm.toFixed(3) + " km RMS"}, conditioning ${sol.conditioning.toFixed(1)}`
    + `; Vp = ${Vp.toFixed(3)} km/s (${vpNote}), Vp/Vs = ${kappa.toFixed(3)}`;
  if(mc && mc.failed > 0.2*mc.total) els.geomOut.textContent += `  ⚠ ${mc.failed} MC trials had no real depth`;

  els.depthTable.innerHTML = "";
  codes.forEach((c,i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="mono">${escapeHtml(c)}</td><td class="mono">${dt[i].toFixed(3)}</td><td class="mono">${sol.D[i].toFixed(2)}</td>`
      + `<td class="mono">${sol.R[i].toFixed(2)}</td><td class="mono">${fx(sol.hs[i],2)}</td>`;
    els.depthTable.appendChild(tr);
  });
  const palette = [TH.p, TH.s, TH.joint, TH.chord, TH.post, "#d6409f"];
  if(state.map) codes.forEach((c,i) => {
    L.circle([sts[i].lat, sts[i].lon], {radius:sol.D[i]*1000, color:palette[i%palette.length], weight:2, opacity:0.9, fillOpacity:0.04})
      .addTo(state.mapLayers.circles).bindPopup(`<b>${escapeHtml(c)}</b><br/>Dhyp=${sol.D[i].toFixed(2)} km`);
  });
  if(state.map && codes.length <= 6){
    sol.segs.forEach(g => {
      L.polyline([xyLL(g.p1, sol.c0), xyLL(g.p2, sol.c0)], {color:TH.chord, weight:2.5, opacity:0.95, dashArray:g.intersecting ? null : "6 6"})
        .addTo(state.mapLayers.chords);
    });
  }
  if(state.map) L.marker([sol.epi.lat, sol.epi.lon], {icon:dot(TH.chord, 13)}).addTo(state.mapLayers.epicenter)
    .bindPopup(`<b>Three-circle epicentre</b><br/>${sol.epi.lat.toFixed(4)}, ${sol.epi.lon.toFixed(4)}<br/>depth ${sol.depth.toFixed(2)} km`);
  state.chord = {codes, Vp, vpSource:vpNote, kappa, useElev,
    sol:{epi:sol.epi, depth:sol.depth, depthMad:sol.depthMad, nValid:sol.nValid, inconsistencyKm:sol.inconsistencyKm, D:sol.D, R:sol.R, hs:sol.hs,
         sphere:sp && sp.ok ? {epi:sp.epi, h:sp.h, sigma:sp.sigma, rmsD:sp.rmsD, atBound:sp.atBound} : null},
    mc:mc ? {trials:mc.total, failed:mc.failed, lat:latS, lon:lonS, depth:depS, sphereDepth:sphS,
             samples:{lat:mc.lat, lon:mc.lon, depth:mc.depth, sphereDepth:mc.sphereDepth}} : null};
  updateReferenceOffsets();
  if(state.map) fitMap(L.latLngBounds([...sts.map(s => [s.lat, s.lon]), [sol.epi.lat, sol.epi.lon]]).pad(0.25));
}
function fixedPointCheck(){
  ensureVpEstimate();
  const codes = chordCodes();
  if(codes.length < 3){ alert("Tick at least 3 stations in section 6."); return; }
  const W = state.wadati || computeWadati(true);
  if(!W){ alert("Compute the Wadati fit first."); return; }
  const used = usedCodes().filter(c => Number.isFinite(state.picks[c].p));
  const fp = C.fixedPointVp(codes.map(c => state.stations[c]), codes.map(c => state.picks[c].s - state.picks[c].p),
    used.map(c => state.stations[c]), used.map(c => state.picks[c].p), W.To, num("vpvsIn", W.kappa), num("vpIn", 6));
  const verdict = fp.converged ? "attracting fixed point" : (fp.atBound ? "drifted to the velocity bound" : (Math.abs(fp.gprime) >= 1 ? "repelling fixed point" : "did not converge"));
  els.fpOut.textContent = `V = ${fp.V.toFixed(3)} km/s after ${fp.history.length-1} steps, g′ = ${fx(fp.gprime,2)} → ${verdict}`
    + (fp.converged ? "" : "; do not use this Vp");
  els.fpOut.className = "mono" + (fp.converged ? "" : " warn");
}

/* ---------- Joint inversion ---------- */
function jointInput(){
  const codes = jointCodes();
  const sts = codes.map(c => state.stations[c]), c0 = C.centroid(sts), useElev = els.useElev.checked;
  const xy = sts.map(s => ({...C.equirectXY(s.lat, s.lon, c0.lat, c0.lon), z:useElev && Number.isFinite(s.elev_m) ? s.elev_m/1000 : 0}));
  const tpA = codes.map(c => state.picks[c].p), tsA = codes.map(c => state.picks[c].s);
  const tref = Math.floor(Math.min(...tpA.filter(Number.isFinite))) - 1;
  const Wall = state.wadati || computeWadati(true);
  // Wadati fit of the selected stations (the section 4 fit may include stations not selected here)
  const psSel = codes.filter(hasPS);
  const Wsel = psSel.length >= 3 ? C.wadatiFit(psSel.map(c => state.picks[c].p), psSel.map(c => state.picks[c].s), els.wadMethod.value, {robust:els.wadRobust.checked}) : null;
  const W = Wsel && Wsel.ok ? Wsel : Wall;
  const vpMode = els.vpMode.value, kMode = els.kappaMode.value;
  const kappa = state.kappaAuto && W ? W.kappa : num("vpvsIn", W ? W.kappa : 1.73);
  const To0 = W ? W.To - tref : Math.min(...tpA.filter(Number.isFinite)) - tref - 2;
  const inp = {xy, tp:tpA.map(t => t - tref), ts:tsA.map(t => t - tref), kappa, solveVp:vpMode === "free", Vp:num("vpIn", 6),
               solveKappa:kMode === "free", huber:els.useHuber.checked, sigP:num("sigPIn",0.05), sigS:num("sigSIn",0.1),
               m0:[0, 0, 10, To0, num("vpIn", 6)]};
  // Vp/Vs from the Wadati fit (not typed in): refit without stations that receive a clock term
  if(state.kappaAuto && W) inp.kappaFromWadati = {tp:inp.tp, ts:inp.ts, method:els.wadMethod.value, robust:els.wadRobust.checked};
  if(els.usePrior.checked) inp.prior = {Vp:[num("vpRegIn", 6), 0.5], kappa:[W ? W.kappa : kappa, 0.1]};
  return {codes, sts, c0, useElev, tref, W, inp};
}
function solveJoint(){
  ensureVpEstimate();
  const ji = jointInput(), {codes, sts, c0, useElev, tref, W, inp} = ji;
  const need = inp.solveVp ? 4 : 3;
  if(codes.length < need){ alert(`Joint LS needs ≥ ${need} selected stations with picks and coordinates (${codes.length} selected in section 7).` + (locationBlocker() ? "\n\n" + locationBlocker() : "")); return; }
  const J = timed("joint LS + depth scan", () => C.jointRobust(inp, {step:0.5, hmax:40, clock:els.clockMode.value}));
  if(!J.ok){ alert("Joint inversion failed: " + J.reason); return; }
  const epi = C.xyToLatLon(J.m[0], J.m[1], c0.lat, c0.lon);
  let mc = null, mcSig = null;
  const trials = els.jointMC.checked ? Math.max(0, Math.round(Math.min(num("mcIn",400), 1000))) : 0;
  if(trials > 0){
    const clkCodes = J.clock.map(i => codes[i]);
    const wadCodes = codes.filter(hasPS).filter(c => !clkCodes.includes(c));     // selected stations without a clock term
    const base = {...inp, clock:J.clock, c0:J.clockTerms.map(t => t.c), prior:J.prior};
    mc = timed("joint MC", () => C.mcJoint({trials, seed:num("seedIn",1), sigP:inp.sigP, sigS:inp.sigS, base, kappa:J.kappa,
      tp:inp.tp, ts:inp.ts, m0:J.m.slice(0,5),
      refitWadati:!inp.solveKappa && wadCodes.length >= 3, wadMethod:els.wadMethod.value,
      wadTp:wadCodes.map(c => state.picks[c].p - tref), wadTs:wadCodes.map(c => state.picks[c].s - tref), wadMap:wadCodes.map(c => codes.indexOf(c))}));
    if(mc.m.length > 10) mcSig = [0,1,2,3,4].map(k => C.summarize(mc.m.map(v => v[k])).sigma);
  }
  const sg = mcSig || J.sigma, sgA = J.sigma;
  const depthRef = useElev ? "below sea level" : "below station level";
  const tag = mcSig ? `MC ${mc.m.length}/${mc.total}` : "asymptotic";
  const nUnk = 3 + (J.fixDepth ? 0 : 1) + (J.solveVp ? 1 : 0) + (J.solveKappa ? 1 : 0) + J.clock.length;
  const offJ = usedCodes().filter(c => !codes.includes(c));
  els.njOut.textContent = `${J.nSta} stations (${codes.join(", ")}), ${J.nObs} arrivals, ${nUnk} unknowns, dof ${J.dof}` + (offJ.length ? `; not selected: ${offJ.join(", ")}` : "");
  els.epiJointOut.textContent = `${epi.lat.toFixed(4)}°N ${epi.lon.toFixed(4)}°E ± ${fx(sg[1],2)} km (N–S), ± ${fx(sg[0],2)} km (E–W) [${tag}; asymptotic ${fx(sgA[1],2)}/${fx(sgA[0],2)}]`;
  const ci = J.profileCI;
  els.depthJointOut.textContent = `${J.m[2].toFixed(2)} ± ${fx(sg[2],2)} km ${depthRef} [${tag}; asymptotic ± ${fx(sgA[2],2)}`
    + (ci ? `; depth-scan interval ${ci.lo.toFixed(1)}–${ci.hi.toFixed(1)} km${ci.loOpen || ci.hiOpen ? " (open)" : ""}` : "") + "]";
  els.toJointOut.textContent = `${hhmmss_msec_utc(J.m[3] + tref)} ± ${fx(sg[3],3)} s`;
  els.vpJointOut.textContent = (J.solveVp ? `Vp = ${J.m[4].toFixed(3)} ± ${fx(sg[4],3)} km/s` : `Vp fixed at ${J.m[4].toFixed(3)} km/s`)
    + (J.solveKappa ? `, Vp/Vs = ${J.kappa.toFixed(3)} ± ${fx(J.sigma[5],3)}` : `, Vp/Vs fixed at ${J.kappa.toFixed(3)}`);
  els.rmsJointOut.textContent = `RMS ${(J.rms*1000).toFixed(0)} ms, χ²/dof ${fx(J.chi2red,2)}, ${J.iterations} LM steps${J.converged ? "" : " (not converged)"}, cond ${J.cond.toExponential(1)}`
    + (J.solveVp ? `, r(h,Vp) = ${(J.cov[2][4]/Math.sqrt(J.cov[2][2]*J.cov[4][4])).toFixed(2)}` : "") + `, r(h,To) = ${(J.cov[2][3]/Math.sqrt(J.cov[2][2]*J.cov[3][3])).toFixed(2)}`;
  let cxx, cxy, cyy;
  if(mcSig){
    const n = mc.m.length, mx = mc.m.reduce((a,v) => a + v[0], 0)/n, my = mc.m.reduce((a,v) => a + v[1], 0)/n;
    cxx = mc.m.reduce((a,v) => a + (v[0]-mx)**2, 0)/(n-1);
    cyy = mc.m.reduce((a,v) => a + (v[1]-my)**2, 0)/(n-1);
    cxy = mc.m.reduce((a,v) => a + (v[0]-mx)*(v[1]-my), 0)/(n-1);
  } else { cxx = J.cov[0][0]; cxy = J.cov[0][1]; cyy = J.cov[1][1]; }
  const ell = Number.isFinite(cxx) ? C.errorEllipse(cxx, cxy, cyy) : null;
  els.ellJointOut.textContent = ell ? `${ell.a.toFixed(2)} × ${ell.b.toFixed(2)} km, major axis azimuth ${ell.azimuth.toFixed(0)}°` : "-";
  const rej = (J.clockTests || []).filter(t => !t.accepted);
  els.clockJointOut.textContent = (J.clockTerms.length ? J.clockTerms.map(t => {
      const ts = (J.clockTests || []).find(q => q.station === t.i);
      return `${codes[t.i]} ${t.c >= 0 ? "+" : ""}${t.c.toFixed(3)} ± ${fx(t.sigma,3)} s${ts ? ` (F = ${ts.F.toFixed(1)} > ${ts.Fcrit.toFixed(1)})` : ""}`; }).join("; ")
      + (J.wadatiRefit ? `; Wadati refitted without ${J.clock.map(i => codes[i]).join(", ")}: Vp/Vs = ${J.wadatiRefit.kappa.toFixed(3)} ± ${fx(J.wadatiRefit.seKappa,3)}` : "")
    : (els.clockMode.value === "off" ? "not tested" : "none needed"))
    + (rej.length ? ` · best further candidate ${codes[rej[0].station]} rejected (` + (rej[0].F <= rej[0].Fcrit ? `F = ${rej[0].F.toFixed(1)} < ${rej[0].Fcrit.toFixed(1)}`
        : `F = ${rej[0].F.toFixed(1)} > ${rej[0].Fcrit.toFixed(1)}, but |c| = ${Math.abs(rej[0].c).toFixed(3)} s < 3σ = ${(3*rej[0].sigma).toFixed(3)} s`) + ")" : "");
  const R = J.depthResolution;
  els.resolJointOut.textContent = R ? `${R.class}; ${R.hSurface.toFixed(2)} km below the nearest station (${codes[R.nearest]}, ${R.Rmin.toFixed(1)} km from the epicentre, ratio ${R.ratio.toFixed(1)})`
    + (R.spDepth ? `; S−P-only (sphere) depth ${R.spDepth.h.toFixed(2)} ± ${fx(R.spDepth.sigma,2)} km` : "")
    + `; r(h,To) ${fx(R.corrHT0,2)}` + (J.solveVp ? `, r(h,Vp) ${fx(R.corrHVp,2)}` : "") : "-";
  const warn = [...J.depthWarning];
  if(J.cond > 1e8) warn.push("normal matrix is nearly singular: the station geometry cannot resolve all unknowns");
  if(!J.solveKappa && !mcSig) warn.push("Vp/Vs is fixed and no Monte Carlo was run: the asymptotic σ is a lower bound");
  const timing = codes.filter((c,i) => !J.clock.includes(i) && J.flags[i].some(f => f.startsWith("same-sign")));
  if(timing.length) warn.push(`same-sign P and S residuals at ${timing.join(", ")}: check station timing`);
  els.jointWarn.textContent = warn.length ? "⚠ " + warn.join("; ") : "";

  const fwd = C.jointForward(J.m.slice(0,5), inp.xy, J.kappa);
  els.residTableJoint.innerHTML = "";
  codes.forEach((c,i) => {
    const Depi = Math.sqrt(Math.max(0, fwd.D[i]**2 - (J.m[2] + inp.xy[i].z)**2));
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="mono">${escapeHtml(c)}</td><td class="mono">${fx(J.rp[i],3)}</td><td class="mono">${fx(J.rs[i],3)}</td>`
      + `<td class="mono">${Depi.toFixed(2)}</td><td class="flag">${escapeHtml([...(J.clock.includes(i) ? [`clock term ${J.clockTerms.find(t => t.i === i).c.toFixed(3)} s (residuals after correction)`] : []), ...J.flags[i]].join("; "))}</td>`;
    els.residTableJoint.appendChild(tr);
  });
  clearSolveLayers(["joint"]);
  if(state.map && ell){
    const poly = C.ellipsePolygon(J.m[0], J.m[1], ell, 1, 72).map(p => xyLL(p, c0));
    L.polygon(poly, {color:TH.joint, weight:2, fillOpacity:0.14}).addTo(state.mapLayers.joint);
  }
  if(state.map) L.marker([epi.lat, epi.lon], {icon:dot(TH.joint, 13)}).addTo(state.mapLayers.joint)
    .bindPopup(`<b>Joint LS epicentre</b><br/>${epi.lat.toFixed(4)}, ${epi.lon.toFixed(4)}<br/>depth ${J.m[2].toFixed(2)} km`);
  state.joint = {codes, epi, m:J.m, kappa:J.kappa, sigma:J.sigma, cov:J.cov, mcSigma:mcSig, mcTrials:mc ? mc.m.length : 0, tref, c0, rms:J.rms,
    chi2red:J.chi2red, dof:J.dof, cond:J.cond, solveVp:J.solveVp, solveKappa:J.solveKappa, huber:inp.huber, useElev, atBound:J.atBound,
    depthWarning:J.depthWarning, clock:J.clock.map(i => codes[i]), clockIdx:J.clock, clockTerms:J.clockTerms.map(t => ({code:codes[t.i], c:t.c, sigma:t.sigma})),
    clockTests:(J.clockTests || []).map(t => ({...t, station:codes[t.station]})), wadatiRefit:J.wadatiRefit || null, prior:J.prior,
    depthResolution:J.depthResolution ? {...J.depthResolution, nearest:codes[J.depthResolution.nearest], interval:undefined} : null, profile:J.profile.map(p => ({h:p.h, chi2:p.chi2, rms:p.rms})), profileCI:J.profileCI,
    residuals:codes.map((c,i) => ({code:c, p:J.rp[i], s:J.rs[i], flags:J.flags[i]})), ellipse:ell,
    mcSamples:mc ? mc.m.map(v => v.slice(0,5)) : null};
  state.posterior = null; state.bayes = null;
  if(els.useBayes.checked) runBayes(true);          // optional Bayesian sampling, started from this least-squares solution
  else els.bayesOut.textContent = "not run (tick “Bayesian sampling” to sample the posterior with the joint inversion)";
  drawDepthPanel();
  updateReferenceOffsets();
  if(state.map) fitMap(L.latLngBounds([...sts.map(s => [s.lat, s.lon]), [epi.lat, epi.lon]]).pad(0.15));
}

/* ---------- Depth panel: depth scan (χ² vs depth) and posterior depth histogram ---------- */
let depthCtxInfo = null;
function drawDepthPanel(){
  if(!depthCtxInfo) depthCtxInfo = setupHiDPICanvas(els.depthCanvas, els.depthBox);
  const {ctx, cssW:w, cssH:h} = depthCtxInfo;
  ctx.clearRect(0,0,w,h);
  const J = state.joint, area = plotArea(w,h);
  if(!J || !J.profile.length){
    drawAxesWithTicks(ctx, area, 0, 40, 0, 1, "Depth (km)", "Δχ²");
    ctx.fillStyle = TH.ink3; ctx.font = `12px ${TH.sans}`; ctx.textAlign = "left";
    ctx.fillText("Run the joint inversion to scan the misfit against depth.", area.x0+10, area.y0+20); return;
  }
  const P = J.profile.filter(p => Number.isFinite(p.chi2)), cmin = Math.min(...P.map(p => p.chi2));
  const sc = Math.max(1, J.chi2red || 1);
  const yv = P.map(p => (p.chi2 - cmin)/sc);
  const xmin = Math.min(...P.map(p => p.h)), xmax = Math.max(...P.map(p => p.h)), ymax = Math.min(Math.max(...yv), 60) || 1;
  drawAxesWithTicks(ctx, area, xmin, xmax, 0, ymax, "Depth (km)", "Δχ² / χ²_red");
  const X = v => area.x0 + (v-xmin)/(xmax-xmin)*area.pw, Y = v => area.y0 + area.ph - Math.min(v, ymax)/ymax*area.ph;
  ctx.save(); ctx.beginPath(); ctx.rect(area.x0, area.y0, area.pw, area.ph); ctx.clip();
  if(state.posterior){
    const hs = state.posterior.samples.map(v => v[2]), nb = 40, bw = (xmax-xmin)/nb, cnt = new Array(nb).fill(0);
    hs.forEach(v => { const k = Math.floor((v-xmin)/bw); if(k >= 0 && k < nb) cnt[k]++; });
    const cm = Math.max(...cnt);
    ctx.fillStyle = TH.alpha(TH.post, .35);
    cnt.forEach((c,k) => { const y0 = area.y0 + area.ph - c/cm*area.ph*0.9; ctx.fillRect(X(xmin + k*bw), y0, Math.max(1, X(xmin+(k+1)*bw) - X(xmin+k*bw) - 1), area.y0 + area.ph - y0); });
  }
  ctx.strokeStyle = TH.ink3; ctx.setLineDash([4,4]); ctx.beginPath(); ctx.moveTo(area.x0, Y(1)); ctx.lineTo(area.x0+area.pw, Y(1)); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = TH.joint; ctx.lineWidth = 2; ctx.beginPath();
  P.forEach((p,i) => { if(i) ctx.lineTo(X(p.h), Y(yv[i])); else ctx.moveTo(X(p.h), Y(yv[i])); }); ctx.stroke();
  ctx.fillStyle = TH.joint; ctx.beginPath(); ctx.arc(X(J.m[2]), Y(0), 5, 0, 2*Math.PI); ctx.fill();
  if(state.reference && Number.isFinite(state.reference.depth)){
    ctx.strokeStyle = TH.ref; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(state.reference.depth), area.y0); ctx.lineTo(X(state.reference.depth), area.y0+area.ph); ctx.stroke();
  }
  ctx.restore();
  els.depthMeta.textContent = `h ${J.m[2].toFixed(2)} km` + (J.profileCI ? ` [${J.profileCI.lo.toFixed(2)}–${J.profileCI.hi.toFixed(2)}]` : "")
    + (state.posterior ? " · violet: posterior" : "") + (state.reference ? " · vermilion: header" : "");
}

/* ---------- Velocity sensitivity ---------- */
function runSensitivity(){
  ensureVpEstimate();
  const {codes, c0, inp} = jointInput();
  if(codes.length < 3){ alert("Need ≥ 3 used stations."); return; }
  const base = state.joint ? [...state.joint.m] : inp.m0;
  const Vp0 = state.joint && state.joint.solveVp ? state.joint.m[4] : num("vpIn", 6), k0 = state.joint ? state.joint.kappa : num("vpvsIn", 1.73);
  const VpList = [-0.4, -0.2, 0, 0.2, 0.4].map(d => +(Vp0 + d).toFixed(2)), kList = [-0.05, 0, 0.05].map(d => +(k0 + d).toFixed(3));
  const clk = state.joint ? {clock:state.joint.clockIdx, c0:state.joint.clockTerms.map(t => t.c)} : {};
  const res = timed("sensitivity", () => C.velocitySensitivity({...inp, ...clk, prior:null, m0:base}, VpList, kList));
  const ref = res.find(r => r.Vp === VpList[2] && r.kappa === kList[1]);
  els.sensTable.innerHTML = "";
  for(const r of res){
    const ll = C.xyToLatLon(r.x, r.y, c0.lat, c0.lon), d = ref ? Math.hypot(r.x - ref.x, r.y - ref.y) : NaN;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="mono">${r.Vp.toFixed(2)}</td><td class="mono">${r.kappa.toFixed(3)}</td><td class="mono">${ll.lat.toFixed(4)}, ${ll.lon.toFixed(4)}</td>`
      + `<td class="mono">${fx(d,2)}</td><td class="mono">${r.h.toFixed(2)}${r.atBound ? " ⚠" : ""}</td><td class="mono">${(r.rms*1000).toFixed(0)}</td>`;
    els.sensTable.appendChild(tr);
  }
  state.sensitivity = res.map(r => ({...r, ...C.xyToLatLon(r.x, r.y, c0.lat, c0.lon)}));
}

/* ---------- Bayesian sampling ---------- */
function runBayes(inJoint){
  if(!inJoint) ensureVpEstimate();
  if(!state.joint){ alert("Run the joint inversion first (it provides the starting point and proposal scale)."); return; }
  const {inp} = jointInput(), J = state.joint;
  const cov = J.cov.map(r => r.slice());
  if(!J.solveKappa){ cov[5] = cov[5].map((_,j) => j === 5 ? 0.0025 : 0); cov.forEach((r,i) => { if(i !== 5) r[5] = 0; }); }
  if(!J.solveVp){ cov[4] = cov[4].map((_,j) => j === 4 ? 0.04 : 0); cov.forEach((r,i) => { if(i !== 4) r[4] = 0; }); }
  const W = state.wadati;
  const Wk = J.wadatiRefit || W;                        // Wadati fit without the stations with a clock term (its To is relative to tref)
  const res = timed("Bayesian sampler", () => C.mcmcJoint({...inp, clock:J.clockIdx}, {iter:num("bayesIter", 20000), burn:Math.round(num("bayesIter",20000)/4), thin:5, seed:num("seedIn",1),
    start:[...J.m, J.kappa], cov, prior:{To:J.wadatiRefit ? J.wadatiRefit.To : (W ? W.To - J.tref : J.m[3]), Vp:num("vpRegIn", 6), kappa:Wk ? Wk.kappa : num("vpvsIn", 1.73)}}));
  state.posterior = res;
  const s = res.summary, c0 = J.c0, ll = C.xyToLatLon(s[0].med, s[1].med, c0.lat, c0.lon);
  const ok = res.rhat.every(v => v < 1.05);
  els.bayesOut.textContent = `${ll.lat.toFixed(4)}°N ${ll.lon.toFixed(4)}°E (±${s[1].sigma.toFixed(2)} N–S, ±${s[0].sigma.toFixed(2)} E–W km), `
    + `depth ${s[2].med.toFixed(2)} [${s[2].q16.toFixed(2)}–${s[2].q84.toFixed(2)}] km, Vp ${s[4].med.toFixed(2)} ± ${s[4].sigma.toFixed(2)}, Vp/Vs ${s[5].med.toFixed(3)} ± ${s[5].sigma.toFixed(3)}; `
    + `acceptance ${res.accept.map(a => a.toFixed(2)).join("/")}, R̂ max ${Math.max(...res.rhat).toFixed(3)}${ok ? "" : " ⚠ not converged: increase iterations"}`;
  state.bayes = {summary:s, epi:ll, accept:res.accept, rhat:res.rhat, nSamples:res.samples.length, iterations:num("bayesIter",20000)};
  drawDepthPanel();
}

function clearSolveLayers(which){
  if(!initMapIfNeeded()) return;
  for(const k of (which || ["circles","chords","epicenter","joint"])) state.mapLayers[k].clearLayers();
}

/* ---------- Reference location from SAC headers ---------- */
const RN = () => (state.reference && state.reference.sources && state.reference.sources.epicentre === "csv") ? "quake.csv" : "SAC-header";   // name of the reference source in labels
const RND = () => (state.reference && state.reference.sources && state.reference.sources.depth === "csv") ? ((state.eventCSV ? state.eventCSV.name : "event file") + " depth") : "SAC-header depth";
const RNR = () => { const so = state.reference && state.reference.sources; if(!so || so.epicentre === so.depth) return RN() + " reference"; return `reference (epicentre: ${so.epicentre === "csv" ? "event file" : "SAC header"}, depth: ${so.depth === "csv" ? "event file" : "SAC header"})`; };
/* ---------- Event parameters: SAC headers versus quake.csv ----------
   Parameters: epicentre (lat, lon), focal depth, magnitude, origin time. For each one the header value is checked for validity
   (undefined/filler values, ranges); when a quake.csv event is available it is compared with the header (tolerances in section 1) and
   the source actually used is recorded and logged. The SAC files and their headers are never modified (optional copies only). */
const EVT_COLS = {
  id:["id", "event", "evid", "eventid", "event_id", "name", "evnm"],
  time:["time", "origin time", "origin_time", "origintime", "time (utc)", "datetime", "date_time", "origin", "utc", "otime", "origin_utc"],
  date:["date", "origin_date", "date (utc)"], year:["year", "yr", "yyyy"], month:["month", "mon", "mo", "mm"], day:["day", "dy", "dd"],
  hour:["hour", "hr", "hh"], minute:["minute", "min", "mi"], second:["second", "sec", "ss", "seconds"],
  lat:["lat", "latitude", "evla", "hypo_lat", "hypocenter_lat", "epicenter_lat", "elat"], lon:["lon", "lng", "long", "longitude", "evlo", "hypo_lon", "hypocenter_lon", "epicenter_lon", "elon"],
  depth:["depth", "depth (km)", "depth_km", "dep", "evdp", "focal_depth", "hypo_depth", "h"], depth_m:["depth_m"],
  mag:["mag", "magnitude", "m", "ml", "mw", "mb", "ms", "md"]};
function evtLog(level, param, message, source){
  const e = {time:new Date().toISOString(), level, param, source:source || "", message};
  (state.eventLog = state.eventLog || []).push(e);
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[event:${param}] ${message}`);
}
function parseEventTime(str){
  const t = String(str).trim(); if(!t) return NaN;
  if(/^\d{9,11}(\.\d+)?$/.test(t)) return Number(t);
  const m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*Z?$/);
  if(!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), 0)/1000 + Number(m[6] || 0);
}
function parseEventCSV(text){
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const problems = [], events = [];
  if(!lines.length) return {events, problems:["empty file"], header:[]};
  const split = l => l.split(l.includes("\t") ? "\t" : l.includes(";") ? ";" : l.includes(",") ? "," : /\s+/).map(x => x.trim().replace(/^"|"$/g, ""));
  let head = split(lines[0]).map(x => x.toLowerCase()), hasHead = head.some(x => Object.values(EVT_COLS).flat().includes(x)), body = lines;
  const idx = {};
  if(hasHead){ body = lines.slice(1); for(const [k, names] of Object.entries(EVT_COLS)){ const i = head.findIndex(x => names.includes(x)); if(i >= 0) idx[k] = i; } }
  else { problems.push("no header row recognised: assuming the columns are lat, lon, depth_km, mag"); Object.assign(idx, {lat:0, lon:1, depth:2, mag:3}); }
  if(idx.lat === undefined || idx.lon === undefined) problems.push("no latitude/longitude column found (accepted names: " + EVT_COLS.lat.join(", ") + " / " + EVT_COLS.lon.join(", ") + ")");
  body.forEach((l, k) => {
    const c = split(l), row = k + 1 + (hasHead ? 1 : 0), get = key => idx[key] !== undefined ? c[idx[key]] : undefined, num = v => (v === undefined || v === "" || /^(nan|na|null|-)$/i.test(v)) ? NaN : Number(v);
    let t = NaN;
    if(idx.time !== undefined && get("time") === "") t = NaN;   // blank origin time: unknown, not midnight
    else if(get("time") !== undefined){ t = parseEventTime(get("time")); if(!Number.isFinite(t) && get("date") !== undefined) t = parseEventTime(get("date") + " " + get("time")); }
    else if(get("date") !== undefined) t = parseEventTime(get("date"));
    else if(get("year") !== undefined && get("month") !== undefined && get("day") !== undefined)
      t = Date.UTC(+get("year"), +get("month") - 1, +get("day"), +(get("hour") || 0), +(get("minute") || 0), 0)/1000 + Number(get("second") || 0);
    const ev = {row, id:get("id") ?? ("row " + row), t, lat:num(get("lat")), lon:num(get("lon")), depth:num(get("depth")), mag:num(get("mag")), issues:[]};
    if(idx.depth_m !== undefined && !Number.isFinite(ev.depth)) ev.depth = num(get("depth_m"))/1000;
    if(get("time") !== undefined && get("time") !== "" && !Number.isFinite(t)) ev.issues.push(`origin time “${get("time")}” not understood`);
    if(!(Math.abs(ev.lat) <= 90)) { ev.issues.push("latitude missing or out of range"); ev.lat = NaN; }
    if(!(Math.abs(ev.lon) <= 360)) { ev.issues.push("longitude missing or out of range"); ev.lon = NaN; }
    if(ev.lat === 0 && ev.lon === 0){ ev.issues.push("0, 0 is not accepted as an epicentre"); ev.lat = ev.lon = NaN; }
    if(Number.isFinite(ev.depth) && !(ev.depth >= 0 && ev.depth <= 700)){ ev.issues.push(`depth ${ev.depth} km outside 0–700 km`); ev.depth = NaN; }
    if(Number.isFinite(ev.mag) && !(ev.mag > -2 && ev.mag < 10)){ ev.issues.push(`magnitude ${ev.mag} outside −2…10`); ev.mag = NaN; }
    if(!Number.isFinite(ev.lat) && !Number.isFinite(ev.lon) && !Number.isFinite(ev.depth) && !Number.isFinite(ev.mag)) { problems.push(`row ${row}: no usable parameter (${l.slice(0, 50)})`); return; }
    for(const q of ev.issues) problems.push(`row ${row}: ${q}`);
    events.push(ev);
  });
  return {events, problems, header:head, columns:idx};
}
/* what the SAC headers say (already sanitized by the reader), with validity flags and the spread between files */
function headerEventParams(){
  const refs = state.order.map(c => state.stations[c].ref).filter(Boolean), fin = k => refs.map(r => r[k]).filter(Number.isFinite);
  const med = k => fin(k).length ? C.median(fin(k)) : NaN, spread = k => fin(k).length > 1 ? Math.max(...fin(k)) - Math.min(...fin(k)) : 0;
  const H = {lat:med("lat"), lon:med("lon"), depth:med("depth"), mag:med("mag"), origin:med("origin"), n:fin("lat").length, nOrigin:fin("origin").length, nMag:fin("mag").length, notes:[]};
  H.valid = {epi:Number.isFinite(H.lat) && Number.isFinite(H.lon), depth:Number.isFinite(H.depth) && H.depth > 0 && H.depth <= 700,
             mag:Number.isFinite(H.mag) && H.mag > -2 && H.mag < 10 && H.mag !== 0, origin:Number.isFinite(H.origin)};
  if(Number.isFinite(H.depth) && !H.valid.depth) H.notes.push(`header depth ${H.depth} km is not a plausible focal depth (0 is the SAC default)`);
  if(Number.isFinite(H.mag) && !H.valid.mag) H.notes.push(`header magnitude ${H.mag} is not plausible`);
  if(spread("lat") > 0.05 || spread("lon") > 0.05) H.notes.push("header epicentres differ between files by more than 0.05°");
  if(spread("depth") > 1) H.notes.push("header depths differ between files by more than 1 km");
  return H;
}
const evT = e => Number.isFinite(e.t) ? e.t - num("tzOff", 0)*3600 : NaN;      // quake.csv time → UTC (offset = hours ahead of UTC, e.g. 9 for KST)
function recordSpan(){
  const tr = state.order.flatMap(c => Object.values(state.stations[c].comps));
  if(!tr.length) return null;
  const P = state.order.map(c => state.picks[c] && state.picks[c].p).filter(Number.isFinite);
  return {t0:Math.min(...tr.map(t => t.start_epoch)), t1:Math.max(...tr.map(t => t.start_epoch + (t.npts - 1)*t.delta)), firstP:P.length ? Math.min(...P) : NaN};
}
/* choose the quake.csv event that belongs to the loaded records (by origin time); never guess when it is ambiguous */
function matchEvent(){
  const E = state.eventCSV; if(!E || !E.events.length){ state.eventSel = null; return; }
  const sp = recordSpan(); let pick = null, why = "";
  const manual = state.eventManual != null ? E.events.find(e => e.row === state.eventManual) : null;
  if(manual){ pick = manual; why = "selected by the user"; }
  else if(!sp){ state.eventSel = null; return; }
  else {
    const timed = E.events.filter(e => Number.isFinite(e.t));
    if(timed.length){
      const cand = timed.filter(e => evT(e) >= sp.t0 - 600 && evT(e) <= sp.t1);
      if(cand.length === 1){ pick = cand[0]; why = "origin time lies in the record span"; }
      else if(cand.length > 1 && Number.isFinite(sp.firstP)){
        const before = cand.filter(e => evT(e) <= sp.firstP).sort((a, b) => evT(b) - evT(a)); if(before.length){ pick = before[0]; why = `latest origin time before the first P pick (${cand.length} candidates in the span)`; }
      }
      if(!pick) evtLog("error", "event", cand.length ? `${cand.length} quake.csv events fall in the record span and none can be chosen unambiguously: select one manually` :
        `no quake.csv event has an origin time within the records (${new Date(sp.t0*1000).toISOString().slice(0, 19)}Z – ${new Date(sp.t1*1000).toISOString().slice(0, 19)}Z); nearest: ${timed.length ? timed.reduce((a, b) => Math.abs(evT(b) - sp.t0) < Math.abs(evT(a) - sp.t0) ? b : a).id : "-"}. The file is not used unless you select an event manually`, "quake.csv");
      if(!pick && timed.length && !cand.length){ const hh = []; for(let z = -12; z <= 14; z++) if(z !== num("tzOff", 0) && timed.some(e => e.t - z*3600 >= sp.t0 - 600 && e.t - z*3600 <= sp.t1)) hh.push(z); if(hh.length) evtLog("warn", "event", `an event would match if the quake.csv times were UTC${hh[0] >= 0 ? "+" : ""}${hh[0]} h: set the time-zone offset (hours ahead of UTC) if the file uses local time`, "quake.csv"); }
    } else if(E.events.length === 1){ pick = E.events[0]; why = "single event, no origin time in the file: identity not verifiable"; evtLog("warn", "event", "quake.csv has one event and no origin time: it is assumed to be the event of these records", "quake.csv"); }
    else evtLog("error", "event", `${E.events.length} events without origin times: select the event manually`, "quake.csv");
  }
  state.eventSel = pick;
  if(pick) evtLog("info", "event", `event “${pick.id}” (row ${pick.row}) selected: ${why}`, "quake.csv");
}
function setReference(){
  const H = headerEventParams(), E = state.eventSel || null, policy = els.evtPolicy.value, sp = recordSpan();
  const tol = {epi:num("tolEpi", 5), dep:num("tolDep", 5), mag:num("tolMag", 0.3), t:num("tolT", 5)};
  const R = {n:H.n, nOrigin:H.nOrigin, nMag:H.nMag, sources:{}, policy, csvEvent:E ? {id:E.id, row:E.row, file:state.eventCSV.name} : null, header:{lat:H.lat, lon:H.lon, depth:H.depth, mag:H.mag, origin:H.origin}, csv:E ? {lat:E.lat, lon:E.lon, depth:E.depth, mag:E.mag, origin:evT(E)} : null};
  const log = (lv, pa, m, so) => evtLog(lv, pa, m, so);
  for(const n of H.notes) log("warn", "header", n, "SAC header");
  /* decide(): header valid? CSV valid? compare; return "header" | "csv" | "none" */
  const decide = (param, hOK, cOK, diff, tolv, unit, hTxt, cTxt) => {
    if(!E || !cOK){ if(E && !cOK) log("warn", param, `quake.csv has no valid ${param}`, "quake.csv"); if(hOK){ log(E ? "warn" : "info", param, `${hTxt} from the SAC header${E ? " (not available in quake.csv)" : ""}`, "SAC header"); return "header"; } log("warn", param, `${param}: no valid value in the SAC headers${E ? " or quake.csv" : state.eventCSV ? " (quake.csv loaded, but no event matched these records)" : " (no quake.csv loaded)"}`, "none"); return "none"; }
    if(!hOK){ log("warn", param, `${param}: SAC header missing or invalid → quake.csv used (${cTxt})`, "quake.csv"); return "csv"; }
    const agree = diff <= tolv, d = `${diff.toFixed(unit === "s" ? 1 : 2)} ${unit}`;
    if(policy === "csv"){ log(agree ? "info" : "warn", param, `${param}: quake.csv used by policy (${cTxt}); header ${hTxt} differs by ${d}`, "quake.csv"); return "csv"; }
    if(policy === "header"){ log(agree ? "info" : "warn", param, `${param}: SAC header used by policy (${hTxt}); quake.csv ${cTxt} differs by ${d}`, "SAC header"); return "header"; }
    if(agree){ log("info", param, `${param}: SAC header ${hTxt} agrees with quake.csv ${cTxt} (difference ${d} ≤ ${tolv} ${unit})`, "SAC header (confirmed)"); return "header"; }
    log("warn", param, `${param}: SAC header ${hTxt} DISAGREES with quake.csv ${cTxt} by ${d} (> ${tolv} ${unit}) → quake.csv used`, "quake.csv"); return "csv";
  };
  const hE = H.valid.epi, cE = !!E && Number.isFinite(E.lat) && Number.isFinite(E.lon);
  const sE = decide("epicentre", hE, cE, hE && cE ? C.haversineKm(H.lat, H.lon, E.lat, E.lon) : NaN, tol.epi, "km", hE ? `${H.lat.toFixed(4)}°N ${H.lon.toFixed(4)}°E` : "", cE ? `${E.lat.toFixed(4)}°N ${E.lon.toFixed(4)}°E` : "");
  const sD = decide("depth", H.valid.depth, !!E && Number.isFinite(E.depth), Math.abs(H.depth - (E ? E.depth : NaN)), tol.dep, "km", `${fx(H.depth, 2)} km`, E ? `${fx(E.depth, 2)} km` : "");
  const sM = decide("magnitude", H.valid.mag, !!E && Number.isFinite(E.mag), Math.abs(H.mag - (E ? E.mag : NaN)), tol.mag, "units", `M ${fx(H.mag, 2)}`, E ? `M ${fx(E.mag, 2)}` : "");
  const sT = decide("origin time", H.valid.origin, !!E && Number.isFinite(E.t), Math.abs(H.origin - (E ? evT(E) : NaN)), tol.t, "s", Number.isFinite(H.origin) ? iso(H.origin) : "", E && Number.isFinite(E.t) ? iso(evT(E)) : "");
  const pickv = (so, hv, cv) => so === "header" ? hv : so === "csv" ? cv : NaN;
  R.lat = pickv(sE, H.lat, E && E.lat); R.lon = pickv(sE, H.lon, E && E.lon); R.depth = pickv(sD, H.depth, E && E.depth); R.mag = pickv(sM, H.mag, E && E.mag); R.origin = pickv(sT, H.origin, E && evT(E));
  R.sources = {epicentre:sE, depth:sD, magnitude:sM, origin:sT};
  // consistency of the chosen origin time with the picks and with the Wadati origin time (diagnostic only)
  if(sp && Number.isFinite(R.origin)){
    if(Number.isFinite(sp.firstP) && !(R.origin < sp.firstP)) log("error", "origin time", `origin time ${iso(R.origin)} is not before the first P pick: unreliable`, R.sources.origin);
    else if(Number.isFinite(sp.firstP) && sp.firstP - R.origin > 300) log("warn", "origin time", `first P arrives ${(sp.firstP - R.origin).toFixed(0)} s after the origin time: unusually long for a regional event`, R.sources.origin);
    const W = state.wadati; if(W && Math.abs(W.To - R.origin) > Math.max(5, 3*(W.seTo || 0))) log("warn", "origin time", `origin time differs from the Wadati origin time by ${(W.To - R.origin).toFixed(1)} s`, R.sources.origin);
  }
  const have = Number.isFinite(R.lat) && Number.isFinite(R.lon);
  state.reference = have || Number.isFinite(R.depth) || Number.isFinite(R.mag) || Number.isFinite(R.origin) ? R : null;
  if(!have) state.reference = state.reference ? state.reference : null;
  const tag = k => `[${R.sources[k] === "csv" ? "quake.csv" : R.sources[k] === "header" ? "header" : "none"}]`;
  els.refOut.textContent = !state.reference ? "not available (no valid SAC-header event parameters and no quake.csv event)"
    : `${have ? `${R.lat.toFixed(4)}°N ${R.lon.toFixed(4)}°E ${tag("epicentre")}` : "epicentre unknown"}, depth ${fx(R.depth, 2)} km ${tag("depth")}`
      + (Number.isFinite(R.origin) ? `; origin ${iso(R.origin).replace("T", " ").slice(0, 23)} UTC ${tag("origin")}` : "") + (Number.isFinite(R.mag) ? `; magnitude ${R.mag.toFixed(2)} ${tag("magnitude")}` : "");
  // the epicentre-less case must not feed the map/offset code
  if(state.reference && !have){ state.referencePartial = state.reference; state.reference = null; } else state.referencePartial = null;
  renderEventLog(); drawReference(); updateReferenceOffsets();
}
async function importEventCSV(file){
  const P = parseEventCSV(await file.text());
  state.eventCSV = {name:file.name, events:P.events, problems:P.problems}; state.eventManual = null;
  evtLog("info", "quake.csv", `${P.events.length} event(s) read from “${file.name}”` + (P.problems.length ? `; ${P.problems.length} problem(s)` : ""), "quake.csv");
  for(const q of P.problems) evtLog("warn", "quake.csv", q, "quake.csv");
  fillEventSelector(); matchEvent(); fillEventSelector(); setReference();
}
function fillEventSelector(){
  const E = state.eventCSV, sel = els.evtSel; sel.innerHTML = "";
  if(!E) return;
  const o0 = document.createElement("option"); o0.value = ""; o0.textContent = "(automatic match by origin time)"; sel.appendChild(o0);
  for(const e of E.events){ const o = document.createElement("option"); o.value = e.row; o.textContent = `${e.id} · ${Number.isFinite(e.t) ? iso(evT(e)).slice(0, 19) : "no time"} · ${fx(e.lat, 3)}, ${fx(e.lon, 3)} · ${fx(e.depth, 1)} km · M ${fx(e.mag, 1)}`; sel.appendChild(o); }
  sel.value = state.eventManual != null ? String(state.eventManual) : "";
}
function renderEventLog(){
  const L = state.eventLog || [];
  els.eventLogBox.innerHTML = L.slice(-40).map(e => `<div class="${e.level === "error" ? "bad" : e.level === "warn" ? "warn" : ""}"><span class="tag">${e.time.slice(11, 19)}</span> [${escapeHtml(e.param)}] ${escapeHtml(e.message)} <span class="tag">⟨${escapeHtml(e.source)}⟩</span></div>`).join("") || "-";
  const R = state.reference || state.referencePartial;
  els.eventSrcBox.textContent = R ? `epicentre ← ${R.sources.epicentre}, depth ← ${R.sources.depth}, magnitude ← ${R.sources.magnitude}, origin time ← ${R.sources.origin}` + (R.csvEvent ? `  (quake.csv event ${R.csvEvent.id})` : "") : "-";
}
function eventLogCSV(){
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return "time_utc,level,parameter,source,message\n" + (state.eventLog || []).map(e => [e.time, e.level, q(e.param), q(e.source), q(e.message)].join(",")).join("\n") + "\n";
}
/* optional: copies of the SAC files with EVLA, EVLO, EVDP (km) and MAG written from the resolved parameters; originals are untouched */
async function exportSACCopies(){
  const R = state.reference || state.referencePartial; if(!R){ alert("No resolved event parameters to write."); return; }
  const onlyCsv = els.sacCopyMode.value === "csv", files = []; let n = 0;
  for(const c of state.order) for(const tr of Object.values(state.stations[c].comps)){
    const buf = tr.rawBuf.slice(0), dv = new DataView(buf), set = (word, v) => dv.setFloat32(word*4, v, tr.le);
    const w = (so, word, v) => { if(Number.isFinite(v) && (so === "csv" || !onlyCsv)){ set(word, v); n++; } };
    w(R.sources.epicentre, 35, R.lat); w(R.sources.epicentre, 36, R.lon); w(R.sources.depth, 38, R.depth); w(R.sources.magnitude, 39, R.mag);
    files.push({name:tr.file.replace(/(\.sac)?$/i, "") + ".event.SAC", data:new Uint8Array(buf)});
  }
  files.push({name:"README.txt", data:`SAC copies written by EQLocate ${APP_VERSION} on ${new Date().toISOString()}.\nOnly EVLA, EVLO, EVDP (km) and MAG were changed (${onlyCsv ? "parameters taken from quake.csv only" : "all resolved parameters"}); waveform data and all other header words are byte-identical to the originals.\nSources: ${JSON.stringify(R.sources)}\n`});
  files.push({name:"event_log.csv", data:eventLogCSV()});
  const blob = await FigKit.zip(files); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "sac_copies_with_event_parameters.zip"; a.click();
  evtLog("info", "sac copies", `${files.length - 2} SAC copies written (${n} header words changed); originals untouched`, "export");
  renderEventLog();
}
function updateReferenceOffsets(){
  const r = state.reference;
  if(!r){ els.refOffOut.textContent = "-"; return; }
  const parts = [];
  if(state.chord) parts.push(`three-circle ${C.haversineKm(r.lat, r.lon, state.chord.sol.epi.lat, state.chord.sol.epi.lon).toFixed(2)} km, Δh ${(state.chord.sol.depth - r.depth).toFixed(2)} km`);
  if(state.joint) parts.push(`joint ${C.haversineKm(r.lat, r.lon, state.joint.epi.lat, state.joint.epi.lon).toFixed(2)} km, Δh ${(state.joint.m[2] - r.depth).toFixed(2)} km`);
  els.refOffOut.textContent = parts.join(" · ") || "-";
}

/* ---------- Load SAC files ---------- */
async function loadSACFiles(files){
  state.stations = {}; state.order = []; state.picks = {}; state.use = {};
  state.current = null; state.wadati = null; state.chord = null; state.joint = null;
  resetOutputs();
  const useHdr = els.useHeaderPicks.checked, errors = [];
  let nFiles = 0;
  for(const f of files){
    try{
      const rawBuf = await f.arrayBuffer(), h = C.readSAC(rawBuf, f.name);
      nFiles++;
      const code = h.station || f.name.replace(/\.[^.]*$/, "");
      if(!state.stations[code]){
        state.stations[code] = {code, lat:h.lat, lon:h.lon, elev_m:h.elev_m, coordSource:h.stCoordOK ? "header" : "missing", comps:{}, comp:null, rawPicks:[], warnings:[],
          ref:{lat:h.evla, lon:h.evlo, depth:Number.isFinite(h.evdp) ? (h.evdp > 1000 ? h.evdp/1000 : h.evdp) : NaN,
               origin:NaN, mag:h.mag}};
        state.order.push(code); state.picks[code] = {p:NaN, s:NaN}; state.use[code] = true;
      }
      const st = state.stations[code];
      if(!Number.isFinite(st.lat) && h.stCoordOK){ st.lat = h.lat; st.lon = h.lon; st.elev_m = h.elev_m; st.coordSource = "header"; }
      // event origin time: only when it falls inside the record span (an O of -1.7e6 s, as in some converted files, is not an origin time)
      const oAbs = Number.isFinite(h.o) && Number.isFinite(h.ref_epoch) ? h.ref_epoch + h.o : NaN, tEnd = h.start_epoch + (h.npts - 1)*h.delta;
      if(Number.isFinite(oAbs)){
        if(oAbs >= h.start_epoch - 3600 && oAbs <= tEnd) st.ref.origin = oAbs;
        else if(!st.warnings.some(w => w.startsWith("header origin time O"))) st.warnings.push("header origin time O lies far outside the record span (it is not an origin time): ignored");
      }
      for(const w of h.warnings) if(!st.warnings.includes(w)) st.warnings.push(w);
      let comp = h.component || "?";
      while(st.comps[comp]) comp += "'";
      st.comps[comp] = {file:f.name, delta:h.delta, npts:h.npts, start_epoch:h.start_epoch, data:h.data, rawBuf, le:h.byteOrder === "little"};
      st.rawPicks.push({file:f.name, comp, ref_epoch:h.ref_epoch, start_epoch:h.start_epoch, b:h.b, end_rel:h.b + (h.npts - 1)*h.delta,
        picks:C.listHeaderPicks(h).map(q => ({...q, abs:h.ref_epoch + q.rel}))});
      if(!st.comp || /Z$/i.test(comp)) st.comp = comp;
      if(useHdr){
        const hp = C.headerPicks(h), pk = state.picks[code];
        // prefer P from the vertical and S from a horizontal component
        if(Number.isFinite(hp.p) && (!Number.isFinite(pk.p) || /Z$/i.test(comp))){ pk.p = h.start_epoch + hp.p; pk.pSrc = hp.pSrc; pk.pFile = f.name; }
        if(Number.isFinite(hp.s) && (!Number.isFinite(pk.s) || /[NE12]$/i.test(comp))){ pk.s = h.start_epoch + hp.s; pk.sSrc = hp.sSrc; pk.sFile = f.name; }
      }
    } catch(e){
      errors.push(`${f.name}: ${e.message || e}`);
    }
  }
  state.order.sort();
  // header picks as read: kept for the integrity report and "restore header picks"
  state.headerPicks = {}; for(const c of state.order){ const q = state.picks[c]; state.headerPicks[c] = {p:q.p, s:q.s, pSrc:q.pSrc, sSrc:q.sSrc}; }
  const nPS = state.order.filter(hasPS).length, nC = state.order.filter(hasCoords).length;
  els.loadStatus.innerHTML = `${nFiles} file(s), ${state.order.length} station(s), ${nPS} with P and S picks, ${nC} with coordinates.`
    + (nPS && nC < state.order.length ? `<br/><span class="warn">⚠ ${state.order.length - nC} station(s) without coordinates (${state.order.filter(c => !hasCoords(c)).join(", ")}): the picks are kept and the Wadati regression works; location methods need a station table (section 1).</span>` : "")
    + (errors.length ? `<br/><span class="bad">${errors.length} file(s) skipped:</span> ${escapeHtml(errors.slice(0,5).join("; "))}${errors.length > 5 ? " …" : ""}` : "");
  if(state.order.length) state.current = state.order[0];
  state.jointExcluded = new Set();
  renderStationList(); renderCompSel(); renderPicks(); renderTriChecks(); renderJointChecks();
  waveCtxInfo = null; wadatiCtxInfo = null;
  resetViewToCurrent(); drawWave();
  if(nPS >= 3) computeWadati(true); else drawWadati();
  initMapIfNeeded(); updateMapStations(true);
  state.eventLog = (state.eventLog || []).filter(e => e.param === "quake.csv");
  matchEvent(); fillEventSelector(); setReference();
  runPickDiagnostics();
}
function resetOutputs(){
  for(const id of ["vpvsOut","originTime","wadFitOut","epiOut","depthOut","sphereOut","geomOut","fpOut","njOut","epiJointOut","depthJointOut","toJointOut","vpJointOut","rmsJointOut","ellJointOut","bayesOut"]) $(id).textContent = "-";
  for(const id of ["wadFlagOut","jointWarn"]) $(id).textContent = "";
  els.depthTable.innerHTML = ""; els.residTableJoint.innerHTML = ""; els.sensTable.innerHTML = "";
  state.posterior = null; state.bayes = null; state.sensitivity = null;
  depthCtxInfo = null; drawDepthPanel();
  if(state.map) clearSolveLayers();
}

/* ---------- Station table (coordinates supplied by the user when the SAC headers have none) ---------- */
function parseStationTable(text){
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if(!lines.length) return {rows:[], problems:["empty file"]};
  const split = l => l.split(l.includes("\t") ? "\t" : l.includes(";") ? ";" : l.includes(",") ? "," : /\s+/).map(x => x.trim());
  let head = split(lines[0]).map(x => x.toLowerCase()), hasHead = head.some(x => /^(code|station|sta|name|lat|latitude)$/.test(x));
  let iC = 0, iLa = 1, iLo = 2, iEl = 3, elScale = 1;
  if(hasHead){
    const find = (...names) => head.findIndex(x => names.includes(x));
    iC = find("code", "station", "sta", "name", "kstnm"); iLa = find("lat", "latitude", "stla"); iLo = find("lon", "lng", "longitude", "stlo"); iEl = find("elev_m", "elev", "elevation", "stel", "elev_km");
    if(head[iEl] === "elev_km") elScale = 1000;
  }
  const rows = [], problems = [];
  lines.slice(hasHead ? 1 : 0).forEach((l, k) => {
    const c = split(l); let code = (c[iC] || "").replace(/^[A-Za-z0-9]{1,2}\./, m => m);     // keep as is; matching strips a network prefix
    const lat = Number(c[iLa]), lon = Number(c[iLo]), el = iEl >= 0 && c[iEl] !== undefined && c[iEl] !== "" ? Number(c[iEl])*elScale : NaN;
    if(!code || !Number.isFinite(lat) || !Number.isFinite(lon)) { problems.push(`line ${k + 1 + (hasHead ? 1 : 0)}: not a station row (${l.slice(0, 40)})`); return; }
    if(Math.abs(lat) > 90 || Math.abs(lon) > 360){ problems.push(`${code}: coordinates out of range (${lat}, ${lon})`); return; }
    if(lat === 0 && lon === 0){ problems.push(`${code}: 0, 0 is not accepted as a station position`); return; }
    rows.push({code, lat, lon, elev_m:el});
  });
  return {rows, problems};
}
async function importStationTable(file){
  const {rows, problems} = parseStationTable(await file.text());
  const norm = s => String(s).toUpperCase().replace(/^[A-Z0-9]{1,2}\./, ""), byCode = Object.fromEntries(state.order.map(c => [norm(c), c]));
  const over = els.metaOverride.checked, matched = [], unmatched = [], kept = [], seen = new Set();
  for(const r of rows){
    const c = byCode[norm(r.code)];
    if(seen.has(norm(r.code))){ problems.push(`${r.code}: duplicate row ignored`); continue; } seen.add(norm(r.code));
    if(!c){ unmatched.push(r.code); continue; }
    const s = state.stations[c];
    if(hasCoords(c) && s.coordSource === "header" && !over){ kept.push(c); continue; }
    s.lat = r.lat; s.lon = r.lon; if(Number.isFinite(r.elev_m)) s.elev_m = r.elev_m; s.coordSource = "table"; matched.push(c);
  }
  const still = state.order.filter(c => !hasCoords(c));
  els.metaStatus.innerHTML = `${matched.length} station(s) updated from “${escapeHtml(file.name)}”${matched.length ? " (" + matched.join(", ") + ")" : ""}`
    + (kept.length ? `; ${kept.length} kept their header coordinates (tick “table overrides header” to replace them)` : "")
    + (unmatched.length ? `<br/><span class="warn">rows without a matching station: ${escapeHtml(unmatched.join(", "))}</span>` : "")
    + (still.length ? `<br/><span class="warn">still without coordinates: ${still.join(", ")}</span>` : "")
    + (problems.length ? `<br/><span class="bad">${problems.length} problem(s): ${escapeHtml(problems.slice(0, 4).join("; "))}</span>` : "");
  state.stationTableName = file.name;
  renderStationList(); renderPicks(); renderTriChecks(); state.jointExcluded = new Set(); renderJointChecks(); updateMapStations(true); setReference(); computeWadati(true); runPickDiagnostics();
}
function exportStationTemplate(){
  const rows = ["code,lat,lon,elev_m"];
  for(const c of state.order){ const s = state.stations[c]; rows.push([c, Number.isFinite(s.lat) ? s.lat : "", Number.isFinite(s.lon) ? s.lon : "", Number.isFinite(s.elev_m) ? s.elev_m : ""].join(",")); }
  download("eq_location_station_table.csv", rows.join("\n") + "\n", "text/csv");
}

/* ---------- Pick audit: what was read, from where, and whether it is consistent (nothing is modified) ---------- */
function runPickDiagnostics(){
  const A = {stations:[], messages:[], created:new Date().toISOString()};
  const sec = (a, b) => b - a;
  for(const c of state.order){
    const st = state.stations[c], pk = state.picks[c] || {}, hdr = (state.headerPicks && state.headerPicks[c]) || {};
    const e = {code:c, comps:Object.keys(st.comps).join(" "), coordSource:st.coordSource, hasCoords:hasCoords(c), P:pk.p, S:pk.s, pSrc:pk.pSrc || "", sSrc:pk.sSrc || "", pFile:pk.pFile || "", sFile:pk.sFile || "",
      edited:(Number.isFinite(pk.p) && pk.p !== hdr.p) || (Number.isFinite(pk.s) && pk.s !== hdr.s) || (Number.isFinite(hdr.p) !== Number.isFinite(pk.p)) || (Number.isFinite(hdr.s) !== Number.isFinite(pk.s)),
      perFile:[], flags:[], warnings:st.warnings || []};
    const Ps = [], Ss = [];
    for(const rp of st.rawPicks){
      const P = rp.picks.find(q => q.phase === "P"), S = rp.picks.find(q => q.phase === "S"), unl = rp.picks.filter(q => q.phase === "?");
      e.perFile.push({file:rp.file, comp:rp.comp, P:P ? P.abs : NaN, Pfield:P ? P.field + ":" + P.label : "", S:S ? S.abs : NaN, Sfield:S ? S.field + ":" + S.label : "",
        Pin:!!P && P.rel >= rp.b && P.rel <= rp.end_rel, Sin:!!S && S.rel >= rp.b && S.rel <= rp.end_rel, unlabelled:unl.map(q => q.field + ":" + (q.label || "?"))});
      if(P) Ps.push(P.abs); if(S) Ss.push(S.abs);
      if(unl.length) e.flags.push(`unlabelled header pick(s) ${unl.map(q => q.field).join(", ")} in ${rp.file}`);
    }
    e.Pspread = Ps.length > 1 ? Math.max(...Ps) - Math.min(...Ps) : 0; e.Sspread = Ss.length > 1 ? Math.max(...Ss) - Math.min(...Ss) : 0;
    if(Number.isFinite(pk.p) && Number.isFinite(pk.s)){ e.SP = pk.s - pk.p; if(!(e.SP > 0)) e.flags.push("S is not after P"); }
    if(!Number.isFinite(pk.p)) e.flags.push("no P pick"); if(!Number.isFinite(pk.s)) e.flags.push("no S pick");
    if(e.Pspread > 0.01 || e.Sspread > 0.01) e.flags.push(`header picks differ between components (P ${e.Pspread.toFixed(3)} s, S ${e.Sspread.toFixed(3)} s)`);
    if(e.perFile.some(f => (Number.isFinite(f.P) && !f.Pin) || (Number.isFinite(f.S) && !f.Sin))) e.flags.push("a header pick lies outside its record");
    // onset checks on the waveforms (P: vertical; S: horizontals when present)
    const zc = Object.keys(st.comps).find(k => /Z$/i.test(k)) || Object.keys(st.comps)[0], hc = Object.keys(st.comps).filter(k => !/Z$/i.test(k));
    const chk = (comp, t) => { const tr = st.comps[comp]; return tr && Number.isFinite(t) ? C.onsetCheck(tr.data, tr.delta, t - tr.start_epoch) : null; };
    e.onsetP = chk(zc, pk.p); const sc = (hc.length ? hc : [zc]).map(k => chk(k, pk.s)).filter(Boolean);
    e.onsetS = sc.length ? {ok:sc.every(q => q.ok), ratio:Math.min(...sc.map(q => q.ratio)), note:sc.map(q => q.note).filter(Boolean)[0] || ""} : null;
    if(e.onsetP && e.onsetP.ok && e.onsetP.ratio < 2) e.flags.push(`weak P onset (energy ratio ${e.onsetP.ratio.toFixed(1)} < 2)`);
    if(e.onsetP && !e.onsetP.ok) e.flags.push(`P onset not testable: ${e.onsetP.note}`);
    if(e.onsetS && e.onsetS.ok && e.onsetS.ratio < 1.5) e.flags.push(`weak S onset (energy ratio ${e.onsetS.ratio.toFixed(1)} < 1.5)`);
    if(!e.hasCoords) e.flags.push("no station coordinates (location methods unavailable)");
    e.status = e.flags.some(f => /no P|no S|not after|outside|differ/.test(f)) ? "FAIL" : e.flags.length ? "WARN" : "OK";
    A.stations.push(e);
  }
  const nPS = state.order.filter(hasPS).length;
  A.messages.push(`${state.order.length} station(s), ${nPS} with P and S picks, ${state.order.filter(hasCoords).length} with coordinates.`);
  const blk = locationBlocker(); if(blk) A.messages.push(blk);
  const w = [...new Set(state.order.flatMap(c => state.stations[c].warnings || []))]; for(const x of w) A.messages.push("Header: " + x + ".");
  A.wadati = null;
  if(nPS >= 2){ const cs = timingCodes().filter(hasPS); if(cs.length >= 2){ const W = C.wadatiFit(cs.map(c => state.picks[c].p), cs.map(c => state.picks[c].s), "dt", {}); if(W.ok) A.wadati = {n:W.n, kappa:W.kappa, se:W.seKappa, To:W.To, rms:W.rms, loo:Object.fromEntries(cs.map((c, i) => [c, W.loo[i]])), flagged:cs.filter((c, i) => W.outlier[i])}; } }
  state.pickAudit = A;
  renderPickAudit();
  return A;
}
function renderPickAudit(){
  const A = state.pickAudit; if(!A) return;
  const f3 = v => Number.isFinite(v) ? v.toFixed(3) : "-", tm = v => Number.isFinite(v) ? hhmmss_msec_utc(v) : "-";
  els.pickMsgs.innerHTML = A.messages.map(m => `<div class="out ${/missing|undefined|invalid|ignored|treated|without/.test(m) ? "warn" : ""}">${escapeHtml(m)}</div>`).join("")
    + (A.wadati ? `<div class="out">Wadati from the picks alone: Vp/Vs = <span class="mono">${A.wadati.kappa.toFixed(3)} ± ${A.wadati.se.toFixed(3)}</span>, T<sub>0</sub> = <span class="mono">${hhmmss_msec_utc(A.wadati.To)}</span>, RMS ${(A.wadati.rms*1000).toFixed(0)} ms (n = ${A.wadati.n})${A.wadati.flagged.length ? ", flagged: " + A.wadati.flagged.join(", ") : ""}</div>` : "");
  els.pickAuditTable.innerHTML = A.stations.map(e => `<tr><td class="mono">${escapeHtml(e.code)}</td><td class="tag">${escapeHtml(e.comps)}</td><td class="mono">${tm(e.P)}</td><td class="mono">${tm(e.S)}</td><td class="mono">${f3(e.SP)}</td>`
    + `<td class="tag">${escapeHtml(e.pSrc)}/${escapeHtml(e.sSrc)}</td><td class="mono">${e.onsetP && e.onsetP.ok ? e.onsetP.ratio.toFixed(0) : "-"}/${e.onsetS && e.onsetS.ok ? e.onsetS.ratio.toFixed(1) : "-"}</td>`
    + `<td class="${e.status === "OK" ? "" : e.status === "FAIL" ? "bad" : "warn"}">${e.status}${e.edited ? " (edited)" : ""}</td><td class="flag">${escapeHtml(e.flags.join("; "))}</td></tr>`).join("");
  drawPickFigure();
}
function pickAuditCSV(){
  const A = state.pickAudit || runPickDiagnostics(), q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = ["station,components,coord_source,P_utc,S_utc,S_minus_P_s,P_field,S_field,P_file,S_file,P_spread_components_s,S_spread_components_s,onset_ratio_P,onset_ratio_S,status,edited,flags"];
  for(const e of A.stations) rows.push([q(e.code), q(e.comps), e.coordSource, iso(e.P) || "", iso(e.S) || "", Number.isFinite(e.SP) ? e.SP.toFixed(4) : "", e.pSrc, e.sSrc, q(e.pFile), q(e.sFile),
    e.Pspread.toFixed(4), e.Sspread.toFixed(4), e.onsetP && e.onsetP.ok ? e.onsetP.ratio.toFixed(2) : "", e.onsetS && e.onsetS.ok ? e.onsetS.ratio.toFixed(2) : "", e.status, e.edited, q(e.flags.join("; "))].join(","));
  return rows.join("\n") + "\n";
}
function restoreHeaderPicks(){
  if(!state.headerPicks) return;
  for(const c of state.order){ const h = state.headerPicks[c]; state.picks[c] = {...state.picks[c], p:h.p, s:h.s, pSrc:h.pSrc, sSrc:h.sSrc}; }
  renderPicks(); computeWadati(true); drawWave(); drawWadati(); runPickDiagnostics();
}
/* figure: vertical (or first) component of every station around the picks, time after the station's P pick; picks are drawn as read */
function pickFigureSVG(){
  const FK = FigKit, A = state.pickAudit; if(!A || !A.stations.length) return "";
  const list = A.stations.filter(e => Number.isFinite(e.P)).sort((a, b) => (a.SP ?? 1e9) - (b.SP ?? 1e9)), n = list.length; if(!n) return "";
  const W = 760, rowH = 74, H = 56 + rowH*n + 20, F = new FK.Figure(W, H), hiAll = Math.max(...list.map(e => Number.isFinite(e.S) ? (e.S - e.P) + 3 : 8));   // one common time window for all panels
  F.text(W/2, 18, "Phase picks read from the SAC headers (unchanged) on the first vertical component of each station", {anchor:"middle", size:12, bold:true});
  list.forEach((e, k) => {
    const st = state.stations[e.code], comp = Object.keys(st.comps).find(q => /Z$/i.test(q)) || Object.keys(st.comps)[0], tr = st.comps[comp];
    const t0 = e.P, lo = -1.2, hi = hiAll, i0 = Math.max(0, Math.floor((t0 + lo - tr.start_epoch)/tr.delta)), i1 = Math.min(tr.data.length - 1, Math.ceil((t0 + hi - tr.start_epoch)/tr.delta));
    const xs = [], ys = []; let m = 0, mx = 0; for(let i = i0; i <= i1; i++) m += tr.data[i]; m /= Math.max(1, i1 - i0 + 1);
    for(let i = i0; i <= i1; i++){ xs.push(tr.start_epoch + i*tr.delta - t0); const v = tr.data[i] - m; ys.push(v); if(Math.abs(v) > mx) mx = Math.abs(v); }
    const pan = F.panel(70, 44 + k*rowH, W - 100, rowH - 18, {xlim:[lo, hi], ylim:[-1.05, 1.05], xticks:k === n - 1 ? undefined : [], yticks:[], grid:false, xlabel:k === n - 1 ? "time after the P pick (s)" : undefined});
    pan.line(xs, ys.map(v => v/(mx || 1)), {color:"#111", width:0.7});
    pan.vline(0, {color:FK.PAL.P, width:1.6});
    if(Number.isFinite(e.S)) pan.vline(e.S - e.P, {color:FK.PAL.S, width:1.6});
    F.text(70, 44 + k*rowH - 4, `${e.code} ${comp}   S−P = ${Number.isFinite(e.SP) ? e.SP.toFixed(2) : "-"} s   ${e.status}${e.flags.length ? " — " + e.flags.slice(0, 2).join("; ").slice(0, 90) : ""}`, {size:9, bold:true});
  });
  return F.svg();
}
function drawPickFigure(){
  const svg = pickFigureSVG(); state.pickFigSVG = svg;
  els.pickFig.innerHTML = svg ? `<div class="figimg">${svg}</div>` : '<div class="small">No picks to display.</div>';
}

/* ---------- Export / import ---------- */
function download(name, text, type){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function iso(t){ return Number.isFinite(t) ? new Date(Math.round(t*1000)).toISOString() : null; }
function settings(){
  const ids = ["vpEstMode","vpRegIn","clockMode","wadMethod","vpIn","vpvsIn","sigPIn","sigSIn","sigVpIn","mcIn","seedIn","vpSource","vpMode","kappaMode","bayesIter","filterSel","fminIn","fmaxIn","polesSel"];
  const chk = ["wadRobust","useElev","useHuber","jointMC","useHeaderPicks","showAllComp","exclFlagged","usePrior","useBayes"];
  const o = {}; ids.forEach(i => o[i] = $(i).value); chk.forEach(i => o[i] = $(i).checked); o.chordStations = chordCodes();
  o.jointStations = jointCodes(); o.jointExcluded = [...state.jointExcluded];
  return o;
}
function exportSession(){ download("eq_location_session.json", sessionJSON(), "application/json"); }
function sessionJSON(){
  const stations = {};
  for(const c of state.order){
    const s = state.stations[c], p = state.picks[c], hp = (state.headerPicks && state.headerPicks[c]) || {};
    stations[c] = {lat:s.lat, lon:s.lon, elev_m:s.elev_m, coordSource:s.coordSource, use:!!state.use[c], files:Object.values(s.comps).map(t => t.file),
      P:p.p, S:p.s, P_iso:iso(p.p), S_iso:iso(p.s), P_source:p.pSrc || null, S_source:p.sSrc || null, P_header:hp.p ?? null, S_header:hp.s ?? null,
      P_edited:Number.isFinite(p.p) && p.p !== hp.p, S_edited:Number.isFinite(p.s) && p.s !== hp.s};
  }
  const W = state.wadati;
  const out = {app:"EQLocate", author:"Ali Attia", version:APP_VERSION, exported:new Date().toISOString(), settings:settings(), stations,
    reference:state.reference,
    wadati:W ? {method:W.method, robust:W.robust, n:W.n, VpVs:W.kappa, se_VpVs:W.seKappa, To:W.To, To_iso:iso(W.To), se_To:W.seTo, rms:W.rms, flagged:W.flagged} : null,
    threeCircle:state.chord, joint:state.joint ? {...state.joint, To:state.joint.m[3] + state.joint.tref, To_iso:iso(state.joint.m[3] + state.joint.tref)} : null,
    pickAudit:state.pickAudit, stationTable:state.stationTableName || null, eventParameters:state.reference || state.referencePartial || null, eventLog:state.eventLog || [], eventCSV:state.eventCSV ? {name:state.eventCSV.name, selected:state.eventSel ? state.eventSel.row : null} : null,
    bayes:state.bayes, posteriorSamples:state.posterior ? state.posterior.samples.filter((_,i) => i % 2 === 0) : null,
    sensitivity:state.sensitivity, timings_ms:timings, userAgent:navigator.userAgent};
  return JSON.stringify(out, (k,v) => (typeof v === "number" && !Number.isFinite(v)) ? null : v, 2);
}
function exportCSV(){
  const rows = ["station,lat,lon,elev_m,use,P_epoch,S_epoch,P_iso,S_iso,S_minus_P"];
  for(const c of state.order){
    const s = state.stations[c], p = state.picks[c];
    rows.push([c, s.lat, s.lon, s.elev_m, state.use[c] ? 1 : 0, fx(p.p,4), fx(p.s,4), iso(p.p) || "", iso(p.s) || "", hasPS(c) ? (p.s-p.p).toFixed(4) : ""].join(","));
  }
  download("eq_location_picks.csv", rows.join("\n"), "text/csv");
}
async function importSession(file){
  try{
    const o = JSON.parse(await file.text());
    let n = 0;
    for(const [c, v] of Object.entries(o.stations || {})){
      if(!state.stations[c]) continue;
      if(!hasCoords(c) && Number.isFinite(v.lat) && Number.isFinite(v.lon)){ const s = state.stations[c]; s.lat = v.lat; s.lon = v.lon; if(Number.isFinite(v.elev_m)) s.elev_m = v.elev_m; s.coordSource = v.coordSource || "session"; }
      state.picks[c] = {p:Number.isFinite(v.P) ? v.P : NaN, s:Number.isFinite(v.S) ? v.S : NaN, pSrc:"import", sSrc:"import"};
      if(typeof v.use === "boolean") state.use[c] = v.use;
      n++;
    }
    const st = o.settings || {};
    for(const [k, v] of Object.entries(st)){
      const el = $(k); if(!el) continue;
      if(el.type === "checkbox") el.checked = !!v; else if(!["chordStations", "jointStations", "jointExcluded"].includes(k)) el.value = v;
    }
    state.jointExcluded = new Set(Array.isArray(st.jointExcluded) ? st.jointExcluded : []);
    renderPicks(); renderTriChecks(); renderJointChecks();
    if(Array.isArray(st.chordStations)) for(const cb of els.triChecks.querySelectorAll("input")) cb.checked = st.chordStations.includes(cb.dataset.code);
    computeWadati(true); updateMapStations(false); drawWave(); renderStationList(); renderJointChecks(); runPickDiagnostics();
    alert(`Imported picks for ${n} station(s).`);
  } catch(e){ alert("Import failed: " + e.message); }
}

/* ---------- Buttons ---------- */
els.btnPickP.onclick = () => setPickMode("P");
els.btnPickS.onclick = () => setPickMode("S");
els.btnWadati.onclick = () => computeWadati(false);
els.eventCSVInput.onchange = ev => { if(ev.target.files[0]) importEventCSV(ev.target.files[0]); ev.target.value = ""; };
els.evtSel.onchange = () => { state.eventManual = els.evtSel.value === "" ? null : Number(els.evtSel.value); if(state.eventManual == null) state.eventSel = null; matchEvent(); setReference(); };
for(const id of ["evtPolicy", "tolEpi", "tolDep", "tolMag", "tolT", "tzOff"]) $(id).addEventListener("change", () => { if(id === "tzOff" && state.eventManual == null) matchEvent(); setReference(); });
els.btnEventLogCSV.onclick = () => download("eq_location_event_log.csv", eventLogCSV(), "text/csv");
els.btnEventLogJSON.onclick = () => download("eq_location_event_log.json", JSON.stringify({sources:(state.reference || state.referencePartial || {}).sources || null, parameters:state.reference || state.referencePartial || null, log:state.eventLog || []}, (k, v) => (typeof v === "number" && !Number.isFinite(v)) ? null : v, 2), "application/json");
els.btnSACCopies.onclick = () => exportSACCopies();
els.stationMetaInput.onchange = ev => { if(ev.target.files[0]) importStationTable(ev.target.files[0]); ev.target.value = ""; };
els.btnStationTemplate.onclick = () => exportStationTemplate();
els.btnPickCSV.onclick = () => download("eq_location_pick_report.csv", pickAuditCSV(), "text/csv");
els.btnPickJSON.onclick = () => download("eq_location_pick_report.json", JSON.stringify(state.pickAudit || runPickDiagnostics(), (k, v) => (typeof v === "number" && !Number.isFinite(v)) ? null : v, 2), "application/json");
els.btnPickSVG.onclick = () => { if(state.pickFigSVG) download("eq_location_picks_overview.svg", state.pickFigSVG, "image/svg+xml"); };
els.btnPickPNG.onclick = async () => { if(state.pickFigSVG){ const b = await FigKit.svgToPng(state.pickFigSVG, 4); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "eq_location_picks_overview.png"; a.click(); } };
els.btnPickRestore.onclick = () => restoreHeaderPicks();
els.btnSolve.onclick = () => solveChord();
els.btnFixedPoint.onclick = () => fixedPointCheck();
els.btnSolveJoint.onclick = () => solveJoint();
els.btnExport.onclick = () => exportSession();
els.btnExportCSV.onclick = () => exportCSV();
els.importInput.onchange = ev => { if(ev.target.files[0]) importSession(ev.target.files[0]); ev.target.value = ""; };
els.compSel.onchange = () => { const s = state.stations[state.current]; if(s){ s.comp = els.compSel.value; resetViewToCurrent(); drawWave(); } };
els.btnEstVp.onclick = () => ensureVpEstimate(true);
els.vpEstMode.addEventListener("change", () => ensureVpEstimate());
els.vpRegIn.addEventListener("change", () => ensureVpEstimate());
els.vpvsIn.addEventListener("input", () => { state.kappaAuto = false; });
els.btnJointAll.onclick = () => setAllJoint(true);
els.btnJointNone.onclick = () => setAllJoint(false);
for(const id of ["filterSel","fminIn","fmaxIn","polesSel","showAllComp"]) $(id).addEventListener("change", () => { drawWave(); });
els.btnSens.onclick = () => runSensitivity();
els.btnClearStation.onclick = () => {
  if(!state.current) return;
  state.picks[state.current] = {p:NaN, s:NaN};
  renderPicks(); updateMapStations(false); drawWave(); drawWadati();
};
els.btnClearAll.onclick = () => {
  if(!confirm("Clear all picks?")) return;
  for(const c of state.order) state.picks[c] = {p:NaN, s:NaN};
  state.wadati = null; state.chord = null; state.joint = null;
  resetOutputs(); renderPicks(); drawWave(); drawWadati(); updateMapStations(false);
};
els.btnLoad.onclick = async () => {
  const files = [...(els.fileInput.files || []), ...(els.dirInput.files || [])];
  if(!files.length) return alert("Select SAC files or a folder first.");
  const t0 = performance.now();
  await loadSACFiles(files);
  timings["load " + files.length + " files"] = performance.now() - t0;
  timed("Wadati", () => state.wadati ? computeWadati(true) : null);
};

/* ---------- init / resize ---------- */
function handleResize(){
  waveCtxInfo = null; wadatiCtxInfo = null; depthCtxInfo = null;
  drawWave(); drawWadati(); drawDepthPanel();
  if(state.map){
    state.map.invalidateSize(false);
    if(state.pendingBounds && state.map.getContainer().offsetWidth > 0) fitMap(state.pendingBounds);
  }
}
/* theme switch: re-read the palette and redraw every canvas and map symbol */
function applyTheme(){
  refreshTheme(); handleResize();
  if(state.baseLayers.offline && state.baseLayers.offline.restyle) state.baseLayers.offline.restyle();
  if(state.map){ updateMapStations(false); drawReference(); }
}
window.addEventListener("resize", handleResize);
drawWave();
drawWadati();
drawDepthPanel();
initMapIfNeeded();

/* ---------- Case study: run every solver and build the publication figures ---------- */
const KM_DEG = Math.PI/180*C.R_EARTH;
function jointInputFor(codes){
  const sts = codes.map(c => state.stations[c]), c0 = C.centroid(sts), useElev = els.useElev.checked;
  const xy = sts.map(s => ({...C.equirectXY(s.lat, s.lon, c0.lat, c0.lon), z:useElev && Number.isFinite(s.elev_m) ? s.elev_m/1000 : 0}));
  const tp = codes.map(c => state.picks[c].p), ts = codes.map(c => state.picks[c].s);
  const tref = Math.floor(Math.min(...tp.filter(Number.isFinite))) - 1;
  const ps = codes.filter(hasPS);
  const W = C.wadatiFit(ps.map(c => state.picks[c].p), ps.map(c => state.picks[c].s), els.wadMethod.value, {robust:els.wadRobust.checked});
  const inp = {xy, tp:tp.map(t => t - tref), ts:ts.map(t => t - tref), kappa:W.ok ? W.kappa : num("vpvsIn", 1.73),
               solveVp:els.vpMode.value === "free", Vp:num("vpIn", 6), solveKappa:els.kappaMode.value === "free", huber:els.useHuber.checked,
               sigP:num("sigPIn", 0.05), sigS:num("sigSIn", 0.1), m0:[0, 0, 10, (W.ok ? W.To : Math.min(...tp)) - tref, num("vpIn", 6)]};
  if(W.ok) inp.kappaFromWadati = {tp:inp.tp, ts:inp.ts, method:els.wadMethod.value, robust:els.wadRobust.checked};
  if(els.usePrior.checked) inp.prior = {Vp:[num("vpRegIn", 6), 0.5], kappa:[inp.kappa, 0.1]};
  return {codes, sts, c0, tref, W, inp, ps};
}
/* origin time of a geometric (S−P based) solution: mean of tP − Dhyp/Vp over the stations, station clock terms applied; sT is the standard error of the mean */
function geomOrigin(lat, lon, depthSL, Vp, codes, clk){
  const useElev = els.useElev.checked, v = [];
  for(const c of codes){
    const st = state.stations[c], p = state.picks[c]; if(!st || !p || !Number.isFinite(p.p)) continue;
    const r = C.haversineKm(lat, lon, st.lat, st.lon), z = useElev && Number.isFinite(st.elev_m) ? st.elev_m/1000 : 0;
    v.push(p.p - ((clk && clk[c]) || 0) - Math.hypot(r, depthSL + z)/Vp);
  }
  if(!v.length) return {To:NaN, sT:NaN};
  const m = v.reduce((a, b) => a + b, 0)/v.length, sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m)**2, 0)/(v.length - 1)) : NaN;
  return {To:m, sT:sd/Math.sqrt(v.length)};
}
function solutionRecord(name, J, ji, extra){
  const ll = C.xyToLatLon(J.m[0], J.m[1], ji.c0.lat, ji.c0.lon);
  return {name, lat:ll.lat, lon:ll.lon, depth:J.m[2], sDepth:J.sigma ? J.sigma[2] : NaN, To:J.m[3] + ji.tref, Vp:J.m[4], kappa:J.kappa, rms:J.rms*1000,
          chi2red:J.chi2red, atBound:J.atBound, nSta:J.nSta, sX:J.sigma ? J.sigma[0] : NaN, sY:J.sigma ? J.sigma[1] : NaN, sT:J.sigma ? J.sigma[3] : NaN, sVp:J.sigma ? J.sigma[4] : NaN, unc:"asym", ...extra};
}
/* P and S residuals of any stations predicted by the joint model J (solved in the frame of ji) */
function predictResiduals(J, ji, codes){
  const useElev = els.useElev.checked;
  return codes.map(c => {
    const s = state.stations[c], q = C.equirectXY(s.lat, s.lon, ji.c0.lat, ji.c0.lon), z = useElev && Number.isFinite(s.elev_m) ? s.elev_m/1000 : 0;
    const D = Math.hypot(q.x - J.m[0], q.y - J.m[1], J.m[2] + z), tP = J.m[3] + ji.tref + D/J.m[4], tS = J.m[3] + ji.tref + J.kappa*D/J.m[4];
    return {c, D, rp:state.picks[c].p - tP, rs:state.picks[c].s - tS};
  });
}
/* Clock test for the stations not used in J: one common offset of P and S while the S−P time fits */
function timingTest(J, ji, codes, sigP, sigS){
  return predictResiduals(J, ji, codes).map(r => {
    const rsp = r.rs - r.rp, sSP = Math.hypot(sigP, sigS), off = (r.rp/sigP**2 + r.rs/sigS**2)/(1/sigP**2 + 1/sigS**2);
    const clock = Number.isFinite(rsp) && Math.abs(r.rp) > 3*sigP && Math.abs(r.rs) > 3*sigS && Math.sign(r.rp) === Math.sign(r.rs) && Math.abs(rsp) < 2*sSP;
    return {...r, rsp, offset:off, verdict:clock ? "clock" : (Number.isFinite(rsp) && Math.abs(rsp) >= 2*sSP ? "pick" : "unclear")};
  });
}
/* a fourth station for the geometry figure: the one (with P and S) that minimizes the largest azimuthal gap of the four */
function autoFourth(epi, triple, codes){
  const az = c => { const s = state.stations[c]; return (Math.atan2((s.lon - epi.lon)*Math.cos(epi.lat*Math.PI/180), s.lat - epi.lat)*180/Math.PI + 360) % 360; };
  const gap = list => { const a = list.map(az).sort((p,q) => p-q); return Math.max(...a.map((v,i) => (i ? v - a[i-1] : v + 360 - a[a.length-1]))); };
  let best = null;
  for(const c of codes.filter(hasPS)){ if(triple.includes(c)) continue;
    const s = state.stations[c], g = gap([...triple, c]) + 0.2*C.haversineKm(epi.lat, epi.lon, s.lat, s.lon);
    if(!best || g < best.g) best = {c, g}; }
  return best ? best.c : null;
}
/* three stations with the smallest largest azimuthal gap around the epicentre, among the 8 nearest with P and S */
function autoTriple(epi, codes){
  const cand = codes.filter(hasPS).map(c => { const s = state.stations[c]; return {c, d:C.haversineKm(epi.lat, epi.lon, s.lat, s.lon),
    az:(Math.atan2((s.lon - epi.lon)*Math.cos(epi.lat*Math.PI/180), s.lat - epi.lat)*180/Math.PI + 360) % 360}; }).sort((a,b) => a.d - b.d).slice(0, 8);
  let best = null;
  for(let i=0;i<cand.length;i++) for(let j=i+1;j<cand.length;j++) for(let k=j+1;k<cand.length;k++){
    const az = [cand[i].az, cand[j].az, cand[k].az].sort((a,b) => a-b), gap = Math.max(az[1]-az[0], az[2]-az[1], 360 - az[2] + az[0]);
    const score = gap + 0.5*(cand[i].d + cand[j].d + cand[k].d)/3;
    if(!best || score < best.score) best = {score, codes:[cand[i].c, cand[j].c, cand[k].c]};
  }
  return best ? best.codes : null;
}
async function runCaseStudy(){
  const status = msg => { els.caseStatus.textContent = msg; return new Promise(r => setTimeout(r, 15)); };
  const allUsed = jointCodes();          // stations selected (trusted) for the joint inversion in section 7
  if(allUsed.filter(hasPS).length < 4){ alert("The case study needs at least four stations with P and S picks and coordinates selected in section 7." + (locationBlocker() ? "\n\n" + locationBlocker() : "")); return; }
  const t0 = performance.now(), cs = {created:new Date().toISOString(), settings:settings(), reference:state.reference, rows:[]};
  await status("Apparent Vp from the data …");
  cs.vpEst = ensureVpEstimate();
  await status("Wadati regression …");
  const W = computeWadati(true); cs.W = W;
  const flagged = W ? Object.keys(W.flagged) : [];
  cs.flagged = flagged; cs.allUsed = allUsed;
  // main station set: without the flagged stations when asked (and when at least four stations with P and S remain)
  const clean = allUsed.filter(c => !flagged.includes(c));
  // with station clock correction (default), flagged stations stay in the solution and receive a clock term when needed;
  // without it, they can be excluded
  const clockOn = els.clockMode.value === "auto", JOPT = {step:0.5, hmax:40, clock:els.clockMode.value};
  cs.mainExcl = !clockOn && els.exclFlagged.checked && flagged.length > 0 && clean.filter(hasPS).length >= 4;
  const used = cs.mainExcl ? clean : allUsed;
  cs.altLabel = !flagged.length ? "" : cs.mainExcl ? `with ${flagged.join(", ")}` : `without ${flagged.join(", ")}`;
  await status("Joint inversion (settings of section 7) with depth scan and Monte Carlo …");
  const ji = jointInputFor(used); cs.ji = ji;
  const J = C.jointRobust(ji.inp, JOPT); if(!J.ok){ alert("Joint inversion failed: " + J.reason); return; }
  const withClk = S => ({clock:S.clock, c0:S.clockTerms.map(t => t.c)});
  cs.clockCodes = J.clock.map(i => ji.codes[i]);
  const trials = Math.max(100, Math.round(num("mcIn", 400)));
  const wadCodes = ji.ps.filter(c => !cs.clockCodes.includes(c));
  const mcJ = C.mcJoint({trials, seed:num("seedIn",1), sigP:ji.inp.sigP, sigS:ji.inp.sigS, base:{...ji.inp, ...withClk(J), prior:J.prior}, kappa:J.kappa, tp:ji.inp.tp, ts:ji.inp.ts, m0:J.m,
    refitWadati:!ji.inp.solveKappa, wadMethod:els.wadMethod.value, wadTp:wadCodes.map(c => state.picks[c].p - ji.tref), wadTs:wadCodes.map(c => state.picks[c].s - ji.tref), wadMap:wadCodes.map(c => used.indexOf(c))});
  const mcSig = [0,1,2,3,4].map(k => C.summarize(mcJ.m.map(v => v[k])).sigma);
  cs.J = J; cs.mcJ = mcJ;
  const mainName = `Joint LS (${ji.inp.solveVp ? "Vp estimated" : "Vp fixed"}, ${ji.inp.solveKappa ? "Vp/Vs estimated" : "Vp/Vs fixed"}${ji.inp.huber ? ", Huber" : ""})`;
  const clkTxt = S => S.clockTerms.length ? `, clock term ${S.clockTerms.map(t => `${ji.codes[t.i]} ${t.c >= 0 ? "+" : ""}${t.c.toFixed(2)} s`).join(", ")}` : "";
  cs.rows.push(solutionRecord(mainName + clkTxt(J), J, ji, {sDepthMC:mcSig[2], sXmc:mcSig[0], sYmc:mcSig[1], sTmc:mcSig[3], sVpmc:mcSig[4], depthQ:(q => [q.q16, q.q84])(C.summarize(mcJ.m.map(v => v[2]))), unc:"MC", method:"joint"}));
  await status("Joint inversion variants …");
  const JK = C.jointRobust({...ji.inp, solveVp:true, solveKappa:true, huber:false}, JOPT);
  const JV = C.jointRobust({...ji.inp, solveVp:false, Vp:num("vpRegIn", 6), solveKappa:false, huber:false}, JOPT);
  const JH = C.jointRobust({...ji.inp, solveVp:true, solveKappa:true, huber:true}, JOPT);
  cs.JK = JK; cs.JV = JV; cs.JH = JH;
  if(JK.ok) cs.rows.push(solutionRecord("Joint LS, Vp and Vp/Vs estimated" + clkTxt(JK), JK, ji, {method:"jointK"}));
  if(JV.ok) cs.rows.push(solutionRecord(`Joint LS, Vp fixed at the regional ${num("vpRegIn",6).toFixed(2)} km/s, Vp/Vs from Wadati` + clkTxt(JV), JV, ji, {method:"jointV"}));
  if(JH.ok) cs.rows.push(solutionRecord("Joint LS, Vp and Vp/Vs estimated, Huber weights" + clkTxt(JH), JH, ji, {method:"jointH"}));
  if(state.reference && Number.isFinite(state.reference.depth)){
    const Jb = JK.ok ? JK : J;
    const JR = C.jointLS({...ji.inp, ...withClk(Jb), prior:Jb.prior, kappa:Jb.kappa, solveVp:true, solveKappa:true, huber:false, fixDepth:state.reference.depth, m0:[Jb.m[0], Jb.m[1], state.reference.depth, Jb.m[3], Jb.m[4]]});
    if(JR.ok){ cs.JR = JR; cs.rows.push(solutionRecord(`Joint LS, Vp and Vp/Vs estimated, depth fixed at the reference ${state.reference.depth.toFixed(2)} km`, JR, ji, {method:"jointR", sDepth:NaN})); }
  }
  if(flagged.length){
    // comparison set: all used stations when the flagged ones are excluded from the main solution, and vice versa
    const jiE = jointInputFor(cs.mainExcl ? allUsed : clean); cs.jiE = jiE;
    const JE = C.jointRobust({...jiE.inp, solveVp:true, solveKappa:true, huber:false}, {...JOPT, clock:"off"});
    if(JE.ok){ cs.JE = JE; cs.WE = jiE.W; cs.rows.push(solutionRecord(`Joint LS, Vp and Vp/Vs estimated, ${cs.altLabel}`, JE, jiE, {method:"jointE"})); }
    // clock test of the flagged stations against the solution without them (when they were excluded)
    if(cs.mainExcl){ const Jc = JK.ok ? JK : J; cs.timing = timingTest(Jc, ji, flagged.filter(hasPS), ji.inp.sigP, ji.inp.sigS); }
  }
  if(J.clock.length){
    // clock terms estimated in the main solution: residuals before the correction, and the solution without any correction
    cs.timing = J.clockTerms.map(t => ({c:ji.codes[t.i], rp:J.rp[t.i] + t.c, rs:J.rs[t.i] + t.c, rsp:J.rs[t.i] - J.rp[t.i], offset:t.c, sigma:t.sigma, verdict:"clock",
      F:(J.clockTests.find(q => q.station === t.i) || {}).F, Fcrit:(J.clockTests.find(q => q.station === t.i) || {}).Fcrit}));
    const JN = C.jointRobust({...ji.inp, solveVp:true, solveKappa:true, huber:false}, {...JOPT, clock:"off"});
    if(JN.ok){ cs.JN = JN; cs.rows.push(solutionRecord(`Joint LS, Vp and Vp/Vs estimated, no clock correction`, JN, ji, {method:"jointN"})); }
  }
  const Jv = JK.ok ? JK : J;                // joint solution with Vp and Vp/Vs estimated (Bayesian start)
  // velocity model of the geometric methods: the apparent Vp of section 5 (estimated from the data) and its Vp/Vs
  const E5 = cs.vpEst;
  cs.vg = E5 && E5.ok && E5.reliable && els.vpEstMode.value === "auto" ? {Vp:E5.Vp, kappa:E5.kappa, sigma:Math.max(E5.sigmaMC, E5.sigma), source:"apparent Vp estimated from the data (section 5)"}
        : els.vpEstMode.value === "manual" ? {Vp:num("vpIn", 6), kappa:num("vpvsIn", Jv.kappa), sigma:num("sigVpIn", 0.2), source:"user value (section 5)"}
        : {Vp:Jv.m[4], kappa:Jv.kappa, sigma:Jv.sigma[4], source:"joint inversion with Vp and Vp/Vs estimated"};
  const VG = cs.vg;
  const clkMap = {}; J.clockTerms.forEach(t => { clkMap[ji.codes[t.i]] = t.c; });
  const kmDeg = Math.PI/180*C.R_EARTH;
  const mcXY = (la, lo) => { const a = C.summarize(la), b = C.summarize(lo); return {sY:a.sigma*kmDeg, sX:b.sigma*kmDeg*Math.cos(a.med*Math.PI/180)}; };
  const gx = (lat, lon, dSL, codes) => ({To:geomOrigin(lat, lon, dSL, VG.Vp, codes, clkMap).To});   // no σ T0: the scatter of the stations is not an uncertainty of the origin time
  await status("Three-circle and sphere solutions with Monte Carlo …");
  const epiJ = C.xyToLatLon(J.m[0], J.m[1], ji.c0.lat, ji.c0.lon);
  let chordCs = chordCodes(); if(chordCs.length < 3) chordCs = autoTriple(epiJ, used) || [];
  cs.chordCodes = chordCs;
  if(chordCs.length >= 3){
    const sts = chordCs.map(c => state.stations[c]);
    const sol = C.chordSolve(sts, chordCs.map(c => state.picks[c].s - state.picks[c].p), VG.Vp, VG.kappa, {elev:els.useElev.checked, sigP:ji.inp.sigP, sigS:ji.inp.sigS});
    const all = [...new Set([...ji.ps, ...chordCs])];
    const mcC = C.mcChord({trials, seed:num("seedIn",1), sigP:ji.inp.sigP, sigS:ji.inp.sigS, sigVp:VG.sigma, elev:els.useElev.checked,
      tpAll:all.map(c => state.picks[c].p), tsAll:all.map(c => state.picks[c].s), stAll:all.map(c => state.stations[c]),
      selIdx:chordCs.map(c => all.indexOf(c)), wadIdx:ji.ps.filter(c => !(cs.clockCodes || []).includes(c)).map(c => all.indexOf(c)), refitWadati:true, wadMethod:els.wadMethod.value, kappa:VG.kappa, Vp:VG.Vp});
    cs.chord = sol; cs.mcC = mcC;
    const zb3 = els.useElev.checked ? chordCs.slice(0, 3).reduce((q, c) => q + (Number.isFinite(state.stations[c].elev_m) ? state.stations[c].elev_m/1000 : 0), 0)/3 : 0;
    if(sol.ok){
      cs.rows.unshift({name:`Three circles (${chordCs.join(", ")}), Eq. 11`, lat:sol.epi.lat, lon:sol.epi.lon, depth:sol.depth, sDepth:C.summarize(mcC.depth).sigma, Vp:VG.Vp, kappa:VG.kappa, method:"chord", depthRef:"station level", depthSL:sol.depth - zb3, depthQ:(q => [q.q16 - zb3, q.q84 - zb3])(C.summarize(mcC.depth)), ...mcXY(mcC.lat, mcC.lon), unc:"mcgeo", ...gx(sol.epi.lat, sol.epi.lon, sol.depth - zb3, chordCs)});
      if(sol.sphere && sol.sphere.ok) cs.rows.splice(1, 0, {name:`Spheres (${chordCs.join(", ")})`, lat:sol.sphere.epi.lat, lon:sol.sphere.epi.lon, depth:sol.sphere.h, sDepth:sol.sphere.sigma[2], Vp:VG.Vp, kappa:VG.kappa, sX:sol.sphere.sigma ? sol.sphere.sigma[0] : NaN, sY:sol.sphere.sigma ? sol.sphere.sigma[1] : NaN, unc:"asym", ...gx(sol.sphere.epi.lat, sol.sphere.epi.lon, sol.sphere.h, chordCs), method:"sphere3"});
    }
  }
  const spCodes = [...new Set([...ji.ps, ...(cs.mainExcl ? (cs.timing || []).filter(t => t.verdict === "clock").map(t => t.c) : [])])]; cs.spCodes = spCodes;
  const spAll = C.chordSolve(spCodes.map(c => state.stations[c]), spCodes.map(c => state.picks[c].s - state.picks[c].p), VG.Vp, VG.kappa, {elev:els.useElev.checked, sigP:ji.inp.sigP, sigS:ji.inp.sigS});
  cs.spAll = spAll;
  if(spAll.sphere && spAll.sphere.ok) cs.rows.push({name:`Spheres, S−P times of ${spCodes.length} stations` + (spCodes.length > ji.ps.length ? ` (incl. ${spCodes.slice(ji.ps.length).join(", ")})` : ""), lat:spAll.sphere.epi.lat, lon:spAll.sphere.epi.lon, depth:spAll.sphere.h, sDepth:spAll.sphere.sigma[2], Vp:VG.Vp, kappa:VG.kappa, sX:spAll.sphere.sigma ? spAll.sphere.sigma[0] : NaN, sY:spAll.sphere.sigma ? spAll.sphere.sigma[1] : NaN, unc:"asym", ...gx(spAll.sphere.epi.lat, spAll.sphere.epi.lon, spAll.sphere.h, spCodes), method:"sphereN"});
  if(els.useBayes.checked) await status("Bayesian sampling (joint inversion option) …");
  const Wm = ji.W && ji.W.ok ? ji.W : W;     // Wadati fit of the main station set
  const Wr = Jv.wadatiRefit || J.wadatiRefit;  // ... refitted without the stations with a clock term (To relative to tref)
  const B = !els.useBayes.checked ? null : C.mcmcJoint({...ji.inp, solveKappa:true, clock:Jv.clock}, {iter:num("bayesIter", 20000), burn:Math.round(num("bayesIter",20000)/4), thin:5, seed:num("seedIn",1),
    start:[...Jv.m, Jv.kappa], cov:Jv.cov, prior:{To:Wr ? Wr.To : (Wm ? Wm.To : Jv.m[3] + ji.tref) - ji.tref, Vp:num("vpRegIn", 6), kappa:Wr ? Wr.kappa : Wm ? Wm.kappa : num("vpvsIn", 1.73)}});
  cs.B = B;
  if(B){ const bll = C.xyToLatLon(B.summary[0].med, B.summary[1].med, ji.c0.lat, ji.c0.lon);
  cs.rows.push({name:"Bayesian posterior median", lat:bll.lat, lon:bll.lon, depth:B.summary[2].med, sDepth:B.summary[2].sigma, To:B.summary[3].med + ji.tref, Vp:B.summary[4].med, kappa:B.summary[5].med, rhat:Math.max(...B.rhat), sX:B.summary[0].sigma, sY:B.summary[1].sigma, sT:B.summary[3].sigma, sVp:B.summary[4].sigma, depthQ:[B.summary[2].q16, B.summary[2].q84], unc:"post", method:"bayes"}); }
  await status("Velocity sensitivity …");
  const Vp0 = Jv.m[4], k0 = Wr ? Wr.kappa : Wm ? Wm.kappa : Jv.kappa;
  cs.sensVp = [-0.4, -0.2, 0, 0.2, 0.4].map(d => +(Vp0 + d).toFixed(2)); cs.sensK = [-0.05, -0.025, 0, 0.025, 0.05].map(d => +(k0 + d).toFixed(3));
  cs.sens = C.velocitySensitivity({...ji.inp, ...withClk(J), prior:null, m0:J.m}, cs.sensVp, cs.sensK);
  await status("Station-subset analysis of the recorded data (leave-one-out, all subsets, all three-station combinations) …");
  stationSubsetAnalysis(cs, JOPT);
  const ref = state.reference;
  if(ref) cs.rows.push({name:RNR(), lat:ref.lat, lon:ref.lon, depth:ref.depth, To:ref.origin, mag:ref.mag, refSources:ref.sources, method:"ref"});
  if(ref) for(const r of cs.rows) if(r.method !== "ref"){
    const dep = Number.isFinite(r.depthSL) ? r.depthSL : r.depth, kd = Math.PI/180*C.R_EARTH;
    r.offset = C.haversineKm(r.lat, r.lon, ref.lat, ref.lon); r.dh = dep - ref.depth;
    r.dN = (r.lat - ref.lat)*kd; r.dE = (r.lon - ref.lon)*kd*Math.cos(ref.lat*Math.PI/180);
    r.dT = Number.isFinite(r.To) && Number.isFinite(ref.origin) ? r.To - ref.origin : NaN;
  }
  cs.seconds = (performance.now() - t0)/1000;
  await status("Drawing figures …");
  state.caseStudy = cs;
  cs.figures = buildCaseFigures(cs);
  renderGallery(cs);
  const tnote = (cs.timing || []).map(t => `${t.c}: P ${t.rp >= 0 ? "+" : ""}${t.rp.toFixed(2)} s, S ${t.rs >= 0 ? "+" : ""}${t.rs.toFixed(2)} s, S−P ${t.rsp >= 0 ? "+" : ""}${t.rsp.toFixed(2)} s → ${t.verdict === "clock" ? `probable clock error of ${t.offset.toFixed(2)} s` : t.verdict === "pick" ? "S−P inconsistent: check the picks" : "unclear"}`).join("; ");
  await status(`Done in ${cs.seconds.toFixed(1)} s: ${cs.rows.length} solutions, ${cs.figures.length} figures. Use “Download all” to save them.`
    + (cs.mainExcl ? ` Main solution without ${flagged.join(", ")}.` : "") + (tnote ? ` Timing test — ${tnote}.` : "")
    + (J.depthResolution ? ` Depth ${J.m[2].toFixed(2)} km: ${J.depthResolution.class}.` : ""));
}

/* ---------- Evaluation with the recorded data only ----------
   (1) leave-one-station-out (jackknife) inversions with the settings of the main solution;
   (2) every subset of 4 … N−1 stations, with the velocities of the main solution fixed and its station clock terms
       applied as station corrections, so that the spread shows the effect of the station geometry and the picks;
   (3) every three-station combination: radical-centre epicentre, Eq. 11 depth and three-sphere depth;
   (4) the apparent-velocity map g(V) of Section 2.2 for the observed picks. */
function stationSubsetAnalysis(cs, JOPT){
  const ji = cs.ji, J = cs.J, codes = ji.codes, N = codes.length, useElev = els.useElev.checked;
  const corr = new Array(N).fill(0); J.clockTerms.forEach(t => corr[t.i] = t.c);
  const ex = J.m[0], ey = J.m[1], epiJ = C.xyToLatLon(ex, ey, ji.c0.lat, ji.c0.lon);
  const azOf = i => Math.atan2(ji.inp.xy[i].x - ex, ji.inp.xy[i].y - ey)*180/Math.PI;
  const gapOf = idx => { const a = idx.map(i => (azOf(i) + 360) % 360).sort((p,q) => p-q); return Math.max(...a.map((v,k) => k ? v - a[k-1] : v + 360 - a[a.length-1])); };
  // (1) jackknife
  cs.jack = [];
  for(const c of codes){
    const keep = codes.filter(x => x !== c);
    if(keep.filter(hasPS).length < 4) continue;
    const jl = jointInputFor(keep), L = C.jointRobust(jl.inp, JOPT);
    if(!L.ok) continue;
    const ll = C.xyToLatLon(L.m[0], L.m[1], jl.c0.lat, jl.c0.lon);
    cs.jack.push({removed:c, lat:ll.lat, lon:ll.lon, depth:L.m[2], Vp:L.m[4], kappa:L.kappa, rms:L.rms*1000, To:L.m[3] + jl.tref,
      shift:C.haversineKm(ll.lat, ll.lon, epiJ.lat, epiJ.lon), dh:L.m[2] - J.m[2], clock:L.clockTerms.map(t => `${jl.codes[t.i]} ${t.c.toFixed(2)} s`).join(", "),
      resolution:L.depthResolution ? L.depthResolution.class : ""});
  }
  const nJ = cs.jack.length;
  if(nJ > 2){
    const mh = cs.jack.reduce((a,v) => a + v.depth, 0)/nJ;
    const mx = cs.jack.reduce((a,v) => a + v.shift, 0)/nJ;
    cs.jackSigma = {depth:Math.sqrt((nJ-1)/nJ*cs.jack.reduce((a,v) => a + (v.depth - mh)**2, 0)),
                    epi:Math.sqrt((nJ-1)/nJ*cs.jack.reduce((a,v) => a + v.shift**2, 0)), n:nJ};
  }
  // (2) all subsets of 4 … N−1 stations (at most 400 per size, chosen at random with a fixed seed)
  const tp = ji.inp.tp.map((v,i) => v - corr[i]), ts = ji.inp.ts.map((v,i) => v - corr[i]);
  const rng = C.makeRng(num("seedIn", 1)), subs = [];
  const combos = k => { const out = []; const rec = (s, a) => { if(a.length === k){ out.push(a); return; } for(let i=s;i<N;i++) rec(i+1, [...a, i]); }; rec(0, []); return out; };
  for(let k = 4; k < N; k++){
    let list = combos(k).filter(idx => idx.filter(i => Number.isFinite(tp[i]) && Number.isFinite(ts[i])).length >= 3);
    while(list.length > 400) list.splice(Math.floor(rng.uni()*list.length), 1);
    for(const idx of list){
      const S = C.jointRobust({xy:idx.map(i => ji.inp.xy[i]), tp:idx.map(i => tp[i]), ts:idx.map(i => ts[i]), kappa:J.kappa, Vp:J.m[4], solveVp:false, solveKappa:false,
        sigP:ji.inp.sigP, sigS:ji.inp.sigS, m0:[ex, ey, J.m[2], J.m[3], J.m[4]]}, {step:2, hmax:30, refine:false, clock:"off"});
      if(!S.ok) continue;
      subs.push({n:k, codes:idx.map(i => codes[i]), shift:Math.hypot(S.m[0] - ex, S.m[1] - ey), depth:S.m[2], dh:S.m[2] - J.m[2], gap:gapOf(idx), rms:S.rms*1000,
        unresolved:S.atBound || !!(S.profileCI && (S.profileCI.loOpen || S.profileCI.hiOpen))});
    }
  }
  cs.subsets = subs;
  cs.subsetSummary = [...new Set(subs.map(s => s.n))].map(k => { const v = subs.filter(s => s.n === k);
    return {n:k, count:v.length, shift:C.summarize(v.map(s => s.shift)), depth:C.summarize(v.map(s => s.depth)), unresolved:v.filter(s => s.unresolved).length/v.length,
            gap:C.summarize(v.map(s => s.gap))}; });
  // (3) all three-station combinations: radical centre, Eq. 11 and three-sphere depths (velocities of the joint inversion with Vp/Vs estimated)
  const Jv = cs.vg ? {m:[0,0,0,0,cs.vg.Vp], kappa:cs.vg.kappa} : (cs.JK && cs.JK.ok ? cs.JK : J), ps = codes.filter(hasPS), tri = [];   // velocities of the geometric methods
  for(let a=0;a<ps.length;a++) for(let b=a+1;b<ps.length;b++) for(let d=b+1;d<ps.length;d++){
    const t3 = [ps[a], ps[b], ps[d]], sts = t3.map(c => state.stations[c]);
    const s = C.chordSolve(sts, t3.map(c => state.picks[c].s - state.picks[c].p), Jv.m[4], Jv.kappa, {elev:useElev, sigP:ji.inp.sigP, sigS:ji.inp.sigS});
    const idx = t3.map(c => codes.indexOf(c));
    const R = sts.map(st => C.haversineKm(epiJ.lat, epiJ.lon, st.lat, st.lon));
    const zbar = useElev ? sts.reduce((q,st) => q + (Number.isFinite(st.elev_m) ? st.elev_m/1000 : 0), 0)/3 : 0;
    tri.push({codes:t3, ok:!!s.ok, shift:s.ok ? C.haversineKm(s.epi.lat, s.epi.lon, epiJ.lat, epiJ.lon) : NaN,
      depth:s.ok && Number.isFinite(s.depth) ? s.depth - zbar : NaN, sphere:s.ok && s.sphere && s.sphere.ok ? s.sphere.h : NaN,
      meanR:R.reduce((q,v) => q + v, 0)/3, gap:gapOf(idx)});
  }
  cs.triples = tri;
  // (4) apparent-velocity map g(V) of the chord stations for the observed picks (clock-corrected), Section 2.2
  const ch = (cs.chordCodes || []).slice(0, 3);
  if(ch.length === 3){
    const Wr = J.wadatiRefit, To = Wr ? Wr.To + ji.tref : (ji.W && ji.W.ok ? ji.W.To : J.m[3] + ji.tref);
    const all = codes.filter(c => Number.isFinite(state.picks[c].p)), stAll = all.map(c => state.stations[c]);
    const tpAll = all.map(c => state.picks[c].p - corr[codes.indexOf(c)]);
    const stCh = ch.map(c => state.stations[c]), dtCh = ch.map(c => state.picks[c].s - state.picks[c].p), tpCh = ch.map(c => state.picks[c].p - corr[codes.indexOf(c)]);
    const grid = []; for(let V = 4.5; V <= 8.0001; V += 0.05) grid.push(+V.toFixed(2));
    const rows = grid.map(V => { const s = C.chordSolve(stCh, dtCh, V, Jv.kappa, {elev:useElev});
      return {V, gAll:s.ok ? C.apparentVp(s, stAll, tpAll, To).mean : NaN, gChord:s.ok ? C.apparentVp(s, stCh, tpCh, To).mean : NaN,
              depth:s.ok ? s.depth : NaN, sphere:s.ok && s.sphere && s.sphere.ok ? s.sphere.h : NaN}; });
    // fixed points of g (sign changes of g − V) and the slope there
    const fps = [];
    for(let k=1;k<rows.length;k++){ const a = rows[k-1], b = rows[k], fa = a.gAll - a.V, fb = b.gAll - b.V;
      if(Number.isFinite(fa) && Number.isFinite(fb) && fa*fb <= 0){ const V = a.V + fa/(fa - fb)*(b.V - a.V); fps.push({V, gprime:(b.gAll - a.gAll)/(b.V - a.V)}); } }
    cs.gmap = {codes:ch, To, kappa:Jv.kappa, rows, fixedPoints:fps, nAll:all.length};
  }
}

/* ---------- figure builders ---------- */
function buildCaseFigures(cs){
  const FK = FigKit, P = FK.PAL, out = [];
  const ji = cs.ji, J = cs.J, W = cs.W, ref = state.reference;
  const lat0 = ji.c0.lat, kx = KM_DEG*Math.cos(lat0*Math.PI/180), ky = KM_DEG;
  const epiJ = C.xyToLatLon(J.m[0], J.m[1], ji.c0.lat, ji.c0.lon);
  const org = ref || epiJ;                                  // origin of local km plots
  const toKm = (lat, lon) => [(lon - org.lon)*kx, (lat - org.lat)*ky];
  const xyToKm = (x, y) => { const ll = C.xyToLatLon(x, y, ji.c0.lat, ji.c0.lon); return toKm(ll.lat, ll.lon); };
  const To = J.m[3] + ji.tref, vp = J.m[4], kap = J.kappa;
  const stAll = state.order.filter(c => Number.isFinite(state.stations[c].lat));
  const isUsed = c => cs.allUsed.includes(c), isFlag = c => cs.flagged.includes(c), inFit = c => ji.codes.includes(c);
  const clkC = cs.clockCodes || [], isClk = c => clkC.includes(c);
  const exclTxt = cs.mainExcl ? ` without the flagged station${cs.flagged.length > 1 ? "s" : ""} ${cs.flagged.join(", ")}`
    : clkC.length ? ` with a clock term for ${(cs.timing || []).map(t => `${t.c} (${t.offset >= 0 ? "+" : ""}${t.offset.toFixed(2)} s)`).join(", ")}` : "";
  const Wc = cs.flagged.length ? (cs.mainExcl ? ji.W : cs.WE) : null;      // Wadati fit without the flagged stations
  const fmtUTC = t => new Date(Math.round(t*100)*10).toISOString().slice(11, 22);   // rounded (not truncated) to 10 ms
  const filt = els.filterSel.value === "none" ? "unfiltered" : `${{hp:"high-pass", lp:"low-pass", bp:"band-pass"}[els.filterSel.value]} ${els.filterSel.value === "lp" ? "" : els.fminIn.value}${els.filterSel.value === "bp" ? "–" : ""}${els.filterSel.value === "hp" ? "" : els.fmaxIn.value} Hz`;
  const refTxt = ref ? `${RNR()} (${ref.lat.toFixed(4)}°N, ${ref.lon.toFixed(4)}°E, ${ref.depth.toFixed(2)} km)` : "";
  const firstP = Math.min(...state.order.map(c => state.picks[c] && state.picks[c].p).filter(Number.isFinite));
  const evTxt = ref && Number.isFinite(ref.origin) ? `the event of ${new Date(Math.round(ref.origin*1000)).toISOString().slice(0, 10)}, ${fmtUTC(ref.origin)} UTC${Number.isFinite(ref.mag) ? ` (M ${ref.mag.toFixed(1)})` : ""}` : (Number.isFinite(firstP) ? `the event of ${new Date(firstP*1000).toISOString().slice(0, 10)} (first P ${fmtUTC(firstP)} UTC${ref && Number.isFinite(ref.mag) ? `, M ${ref.mag.toFixed(1)}` : ""})` : "the demonstration event");
  const sol = cs.chord && cs.chord.ok ? cs.chord : null, sp = sol && sol.sphere && sol.sphere.ok ? sol.sphere : null;
  const mcJxy = cs.mcJ.m.map(v => xyToKm(v[0], v[1]));
  const jKm = xyToKm(J.m[0], J.m[1]);
  const covKm = J.cov;                                       // local x, y in km (same orientation as E, N)
  const mcCov = (() => { const n = mcJxy.length, mx = mcJxy.reduce((a,v) => a+v[0], 0)/n, my = mcJxy.reduce((a,v) => a+v[1], 0)/n;
    return {xx:mcJxy.reduce((a,v) => a+(v[0]-mx)**2, 0)/(n-1), yy:mcJxy.reduce((a,v) => a+(v[1]-my)**2, 0)/(n-1), xy:mcJxy.reduce((a,v) => a+(v[0]-mx)*(v[1]-my), 0)/(n-1)}; })();
  const hs = cs.mcJ.m.map(v => v[2]);
  const mcXH = (() => { const n = hs.length, mx = mcJxy.reduce((a,v) => a+v[0], 0)/n, my = mcJxy.reduce((a,v) => a+v[1], 0)/n, mh = hs.reduce((a,v) => a+v, 0)/n;
    return {xh:mcJxy.reduce((a,v,i) => a+(v[0]-mx)*(hs[i]-mh), 0)/(n-1), yh:mcJxy.reduce((a,v,i) => a+(v[1]-my)*(hs[i]-mh), 0)/(n-1), hh:hs.reduce((a,v) => a+(v-mh)**2, 0)/(n-1)}; })();
  const chordKm = sol ? toKm(sol.epi.lat, sol.epi.lon) : null, spKm = sp ? toKm(sp.epi.lat, sp.epi.lon) : null;
  const mcCkm = cs.mcC ? cs.mcC.lat.map((la,i) => toKm(la, cs.mcC.lon[i])) : [];
  const bKm = cs.B ? xyToKm(cs.B.summary[0].med, cs.B.summary[1].med) : null;
  const eKm = cs.JE ? (() => { const ll = C.xyToLatLon(cs.JE.m[0], cs.JE.m[1], cs.jiE.c0.lat, cs.jiE.c0.lon); return toKm(ll.lat, ll.lon); })() : null;
  const sym = {chord:{m:"o", fill:P.chord}, sphere:{m:"^", fill:P.sphere}, joint:{m:"s", fill:P.joint}, bayes:{m:"D", fill:P.bayes}, excl:{m:"s", fill:"white", stroke:P.joint, sw:1.6}, ref:{m:"x", fill:P.ref}};

  /* Fig. 2 — Wadati diagram and leave-one-out residuals */
  if(W){
    const F = new FK.Figure(720, 330);
    const pts = stAll.filter(hasPS).map(c => ({c, x:state.picks[c].p - W.To, y:state.picks[c].s - state.picks[c].p}));
    const p = F.panel(62, 28, 380, 250, {xlim:[Math.min(0, ...pts.map(q => q.x)) - 0.2, Math.max(...pts.map(q => q.x))*1.06], ylim:[0, Math.max(...pts.map(q => q.y))*1.12],
      xlabel:`T_P − T_0 (s), T_0 = ${fmtUTC(W.To)} UTC`, ylabel:"T_S − T_P (s)", title:"(a) Wadati diagram"});
    const xx = [p.xlim[0], p.xlim[1]]; p.line(xx, xx.map(v => (W.kappa - 1)*v), {color:P.chord, width:1.5});
    if(Wc && Wc.ok) p.line(xx, xx.map(v => (Wc.kappa - 1)*(v + W.To - Wc.To)), {color:"#111", width:1.2, dash:"5 3"});
    p.marker(0, 0, {m:"v", r:5, fill:P.chord});
    for(const q of pts){ const u = isUsed(q.c), fl = isFlag(q.c);
      p.marker(q.x, q.y, {m:"o", r:4, fill:fl ? P.ref : (u ? "#2563eb" : "white"), stroke:"#111"}); p.label(q.x, q.y, q.c, {dx:5, dy:-4, size:8}); }
    F.text(70, 46, `V_P/V_S = ${W.kappa.toFixed(3)} ± ${W.seKappa.toFixed(3)}`, {size:10}); F.text(70, 59, `T_0 ± ${W.seTo.toFixed(3)} s, n = ${W.n}, RMS = ${(W.rms*1000).toFixed(0)} ms`, {size:10});
    p.legend([{m:"o", fill:"#2563eb", label:"used"}, {m:"o", fill:"white", label:"excluded"}, {m:"o", fill:P.ref, label:"flagged (leave-one-out)"}, {line:true, color:P.chord, label:"fit"}].concat(Wc && Wc.ok ? [{line:true, color:"#111", dash:"5 3", label:`fit without ${cs.flagged.join(", ")}`}] : []), "br");
    const codes = W.codes, loo = W.loo, sc = 1.4826*C.mad(loo.filter(Number.isFinite));
    const q = F.panel(500, 28, 200, 250, {xlim:[-0.5, codes.length - 0.5], ylim:FK.extent([...loo, 3.3*sc, -3.3*sc], 0.08), ylabel:"leave-one-out Δt residual (s)", ylabelOffset:42, title:"(b) outlier screen", xticks:[], grid:false});
    codes.forEach((c,i) => { const v = loo[i]; if(!Number.isFinite(v)) return; const x0 = q.X(i-0.35), x1 = q.X(i+0.35), y0 = q.Y(0), y1 = q.Y(v);
      F.add(`<rect x="${x0.toFixed(1)}" y="${Math.min(y0,y1).toFixed(1)}" width="${(x1-x0).toFixed(1)}" height="${Math.abs(y1-y0).toFixed(1)}" fill="${W.outlier[i] ? P.ref : "#64748b"}"/>`);
      F.text(q.X(i), q.y + q.h + 12, c, {size:7.5, anchor:"end", rotate:-60}); });
    q.hline(0, {color:"#111", width:0.7}); q.hline(3*sc, {color:P.ref, dash:"4 3"}); q.hline(-3*sc, {color:P.ref, dash:"4 3"});
    out.push({file:"fig2_wadati", title:"Wadati diagram", svg:F.svg(),
      caption:`Wadati diagram of ${evTxt}. (a) S−P time against P time relative to the Wadati origin time; the ${W.method === "ts" ? "regression of T_S on T_P" : "regression of Δt on T_P"} of the ${W.n} used stations gives V_P/V_S = ${W.kappa.toFixed(3)} ± ${W.seKappa.toFixed(3)} and T_0 = ${fmtUTC(W.To)} UTC ± ${W.seTo.toFixed(3)} s. Open symbols: stations excluded by the user; red: stations flagged by the leave-one-out screen${cs.flagged.length ? ` (${cs.flagged.join(", ")})` : " (none)"}${Wc && Wc.ok ? `; without ${cs.flagged.join(", ")} the fit (dashed) gives V_P/V_S = ${Wc.kappa.toFixed(3)} ± ${Wc.seKappa.toFixed(3)} and T_0 = ${fmtUTC(Wc.To)} UTC ± ${Wc.seTo.toFixed(3)} s` : ""}. (b) Leave-one-out residual of each station with the ±3 robust standard deviation threshold.`});
  }

  /* Fig. S1 — record sections (vertical and horizontal components) aligned on the origin time */
  {
    const recs = stAll.filter(c => hasAny(c)).map(c => {
      const s = state.stations[c], R = C.haversineKm(epiJ.lat, epiJ.lon, s.lat, s.lon), z = els.useElev.checked && Number.isFinite(s.elev_m) ? s.elev_m/1000 : 0;
      return {c, s, D:Math.hypot(R, J.m[2] + z)};
    }).sort((a,b) => a.D - b.D);
    const Dmax = Math.max(...recs.map(r => r.D)), tmax = kap*Dmax/vp + 3;
    const hasH = recs.some(r => Object.keys(r.s.comps).some(c => /[NE12]$/i.test(c)));
    const F = new FK.Figure(hasH ? 720 : 560, 560), pw = hasH ? 300 : 440;
    const panels = hasH ? [["(a) vertical components", c => /Z$/i.test(c)], ["(b) horizontal components", c => /[NE12]$/i.test(c)]] : [["vertical components", c => /Z$/i.test(c)]];
    panels.forEach(([title, sel], k) => {
      const p = F.panel(62 + k*330, 28, pw, 470, {xlim:[-1, tmax], ylim:[0, Dmax*1.08 + 1], xlabel:"time after origin (s)", ylabel:k === 0 ? "hypocentral distance (km)" : "", title});
      const amp = Math.max(0.6, Dmax*1.08/recs.length*0.55);
      const dd = [0, Dmax*1.08 + 1]; p.line(dd.map(v => v/vp), dd, {color:P.P, dash:"5 3", width:1}); p.line(dd.map(v => kap*v/vp), dd, {color:P.S, dash:"5 3", width:1});
      for(const r of recs){
        const comps = Object.keys(r.s.comps).sort((a,b) => COMP_ORDER(a) - COMP_ORDER(b)); const cc = comps.find(sel) || (k === 0 ? comps[0] : null);
        if(!cc) continue;
        const tr = r.s.comps[cc], y = displayData(tr), off = tr.start_epoch - To, dt = tr.delta;
        const i0 = Math.max(0, Math.floor((-1 - off)/dt)), i1 = Math.min(y.length - 1, Math.ceil((tmax - off)/dt));
        let mx = 0; for(let i=i0;i<=i1;i++) mx = Math.max(mx, Math.abs(y[i]));
        const step = Math.max(1, Math.floor((i1-i0)/1500)), xs = [], ys = [];
        for(let i=i0;i<=i1;i+=step){ xs.push(off + i*dt); ys.push(r.D + (mx > 0 ? y[i]/mx : 0)*amp); }
        p.line(xs, ys, {color:isUsed(r.c) ? "#111" : P.excl, width:0.6});
        const pk = state.picks[r.c];
        for(const [t, col] of [[pk.p, P.P], [pk.s, P.S]]) if(Number.isFinite(t)){ const X = p.X(t - To); F.add(`<line x1="${X.toFixed(1)}" x2="${X.toFixed(1)}" y1="${p.Y(r.D + amp).toFixed(1)}" y2="${p.Y(r.D - amp).toFixed(1)}" stroke="${col}" stroke-width="1.6"/>`); }
        F.text(p.x + p.w + 3, p.Y(r.D) + 3, r.c + (isFlag(r.c) ? "*" : ""), {size:7.5, color:isFlag(r.c) ? P.ref : "#111"});
      }
      p.legend([{line:true, color:P.P, dash:"5 3", label:`P predicted (V_P = ${vp.toFixed(2)} km/s)`}, {line:true, color:P.S, dash:"5 3", label:`S predicted (V_P/V_S = ${kap.toFixed(3)})`}, {line:true, color:P.P, width:2, label:"P pick"}, {line:true, color:P.S, width:2, label:"S pick"}], "br", {width:178});
    });
    out.push({file:"figS1_record_section", title:"Record sections", svg:F.svg(),
      caption:`Record section${hasH ? "s" : ""} of ${evTxt} (${filt}), each trace normalized and plotted at its hypocentral distance from the joint solution, against time after its origin time (${fmtUTC(To)} UTC).${hasH ? " (a) Vertical, (b) horizontal components." : " Vertical components (the files contain no horizontal components)."} Solid ticks: P (red) and S (green) picks; dashed lines: arrival times predicted by the joint solution. Grey traces: stations not used; asterisks: stations flagged by the Wadati screen${cs.mainExcl ? " (not used in the joint solution)" : clkC.length ? ` (${clkC.join(", ")} with a clock term in the joint solution)` : ""}.`});
  }

  /* Fig. S2 — map with the three-circle construction */
  {
    const pts = stAll.map(c => [state.stations[c].lon, state.stations[c].lat]);
    if(sol) chordCs(sol).forEach((c,i) => { const s = state.stations[c]; pts.push([s.lon + sol.D[i]/kx, s.lat], [s.lon - sol.D[i]/kx, s.lat], [s.lon, s.lat + sol.D[i]/ky], [s.lon, s.lat - sol.D[i]/ky]); });
    const F = new FK.Figure(720, 600);
    const p = F.panel(70, 20, 620, 520, {xlim:FK.extent(pts.map(q => q[0]), 0.06), ylim:FK.extent(pts.map(q => q[1]), 0.06), equal:{kx, ky},
      xlabel:"longitude (°E)", ylabel:"latitude (°N)", xfmt:v => v.toFixed(2), yfmt:v => v.toFixed(2), ylabelOffset:52});
    if(sol){
      const pal = ["#dc2626", "#16a34a", "#2563eb", "#9333ea", "#ea580c", "#0891b2"];
      chordCs(sol).forEach((c,i) => { const s = state.stations[c]; p.circleKm(s.lon, s.lat, sol.D[i], kx, ky, {color:pal[i % pal.length], width:1.4}); });
      const ll = q => C.xyToLatLon(q.x, q.y, sol.c0.lat, sol.c0.lon);
      sol.segs.forEach(g => { const a = ll(g.p1), b = ll(g.p2); p.line([a.lon, b.lon], [a.lat, b.lat], {color:"#a16207", width:1.3, dash:g.intersecting ? null : "5 4"}); });
    }
    for(const c of stAll){ const s = state.stations[c], ch = sol && chordCs(sol).includes(c);
      p.marker(s.lon, s.lat, {m:"^", r:ch ? 6 : 5, fill:ch ? "#fde68a" : (isUsed(c) ? "white" : "#d1d5db"), stroke:isFlag(c) ? P.ref : P.sta, sw:isFlag(c) ? 1.8 : 1});
      p.label(s.lon, s.lat, c, {dx:6, dy:-5, size:8.5, color:isFlag(c) ? P.ref : "#111"}); }
    if(sol) p.marker(sol.epi.lon, sol.epi.lat, {...sym.chord, r:5});
    if(sp) p.marker(sp.epi.lon, sp.epi.lat, {...sym.sphere, r:5});
    p.marker(epiJ.lon, epiJ.lat, {...sym.joint, r:4.5});
    if(ref) p.marker(ref.lon, ref.lat, {...sym.ref, r:6});
    p.scaleBar(niceKm((p.xlim[1]-p.xlim[0])*kx/5), kx, "right"); p.northArrow();
    const items = [{m:"^", fill:"#fde68a", label:"circle stations"}, {m:"^", fill:"white", label:"other used stations"}];
    if(stAll.some(c => !isUsed(c))) items.push({m:"^", fill:"#d1d5db", label:"excluded stations"});
    items.push({line:true, color:"#a16207", label:"radical axes (chords)"}, {...sym.chord, label:"three-circle epicentre"});
    if(sp) items.push({...sym.sphere, label:"sphere solution"});
    items.push({...sym.joint, label:"joint least squares"}); if(ref) items.push({...sym.ref, label:RNR()});
    p.legend(items, "bl");
    out.push({file:"figS2_map_three_circle", title:"Map: three-circle construction", svg:F.svg(),
      caption:sol ? `Map of the network with the three-circle construction for stations ${chordCs(sol).join(", ")}: circles of radius D_hyp (V_P = ${cs.vg.Vp.toFixed(2)} km/s, V_P/V_S = ${cs.vg.kappa.toFixed(3)}, ${cs.vg.source}), their radical axes (dashed where two circles do not intersect), and the epicentres of the three-circle, sphere and joint solutions${ref ? " and the " + refTxt : ""}.`
        : "Map of the network and the joint epicentre."});
  }

  /* Fig. 3 — three-circle (radical-centre) geometry with four stations: circles, six radical axes, Eq. 6–8 quantities, zoom */
  if(sol && cs.JK && cs.JK.ok){
    const tri = chordCs(sol).slice(0, 3), c4 = autoFourth(epiJ, tri, ji.codes.filter(hasPS));
    if(c4){
      const q4 = [...tri, c4], Vg = cs.vg.Vp, Kg = cs.vg.kappa;
      const cen = q4.map(c => { const s = state.stations[c], k = toKm(s.lat, s.lon); return {x:k[0], y:k[1]}; });
      const rr = q4.map(c => (state.picks[c].s - state.picks[c].p)*Vg/(Kg - 1));
      const RC4 = C.radicalCentre(cen, rr), RC3 = C.radicalCentre(cen.slice(0, 3), rr.slice(0, 3));
      if(RC4.ok && RC3.ok){
        const col = ["#dc2626", "#16a34a", "#2563eb", "#9333ea"], brown = "#92400e", pS = RC4.p;
        const pairs = []; for(let i=0;i<4;i++) for(let j=i+1;j<4;j++) pairs.push([i, j]);
        const F = new FK.Figure(800, 430);
        // (a) full view
        const xa = FK.extent([...cen.map((p,i) => p.x - rr[i]), ...cen.map((p,i) => p.x + rr[i])], 0.04), ya = FK.extent([...cen.map((p,i) => p.y - rr[i]), ...cen.map((p,i) => p.y + rr[i])], 0.04);
        const a = F.panel(62, 30, 330, 330, {xlim:xa, ylim:ya, equal:{kx:1, ky:1}, xlabel:"Easting (km)", ylabel:"Northing (km)", title:"(a) four stations, S−P distances", ylabelOffset:38});
        q4.forEach((c,i) => a.circleKm(cen[i].x, cen[i].y, rr[i], 1, 1, {color:col[i], width:1.4}));
        for(const [i,j] of pairs){ const sg = C.radicalAxisSegment(cen[i], rr[i], cen[j], rr[j]);
          a.line([sg.p1.x, sg.p2.x], [sg.p1.y, sg.p2.y], {color:brown, width:1.1, dash:sg.intersecting ? null : "5 3"}); }
        // quantities of Eqs. 6–7 for the pair c1, c2
        const c1 = cen[0], c2 = cen[1], dd = Math.hypot(c2.x - c1.x, c2.y - c1.y), e = {x:(c2.x - c1.x)/dd, y:(c2.y - c1.y)/dd}, n = {x:-e.y, y:e.x};
        const aa = (rr[0]**2 - rr[1]**2 + dd*dd)/(2*dd), hc2 = rr[0]**2 - aa*aa, hc = hc2 > 0 ? Math.sqrt(hc2) : 0, Fp = {x:c1.x + aa*e.x, y:c1.y + aa*e.y};
        const span = a.xlim[1] - a.xlim[0], L = 0.09*span;
        a.line([c1.x, c2.x], [c1.y, c2.y], {color:"#111", width:0.9, dash:"1.5 2.5"});
        a.line([c1.x, Fp.x], [c1.y, Fp.y], {color:"#111", width:1.3});
        if(hc > 0){ const sgn = (n.x*(-c1.x) + n.y*(-c1.y)) >= 0 ? 1 : -1;      // h_c drawn on the side of the origin
          a.line([Fp.x, Fp.x + sgn*hc*n.x], [Fp.y, Fp.y + sgn*hc*n.y], {color:"#111", width:1.3});
          a.label(Fp.x + sgn*0.35*hc*n.x, Fp.y + sgn*0.35*hc*n.y, "h_{c}", {dx:-16, dy:4, size:10}); }
        const arrow = (p, v, lab) => { const tip = {x:p.x + L*v.x, y:p.y + L*v.y}; a.line([p.x, tip.x], [p.y, tip.y], {color:"#0f766e", width:1.8});
          const X = a.X(tip.x), Y = a.Y(tip.y), ang = Math.atan2(-(v.y), v.x), s = 6;
          F.add(`<path d="M${X.toFixed(1)} ${Y.toFixed(1)}L${(X - s*Math.cos(ang - 0.4)).toFixed(1)} ${(Y - s*Math.sin(ang - 0.4)).toFixed(1)}L${(X - s*Math.cos(ang + 0.4)).toFixed(1)} ${(Y - s*Math.sin(ang + 0.4)).toFixed(1)}Z" fill="#0f766e"/>`);
          F.text(X + 9*Math.cos(ang), Y + 9*Math.sin(ang) + 4, lab, {size:12, bold:true, color:"#0f766e", anchor:"middle"}); };
        arrow(c1, e, "e"); arrow(c1, n, "n");
        a.label(c1.x + 0.5*aa*e.x, c1.y + 0.5*aa*e.y, "a", {dx:-3, dy:-6, size:10});
        a.label(c1.x + 0.5*dd*e.x - 0.04*span*n.x, c1.y + 0.5*dd*e.y - 0.04*span*n.y, "d", {dx:-3, dy:6, size:10});
        { const ang = Math.atan2(c1.y - pS.y, c1.x - pS.x) + 0.6, tip = {x:c1.x + rr[0]*Math.cos(ang), y:c1.y + rr[0]*Math.sin(ang)};
          a.line([c1.x, tip.x], [c1.y, tip.y], {color:col[0], width:1.1}); a.label((c1.x + tip.x)/2, (c1.y + tip.y)/2, "r_{1}", {dx:3, dy:-3, size:10, color:col[0]}); }
        q4.forEach((c,i) => { a.marker(cen[i].x, cen[i].y, {m:"^", r:6.5, fill:col[i], stroke:"#111", sw:1});
          a.label(cen[i].x, cen[i].y, `c_{${i+1}} ${c}`, {dx:7, dy:-6, size:10}); });
        a.marker(pS.x, pS.y, {m:"*", r:7, fill:"#f59e0b", stroke:"#111", sw:0.8});
        if(ref) a.marker(0, 0, {m:"x", r:5, fill:P.ref, lw:2});
        // (b) zoom around the epicentre
        const jk = xyToKm(J.m[0], J.m[1]), pts = [pS, RC3.p, ...(ref ? [{x:0, y:0}] : []), {x:jk[0], y:jk[1]}];
        const zx = FK.extent(pts.map(p => p.x), 0.6), zy = FK.extent(pts.map(p => p.y), 0.6), half = Math.max(1.5, (zx[1] - zx[0])/2, (zy[1] - zy[0])/2);
        const cx0 = (zx[0] + zx[1])/2, cy0 = (zy[0] + zy[1])/2;
        const b = F.panel(470, 30, 300, 330, {xlim:[cx0 - half, cx0 + half], ylim:[cy0 - half, cy0 + half], equal:{kx:1, ky:1}, xlabel:"Easting (km)",
          title:`(b) zoom: six axes, RMS distance ${RC4.rms.toFixed(2)} km`});
        const box = {x0:b.xlim[0], x1:b.xlim[1], y0:b.ylim[0], y1:b.ylim[1]};
        RC4.rows.forEach((q, k) => {
          const t = {x:-q.ny, y:q.nx}, f0 = {x:q.nx*q.d, y:q.ny*q.d}, Lb = 10*half + Math.hypot(f0.x - cx0, f0.y - cy0);
          b.line([f0.x - Lb*t.x, f0.x + Lb*t.x], [f0.y - Lb*t.y, f0.y + Lb*t.y], {color:brown, width:1.2});
          const ins = []; for(let s = -Lb; s <= Lb; s += Lb/2000){ const p = {x:f0.x + s*t.x, y:f0.y + s*t.y}; if(p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1) ins.push(p); }
          // label position: away from the legend (upper left), the scale bar (lower right) and the other labels
          const fx = p => (p.x - box.x0)/(box.x1 - box.x0), fy = p => (p.y - box.y0)/(box.y1 - box.y0);
          const free = p => !(fx(p) < 0.62 && fy(p) > 0.78) && !(fx(p) > 0.62 && fy(p) < 0.14) && fx(p) > 0.04 && fx(p) < 0.93 && fy(p) > 0.04 && fy(p) < 0.96
            && !(b._lab || []).some(o => Math.hypot(fx(o) - fx(p), fy(o) - fy(p)) < 0.09);
          const cand = (k % 2 ? [0.88, 0.12, 0.72, 0.28, 0.6, 0.4] : [0.12, 0.88, 0.28, 0.72, 0.4, 0.6]).map(u => ins[Math.round(u*(ins.length - 1))]).filter(Boolean);
          const p = cand.find(free) || cand[0];
          if(p){ (b._lab = b._lab || []).push(p); b.label(p.x, p.y, `${q.i+1}${q.j+1}`, {dx:4, dy:-3, size:9.5, color:brown}); }
        });
        b.marker(pS.x, pS.y, {m:"*", r:9, fill:"#f59e0b", stroke:"#111", sw:0.8});
        b.marker(RC3.p.x, RC3.p.y, {m:"o", r:5, fill:"white", stroke:"#2563eb", sw:2});
        b.marker(jk[0], jk[1], {m:"s", r:5, fill:P.joint, stroke:"#111", sw:0.8});
        if(ref) b.marker(0, 0, {m:"x", r:6, fill:P.ref, lw:2.6});
        b.scaleBar(niceKm(half/2), 1, "right");
        b.legend([{m:"*", r:6, fill:"#f59e0b", label:"least-squares point p*"}, {m:"o", fill:"white", stroke:"#2563eb", sw:2, label:"radical centre of c_{1}–c_{3}"},
                  {m:"s", fill:P.joint, label:"joint LS epicentre"}].concat(ref ? [{m:"x", fill:P.ref, label:(RN() + " epicentre")}] : []), "tl", {width:170});
        cs.geometry = {stations:q4, radii:rr, Vp:Vg, kappa:Kg, pStar:pS, rms:RC4.rms, rc3:RC3.p, conditioning:RC4.conditioning, origin:ref ? (RN() + " epicentre") : "joint epicentre"};
        out.push({file:"fig3_three_circle_geometry", title:"Three-circle geometry", svg:F.svg(),
          caption:`Three-circle (radical-centre) construction for ${evTxt} with four stations, c_1 = ${q4[0]}, c_2 = ${q4[1]}, c_3 = ${q4[2]}, c_4 = ${q4[3]}, in km relative to the ${ref ? (RN() + " epicentre") : "joint epicentre"}. (a) Depth-zero circles of radius r_i = D_hyp,i from the S−P times (V_P = ${Vg.toFixed(2)} km/s, V_P/V_S = ${Kg.toFixed(3)}, ${cs.vg.source}), the six radical axes (solid where the circles intersect, dashed otherwise), and the quantities of Eqs. (6)–(7) for the pair c_1, c_2: separation d, distance a along the unit baseline e, chord half-length h_c along n. (b) Zoom around the epicentre: the six axes do not meet in one point (RMS distance ${RC4.rms.toFixed(2)} km) and the least-squares point p* (Eq. 8) is used, ${Math.hypot(pS.x, pS.y).toFixed(2)} km from the ${ref ? RN() : "joint"} epicentre, whereas the three axes of c_1–c_3 meet at their radical centre; the joint least-squares epicentre is shown for comparison.`});
      }
    }
  }

  /* Fig. 4 — apparent-velocity map g(V) and three-station depth against the assumed Vp, for the observed picks */
  if(cs.gmap){
    const G = cs.gmap, rows = G.rows, F = new FK.Figure(760, 340), ch = G.codes;
    const ys = [...rows.map(r => r.gAll), ...rows.map(r => r.gChord), ...rows.map(r => r.V)];
    const a = F.panel(62, 30, 300, 250, {xlim:[4.5, 8], ylim:FK.extent(ys, 0.05), xlabel:"trial V_P (km/s)", ylabel:"mean apparent velocity g(V) (km/s)", title:"(a) update map g(V)", ylabelOffset:40});
    a.line(rows.map(r => r.V), rows.map(r => r.V), {color:"#6b7280", dash:"4 3", width:1});
    a.line(rows.map(r => r.V), rows.map(r => r.gChord), {color:P.chord, width:1.6});
    a.line(rows.map(r => r.V), rows.map(r => r.gAll), {color:P.bayes, width:1.8});
    a.vline(cs.JK.m[4], {color:P.joint, dash:"2 2", width:1.2});
    for(const fp of G.fixedPoints){ a.marker(fp.V, fp.V, {m:"o", r:4.5, fill:"white", stroke:P.bayes, sw:1.8}); a.label(fp.V, fp.V, `g′ = ${fp.gprime.toFixed(2)}`, {dx:6, dy:14, size:9.5, color:P.bayes}); }
    a.legend([{line:true, color:P.bayes, label:`all ${G.nAll} stations with P`}, {line:true, color:P.chord, label:`chord stations ${ch.join(", ")}`},
              {line:true, color:"#6b7280", dash:"4 3", label:"g(V) = V"}, {line:true, color:P.joint, dash:"2 2", label:"V_P of the joint inversion"}], "tl", {width:190});
    const ds = [...rows.map(r => r.depth), ...rows.map(r => r.sphere), cs.JK.m[2], ...(ref ? [ref.depth] : [])];
    const b = F.panel(440, 30, 300, 250, {xlim:[4.5, 8], ylim:FK.extent(ds, 0.06), invertY:true, xlabel:"assumed V_P (km/s)", ylabel:"depth (km)", title:"(b) three-station depth", ylabelOffset:34});
    b.line(rows.map(r => r.V), rows.map(r => r.depth), {color:P.chord, width:1.6});
    b.line(rows.map(r => r.V), rows.map(r => r.sphere), {color:P.sphere, width:1.4, dash:"5 3"});
    b.marker(cs.JK.m[4], cs.JK.m[2], {m:"s", r:5, fill:P.joint, stroke:"#111"});
    if(ref) b.hline(ref.depth, {color:P.ref, dash:"4 3", width:1});
    b.legend([{line:true, color:P.chord, label:"Eq. 11 (below station level)"}, {line:true, color:P.sphere, dash:"5 3", label:"three spheres (below sea level)"},
              {m:"s", fill:P.joint, label:"joint inversion"}].concat(ref ? [{line:true, color:P.ref, dash:"4 3", label:RND()}] : []), "bl", {width:190});
    const fpTxt = G.fixedPoints.length ? G.fixedPoints.map(fp => `${fp.V.toFixed(2)} km/s (g′ = ${fp.gprime.toFixed(2)})`).join(" and ") : "none in 4.5–8 km/s";
    cs.figureNotes = {...(cs.figureNotes || {}), gmap:{fixedPoints:G.fixedPoints}};
    out.push({file:"fig4_apparent_velocity", title:"Apparent-velocity map", svg:F.svg(),
      caption:`Why V_P cannot be obtained from the circle construction, for the observed picks of ${evTxt}. (a) Mean apparent velocity g(V) = mean of D_i/(T_P,i − T_0) as a function of the trial V_P, with the epicentre and depth of the three-station solution of ${ch.join(", ")} for each V_P, T_0 = ${fmtUTC(G.To)} UTC from the Wadati fit without the clock-corrected station(s), and V_P/V_S = ${G.kappa.toFixed(3)}; blue: average over all ${G.nAll} stations with a P pick (clock-corrected), orange: the three chord stations alone, which follow g(V) ≈ V for every V. Fixed points of the iteration V ← g(V): ${fpTxt}; a fixed point with g′ > 1 repels the iteration. (b) Depth of the three-station solution against the assumed V_P: every V_P fits the three S−P times exactly, with a different depth; the square marks the joint inversion (V_P and V_P/V_S estimated).`});
  }

  /* Fig. 5 — Monte Carlo uncertainty of the joint inversion: epicentre samples, conditional depth distributions, depth–Vp trade-off */
  {
    const F = new FK.Figure(840, 300);
    const clkTxt5 = (cs.clockCodes || []).length ? `clock set fixed (${cs.clockCodes.join(", ")})` : "no clock terms";
    const wadTxt5 = (cs.clockCodes || []).length ? `Wadati refitted without ${cs.clockCodes.join(", ")}` : "Wadati refitted";
    // (a) joint epicentre samples
    const half = Math.max(0.3, ...mcJxy.map(v => Math.max(Math.abs(v[0]), Math.abs(v[1]))))*1.15;
    const a = F.panel(62, 28, 210, 210, {xlim:[-half, half], ylim:[-half, half], equal:{kx:1, ky:1}, xlabel:"east (km)", ylabel:"north (km)", title:"(a) joint epicentre samples", ylabelOffset:38});
    a.scatter(mcJxy.map(v => v[0]), mcJxy.map(v => v[1]), {fill:P.joint, r:1.6, opacity:0.45});
    a.marker(ref ? 0 : jKm[0], ref ? 0 : jKm[1], {...sym.ref, r:5.5});
    a.scaleBar(niceKm((a.xlim[1] - a.xlim[0])/4), 1, "right");      // scale bar (km), requested for the first panel of the Monte Carlo figure
    // (b) conditional depth distributions
    const dJ = hs, dB = cs.B ? cs.B.samples.map(v => v[2]) : [];
    const rng = [Math.floor(Math.min(...dJ, ...dB) - 0.5), Math.ceil(Math.max(...dJ, ...dB, ...(ref ? [ref.depth] : [])) + 0.8)];
    const b = F.panel(335, 28, 210, 210, {xlim:rng, ylim:[0, 1], xlabel:"depth below sea level (km)", ylabel:"density", title:"(b) conditional depth distributions", ylabelOffset:34});
    b.ylim = [0, Math.max(FK.histMax(dJ, 30, rng, true), dB.length ? FK.histMax(dB, 30, rng, true) : 0)*1.18 || 1];
    b.hist(dJ, 30, {color:P.joint, range:rng, density:true, opacity:0.6}); if(dB.length) b.hist(dB, 30, {color:P.bayes, range:rng, density:true, step:true, width:1.4});
    if(ref) b.vline(ref.depth, {color:P.ref, dash:"4 3", width:1.3});
    b.legend([{box:true, color:P.joint, label:"joint Monte Carlo"}].concat(dB.length ? [{line:true, color:P.bayes, label:"Bayesian posterior"}] : []).concat(ref ? [{line:true, color:P.ref, dash:"4 3", label:RNR()}] : []), "tr", {width:130});
    // (c) depth–Vp trade-off of the joint Monte Carlo
    const vps = cs.mcJ.m.map(v => v[4]), solveVp = ji.inp.solveVp;
    const c = F.panel(610, 28, 210, 210, {xlim:solveVp ? FK.extent(vps, 0.06) : [vp - 0.5, vp + 0.5], ylim:FK.extent(dJ, 0.06), xlabel:"V_P (km/s)", ylabel:"depth (km)", title:"(c) joint Monte Carlo trade-off", ylabelOffset:30});
    c.scatter(vps, dJ, {fill:P.joint, r:1.6, opacity:0.5});
    const rVH = (() => { const n = vps.length, mv = vps.reduce((q,v) => q+v, 0)/n, mh = dJ.reduce((q,v) => q+v, 0)/n;
      const sv = Math.sqrt(vps.reduce((q,v) => q + (v-mv)**2, 0)), sh = Math.sqrt(dJ.reduce((q,v) => q + (v-mh)**2, 0));
      return sv > 0 && sh > 0 ? vps.reduce((q,v,i) => q + (v-mv)*(dJ[i]-mh), 0)/(sv*sh) : NaN; })();
    if(Number.isFinite(rVH)) F.text(c.x + c.w - 6, c.y + 14, `r = ${rVH.toFixed(2)}`, {anchor:"end", size:10});
    F.text(420, 290, `${cs.mcJ.m.length} trials; ${clkTxt5}; ${wadTxt5}; homogeneous model`, {anchor:"middle", size:10.5});
    const hS = C.summarize(dJ), bS = cs.B ? cs.B.summary[2] : null;
    out.push({file:"fig5_montecarlo", title:"Monte Carlo uncertainty", svg:F.svg(),
      caption:`Monte Carlo uncertainty of the joint inversion (${mainName(cs)}) of ${evTxt} (${cs.mcJ.m.length} trials; σ_P = ${els.sigPIn.value} s, σ_S = ${els.sigSIn.value} s; ${clkTxt5}; ${wadTxt5} in every trial; homogeneous half-space). (a) Epicentre samples in km relative to the ${ref ? (RN() + " epicentre (cross)") : "joint epicentre"}. (b) Depth distributions below sea level of the joint Monte Carlo (median ${hS.med.toFixed(2)} km, 16th–84th percentiles ${hS.q16.toFixed(2)}–${hS.q84.toFixed(2)} km)${bS ? ` and of the Bayesian posterior (${bS.med.toFixed(2)} km, ${bS.q16.toFixed(2)}–${bS.q84.toFixed(2)} km)` : ""}${ref ? `; dashed line: ${RN()} depth (${ref.depth.toFixed(2)} km)` : ""}. Both are conditional on the homogeneous velocity model and the clock-term set. (c) Trade-off between depth and V_P in the Monte Carlo samples${Number.isFinite(rVH) ? ` (correlation ${rVH.toFixed(2)})` : ""}: a faster medium places the source shallower.`});
  }

  /* Fig. S7 — point estimates of all solvers: map view and depth with conditional intervals */
  {
    const F = new FK.Figure(840, 400);
    const pts = [];
    const add = (lab, lat, lon, h, s, lo, hi) => { if(Number.isFinite(lat) && Number.isFinite(lon)) pts.push({lab, k:toKm(lat, lon), h, s, lo, hi}); };
    const zbar3 = sol ? cs.chordCodes.slice(0, 3).reduce((q,c) => q + (Number.isFinite(state.stations[c].elev_m) && els.useElev.checked ? state.stations[c].elev_m/1000 : 0), 0)/3 : 0;
    if(sol) add("Three circles", sol.epi.lat, sol.epi.lon, sol.depth - zbar3, sym.chord);
    if(sp) add("Three spheres", sp.epi.lat, sp.epi.lon, sp.h, sym.sphere);
    const spN = cs.spAll && cs.spAll.sphere && cs.spAll.sphere.ok ? cs.spAll.sphere : null;
    if(spN) add(`${cs.spCodes.length === 9 ? "Nine" : cs.spCodes.length} spheres`, spN.epi.lat, spN.epi.lon, spN.h, {m:"v", fill:P.sphere});
    const hq = C.summarize(hs);
    add("Joint inversion", epiJ.lat, epiJ.lon, J.m[2], sym.joint, J.m[2] - (hq.med - hq.q16), J.m[2] + (hq.q84 - hq.med));
    if(cs.B){ const bll = C.xyToLatLon(cs.B.summary[0].med, cs.B.summary[1].med, ji.c0.lat, ji.c0.lon), bq = cs.B.summary[2];
      add("Posterior median", bll.lat, bll.lon, bq.med, sym.bayes, bq.q16, bq.q84); }
    const xs = [...pts.map(p => p.k[0]), 0], ys = [...pts.map(p => p.k[1]), 0];
    const xl = FK.extent(xs, 0.25), yl = FK.extent(ys, 0.35);
    const a = F.panel(70, 28, 300, 260, {xlim:xl, ylim:yl, equal:{kx:1, ky:1}, xlabel:"east (km)", ylabel:"north (km)", title:"(a) point estimates", ylabelOffset:38});
    for(const p of pts) a.marker(p.k[0], p.k[1], {...p.s, r:6});
    if(ref) a.marker(0, 0, {...sym.ref, r:6});
    const dvals = [...pts.map(p => p.h), ...pts.map(p => p.lo).filter(Number.isFinite), ...pts.map(p => p.hi).filter(Number.isFinite), ...(ref ? [ref.depth] : [])];
    const b = F.panel(480, 28, 330, 260, {xlim:a.xlim, ylim:FK.extent(dvals, 0.12), invertY:true, xlabel:"east (km)", ylabel:"depth below sea level (km)", title:"(b) depth and conditional intervals", ylabelOffset:36});
    for(const p of pts){ if(Number.isFinite(p.lo)) b.errY(p.k[0], p.h, p.lo, p.hi, {color:p.s.fill, width:1.4}); b.marker(p.k[0], p.h, {...p.s, r:6}); }
    if(ref) b.marker(0, ref.depth, {...sym.ref, r:6});
    b.legendAbs(70, 345, [...pts.map(p => ({...p.s, label:p.lab})), ...(ref ? [{...sym.ref, label:"Header reference"}] : [])], 245, 3);
    F.text(420, 393, "Circle depth converted using mean station elevation; geometric uncertainty not shown", {anchor:"middle", size:10.5});
    out.push({file:"figS7_point_estimates", title:"Point estimates", svg:F.svg(),
      caption:`Point estimates of all solvers for ${evTxt}, in km relative to the ${ref ? (RN() + " epicentre") : "joint epicentre"}: (a) map view; (b) west–east section of depth below sea level. Bars: 16th–84th percentiles of the joint-inversion Monte Carlo${cs.B ? " and of the Bayesian posterior, both" : ","} conditional on the homogeneous model and the clock-term set. The Eq. 11 depth of the three-circle solution (measured from the station level) is converted to below sea level with the mean elevation of its three stations (${zbar3.toFixed(2)} km); the uncertainties of the geometric solutions are not shown (see Figs. 5 and 6).`});
  }

  /* Fig. S8 — misfit in map view with the Levenberg–Marquardt path, and the depth scan */
  {
    const F = new FK.Figure(760, 440);
    // misfit over the epicentre at the depth, Vp, Vp/Vs and clock terms of the solution (origin time optimal at each point)
    const corr = new Array(ji.codes.length).fill(0); J.clockTerms.forEach(t => corr[t.i] = t.c);
    const sP = ji.inp.sigP, sS = ji.inp.sigS;
    const misfit = (x, y) => { let sw = 0, swr = 0; const rr = [];
      ji.inp.xy.forEach((s,i) => { const D = Math.hypot(x - s.x, y - s.y, J.m[2] + s.z);
        if(Number.isFinite(ji.inp.tp[i])){ const r = ji.inp.tp[i] - corr[i] - D/J.m[4]; rr.push([r, 1/sP**2]); }
        if(Number.isFinite(ji.inp.ts[i])){ const r = ji.inp.ts[i] - corr[i] - J.kappa*D/J.m[4]; rr.push([r, 1/sS**2]); } });
      for(const [r, w] of rr){ sw += w; swr += w*r; } const t0 = swr/sw; return rr.reduce((q,[r,w]) => q + w*(r - t0)**2, 0); };
    // Levenberg–Marquardt path from the default start (station centroid, 10 km depth)
    const Wst = ji.W && ji.W.ok ? ji.W.To - ji.tref : J.m[3];
    const T = C.jointLS({...ji.inp, clock:J.clock, c0:J.clockTerms.map(t => t.c), kappa:J.kappa, prior:ji.inp.prior, trace:true, m0:[0, 0, 10, Wst, num("vpIn", 6)]});
    const path = T.ok && T.path ? T.path : [];
    const stx = ji.inp.xy.map(s => s.x), sty = ji.inp.xy.map(s => s.y);
    const xl = FK.extent([...stx, ...path.map(p => p[0])], 0.08), yl = FK.extent([...sty, ...path.map(p => p[1])], 0.08);
    const a = F.panel(62, 30, 330, 330, {xlim:xl, ylim:yl, equal:{kx:1, ky:1}, xlabel:"x (km, east of the station centroid)", ylabel:"y (km, north)", title:"(a) misfit in map view and Levenberg–Marquardt path", ylabelOffset:38, grid:false});
    const nG = 70, gx0 = a.xlim[0], gy0 = a.ylim[0], dx = (a.xlim[1] - gx0)/nG, dy = (a.ylim[1] - gy0)/nG;
    const vals = []; for(let i=0;i<nG;i++) for(let j=0;j<nG;j++) vals.push(misfit(gx0 + (i+0.5)*dx, gy0 + (j+0.5)*dy));
    const vmin = Math.max(Math.min(...vals), 1e-9), lv = vals.map(v => Math.log10(v/vmin)), lmax = Math.max(...lv) || 1;
    // contour bands: 0.25 decades of χ²/χ²min, light (small misfit) to dark blue
    const nb = Math.max(4, Math.min(14, Math.ceil(lmax/0.25)));
    const shade = t => { const u = Math.min(nb - 1, Math.floor(t/lmax*nb))/(nb - 1), c0 = [241,245,249], c1 = [30,58,95];
      return `rgb(${c0.map((v,k) => Math.round(v + (c1[k]-v)*Math.pow(u, 0.75))).join(",")})`; };
    let g = ""; for(let i=0;i<nG;i++) for(let j=0;j<nG;j++){ const X0 = a.X(gx0 + i*dx), X1 = a.X(gx0 + (i+1)*dx), Y0 = a.Y(gy0 + (j+1)*dy), Y1 = a.Y(gy0 + j*dy);
      g += `<rect x="${X0.toFixed(1)}" y="${Y0.toFixed(1)}" width="${(X1-X0+0.6).toFixed(1)}" height="${(Y1-Y0+0.6).toFixed(1)}" fill="${shade(lv[i*nG + j])}"/>`; }
    a.clip(g);
    a.line(path.map(p => p[0]), path.map(p => p[1]), {color:P.ref, width:2});
    path.forEach((p,k) => a.marker(p[0], p[1], {m:"o", r:k === path.length - 1 ? 4.5 : 3.2, fill:P.ref, stroke:"#7f1d1d", sw:0.6}));
    ji.codes.forEach((c,i) => { a.marker(stx[i], sty[i], {m:"^", r:6, fill:"#38bdf8", stroke:"#0c4a6e", sw:1.2}); a.label(stx[i], sty[i], c, {dx:7, dy:-5, size:8.5, color:"#0f172a"}); });
    F.add(`<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="none" stroke="#111827" stroke-width="0.9"/>`);
    F.text(a.x + a.w/2, a.y + a.h + 46, `Levenberg–Marquardt: ${path.length - 1} accepted steps from (0, 0, 10 km)`, {anchor:"middle", size:11, color:P.ref, bold:true});
    // (b) depth scan, depth downwards
    const pr = (J.profile || []).filter(p => Number.isFinite(p.chi2)), cmin = Math.min(...pr.map(p => p.chi2)), scl = Math.max(J.chi2red || 1, 1e-9);
    const dch = pr.map(p => Math.sqrt(Math.max(0, (p.chi2 - cmin)/scl)));     // in units of the 1σ level
    const b = F.panel(500, 30, 220, 330, {xlim:[0, Math.max(...dch)*1.05 || 1], ylim:[Math.min(...pr.map(p => p.h)), Math.max(...pr.map(p => p.h))], invertY:true,
      xlabel:"√(Δχ² / χ²_red)", ylabel:"depth (km)", title:"(b) depth scan", ylabelOffset:34});
    b.line(dch, pr.map(p => p.h), {color:"#0ea5e9", width:2});
    b.vline(1, {color:"#6b7280", dash:"3 3", width:0.9});
    b.marker(0, J.m[2], {m:"o", r:6, fill:P.joint, stroke:"#111", sw:0.8});
    b.label(0, J.m[2], `${J.m[2].toFixed(2)} km`, {dx:9, dy:4, size:9.5});
    out.push({file:"figS8_misfit_lm", title:"Misfit map and depth scan", svg:F.svg(),
      caption:`Joint inversion of ${evTxt}. (a) Weighted misfit χ² as a function of the epicentre (bands of 0.25 in log₁₀ χ²/χ²_min, light = small), with depth (${J.m[2].toFixed(2)} km), V_P (${J.m[4].toFixed(2)} km/s), V_P/V_S (${J.kappa.toFixed(3)}) and the clock terms of the solution held fixed and the origin time optimal at each point; red: the iterates of the Levenberg–Marquardt inversion started at the station centroid at 10 km depth (${path.length - 1} accepted steps); triangles: stations. (b) Depth scan: minimum misfit with the depth held fixed and all other unknowns free, shown as √(Δχ²/χ²_red) (the misfit increase in units of the 1σ level) against depth; dotted line: 1σ; dot: the solution.`});
  }

  /* Fig. 6 — solver comparison: network, zoom with 1σ ellipses, two depth sections */
  {
    const F = new FK.Figure(720, 660);
    const net = stAll.map(c => toKm(state.stations[c].lat, state.stations[c].lon));
    const a = F.panel(55, 26, 290, 250, {xlim:FK.extent(net.map(v => v[0]), 0.08), ylim:FK.extent(net.map(v => v[1]), 0.08), equal:{kx:1, ky:1}, xlabel:"east (km)", ylabel:"north (km)", title:"(a) network", ylabelOffset:34});
    stAll.forEach((c,i) => { a.marker(net[i][0], net[i][1], {m:"^", r:5, fill:isUsed(c) ? "white" : "#d1d5db", stroke:isFlag(c) ? P.ref : P.sta, sw:isFlag(c) ? 1.8 : 1}); a.label(net[i][0], net[i][1], c, {dx:5, dy:-4, size:7.5, color:isFlag(c) ? P.ref : "#111"}); });
    const sols = [[jKm, sym.joint], ...(chordKm ? [[chordKm, sym.chord]] : []), ...(spKm ? [[spKm, sym.sphere]] : []), ...(bKm ? [[bKm, sym.bayes]] : []), ...(eKm ? [[eKm, sym.excl]] : [])];
    const zx = [...sols.map(s => s[0][0]), ...(ref ? [0] : [])], zy = [...sols.map(s => s[0][1]), ...(ref ? [0] : [])];
    const half = Math.max(0.6, 1.25*Math.max(Math.max(...zx) - Math.min(...zx), Math.max(...zy) - Math.min(...zy), 2*Math.sqrt(Math.max(mcCov.xx, mcCov.yy))*2)/2 + 0.3);
    const zc = [(Math.max(...zx) + Math.min(...zx))/2, (Math.max(...zy) + Math.min(...zy))/2];
    F.add(`<rect x="${a.X(zc[0]-half).toFixed(1)}" y="${a.Y(zc[1]+half).toFixed(1)}" width="${(a.X(zc[0]+half)-a.X(zc[0]-half)).toFixed(1)}" height="${(a.Y(zc[1]-half)-a.Y(zc[1]+half)).toFixed(1)}" fill="none" stroke="#111" stroke-width="1"/>`);
    a.marker(jKm[0], jKm[1], {...sym.joint, r:3.5}); if(ref) a.marker(0, 0, {...sym.ref, r:4});
    a.scaleBar(niceKm((a.xlim[1]-a.xlim[0])/4), 1, "right"); a.northArrow();
    const b = F.panel(415, 26, 290, 250, {xlim:[zc[0]-half, zc[0]+half], ylim:[zc[1]-half, zc[1]+half], equal:{kx:1, ky:1}, xlabel:"east (km)", ylabel:"north (km)", title:"(b) zoom, 1σ ellipses", ylabelOffset:34});
    b.ellipseCov(jKm[0], jKm[1], mcCov.xx, mcCov.xy, mcCov.yy, {color:P.joint, width:1.6});
    b.ellipseCov(jKm[0], jKm[1], covKm[0][0], covKm[0][1], covKm[1][1], {color:P.joint, width:1.1, dash:"4 3"});
    if(cs.mcC && chordKm && mcCkm.length > 10){ const n = mcCkm.length, mx = mcCkm.reduce((s,v) => s+v[0], 0)/n, my = mcCkm.reduce((s,v) => s+v[1], 0)/n;
      b.ellipseCov(chordKm[0], chordKm[1], mcCkm.reduce((s,v) => s+(v[0]-mx)**2, 0)/(n-1), mcCkm.reduce((s,v) => s+(v[0]-mx)*(v[1]-my), 0)/(n-1), mcCkm.reduce((s,v) => s+(v[1]-my)**2, 0)/(n-1), {color:P.chord, width:1.3}); }
    if(sp && sp.cov) b.ellipseCov(spKm[0], spKm[1], sp.cov[0][0], sp.cov[0][1], sp.cov[1][1], {color:P.sphere, width:1.1, dash:"2 2"});
    for(const [q, s] of sols) b.marker(q[0], q[1], {...s, r:5});
    if(ref) b.marker(0, 0, {...sym.ref, r:6});
    b.scaleBar(niceKm(2*half/4), 1, "right");
    const items = [{...sym.joint, label:"joint LS (solid: MC, dashed: asymptotic)"}];
    if(chordKm) items.push({...sym.chord, label:"three circles (MC ellipse)"}); if(spKm) items.push({...sym.sphere, label:"spheres (3 stations)"});
    if(cs.B) items.push({...sym.bayes, label:"posterior median"}); if(eKm) items.push({...sym.excl, label:`joint LS ${cs.altLabel}`}); if(ref) items.push({...sym.ref, label:RNR()});
    // depth sections
    const dvals = [J.m[2], ...(cs.B ? [cs.B.summary[2].q16, cs.B.summary[2].q84] : []), ...(sol ? [sol.depth] : []), ...(sp ? [sp.h - (sp.sigma?.[2]||0), sp.h + (sp.sigma?.[2]||0)] : []), ...(ref ? [ref.depth] : []), ...(cs.JE ? [cs.JE.m[2]] : []),
                   J.m[2] - 2.2*Math.sqrt(mcXH.hh), J.m[2] + 2.2*Math.sqrt(mcXH.hh)];
    const dl = FK.extent(dvals, 0.12);
    const sec = (panel, axis) => {
      const k = axis === 0 ? "xx" : "yy", kh = axis === 0 ? "xh" : "yh";
      panel.ellipseCov(jKm[axis], J.m[2], mcCov[k], mcXH[kh], mcXH.hh, {color:P.joint, width:1.6});
      panel.ellipseCov(jKm[axis], J.m[2], covKm[axis][axis], covKm[axis][2], covKm[2][2], {color:P.joint, width:1.1, dash:"4 3"});
      if(sol && cs.mcC){ const d = C.summarize(cs.mcC.depth); panel.errY(chordKm[axis], sol.depth, d.q16, d.q84, {color:P.chord}); panel.marker(chordKm[axis], sol.depth, {...sym.chord, r:4.5}); }
      if(sp){ panel.errY(spKm[axis], sp.h, sp.h - sp.sigma[2], sp.h + sp.sigma[2], {color:P.sphere}); panel.marker(spKm[axis], sp.h, {...sym.sphere, r:4.5}); }
      if(cs.B){ const bs = cs.B.summary[2]; panel.errY(bKm[axis], bs.med, bs.q16, bs.q84, {color:P.bayes}); panel.marker(bKm[axis], bs.med, {...sym.bayes, r:4}); }
      if(cs.JE) panel.marker(eKm[axis], cs.JE.m[2], {...sym.excl, r:5});
      panel.marker(jKm[axis], J.m[2], {...sym.joint, r:4.5});
      if(ref) panel.marker(0, ref.depth, {...sym.ref, r:6});
    };
    const c = F.panel(55, 340, 290, 220, {xlim:[zc[0]-half*1.6, zc[0]+half*1.6], ylim:dl, invertY:true, xlabel:"east (km)", ylabel:"depth (km)", title:"(c) west–east section", ylabelOffset:34});
    sec(c, 0);
    const d = F.panel(415, 340, 290, 220, {xlim:[zc[1]-half*1.6, zc[1]+half*1.6], ylim:dl, invertY:true, xlabel:"north (km)", ylabel:"depth (km)", title:"(d) south–north section", ylabelOffset:34});
    sec(d, 1);
    b.legendAbs(60, 612, [...items, {line:true, color:P.joint, label:"1σ, Monte Carlo"}, {line:true, color:P.joint, dash:"4 3", label:"1σ, asymptotic (Eq. 21)"}], 228, 3);
    out.push({file:"fig6_solver_comparison", title:"Solver comparison", svg:F.svg(),
      caption:`Comparison of the solutions for ${evTxt}${exclTxt ? `, with the joint inversion${exclTxt}` : ""}, in km relative to the ${ref ? refTxt : "joint epicentre"}. (a) Network (open triangles: used stations; grey: excluded; red outline: flagged) with the area of panel (b). (b) Zoomed map view with the 1σ error ellipses of the joint inversion (solid: ${cs.mcJ.m.length}-trial Monte Carlo; dashed: asymptotic, Eq. 21), the three-circle solution (Monte Carlo) and the sphere solution. (c) West–east and (d) south–north depth sections with the corresponding 1σ ellipses and 68% intervals. Depths below sea level${els.useElev.checked ? "" : " (station level)"}, except the three-circle depth (Eq. 11), which is measured from the station level.`});
  }

  /* Fig. 7 — correlation matrix */
  {
    const names = ["x", "y", "h", "T_0", "V_P", "V_P/V_S"], cov = J.cov, keep = [0,1,2,3,4,5].filter(i => Number.isFinite(cov[i][i]) && cov[i][i] > 0);
    const n = keep.length, F = new FK.Figure(430, 360), s = 260/n, x0 = 70, y0 = 30;
    keep.forEach((i,a) => keep.forEach((j,b) => {
      const r = cov[i][j]/Math.sqrt(cov[i][i]*cov[j][j]);
      const col = r >= 0 ? `rgb(${255},${Math.round(255*(1-r))},${Math.round(255*(1-r))})` : `rgb(${Math.round(255*(1+r))},${Math.round(255*(1+r))},255)`;
      F.add(`<rect x="${x0+b*s}" y="${y0+a*s}" width="${s}" height="${s}" fill="${col}" stroke="white"/>`);
      F.text(x0+b*s+s/2, y0+a*s+s/2+4, (r >= 0 ? "+" : "") + r.toFixed(2), {anchor:"middle", size:10, color:Math.abs(r) > 0.6 ? "white" : "#111"});
    }));
    keep.forEach((i,a) => { F.text(x0 - 8, y0 + a*s + s/2 + 4, names[i], {anchor:"end", size:11}); F.text(x0 + a*s + s/2, y0 + n*s + 16, names[i], {anchor:"middle", size:11}); });
    for(let k=0;k<=40;k++){ const r = 1 - k/20, col = r >= 0 ? `rgb(255,${Math.round(255*(1-r))},${Math.round(255*(1-r))})` : `rgb(${Math.round(255*(1+r))},${Math.round(255*(1+r))},255)`;
      F.add(`<rect x="${x0 + n*s + 25}" y="${(y0 + k*260/41).toFixed(1)}" width="14" height="${(260/41 + 0.5).toFixed(1)}" fill="${col}"/>`); }
    [1, 0.5, 0, -0.5, -1].forEach(v => F.text(x0 + n*s + 44, y0 + (1 - v)/2*260 + 4, v.toFixed(1), {size:9}));
    F.text(x0 + n*s + 70, y0 + 130, "correlation", {anchor:"middle", rotate:90, size:10});
    out.push({file:"fig7_correlation", title:"Parameter correlations", svg:F.svg(),
      caption:`Correlation coefficients of the parameters of the joint inversion (${mainName(cs)}) from the asymptotic covariance (Eq. 21).`});
  }

  /* Fig. 8 — residuals by station, with and without the flagged stations */
  {
    const codes = cs.allUsed, F = new FK.Figure(720, 300);
    const rM = predictResiduals(J, ji, codes), rE = cs.JE ? predictResiduals(cs.JE, cs.jiE, codes) : null;
    const fitVals = [...J.rp, ...J.rs, ...(cs.JE ? [...cs.JE.rp, ...cs.JE.rs] : [])].filter(Number.isFinite);
    const lim = Math.max(0.12, ...fitVals.map(Math.abs))*1.25, clip = v => Math.max(-lim, Math.min(lim, v));
    const p = F.panel(62, 30, 640, 200, {xlim:[-0.6, codes.length - 0.4], ylim:[-lim, lim], ylabel:"T_obs − T_pred (s)", xticks:[],
      title:`RMS ${(J.rms*1000).toFixed(0)} ms (${ji.codes.length} stations${exclTxt})` + (cs.JE ? `; ${(cs.JE.rms*1000).toFixed(0)} ms ${cs.altLabel}` : "")});
    p.hline(0, {color:"#111", width:0.8}); p.hline(0.1, {color:"#9ca3af", dash:"3 3", width:0.7}); p.hline(-0.1, {color:"#9ca3af", dash:"3 3", width:0.7});
    codes.forEach((c,i) => {
      const fit = inFit(c) && !isClk(c), j = ji.codes.indexOf(c);
      [[rM[i].rp, P.P, -0.2], [rM[i].rs, P.S, 0.2]].forEach(([v, col, dx]) => { if(!Number.isFinite(v)) return; const x0 = p.X(i+dx-0.19), x1 = p.X(i+dx+0.19), y0 = p.Y(0), y1 = p.Y(clip(v));
        F.add(`<rect x="${x0.toFixed(1)}" y="${Math.min(y0,y1).toFixed(1)}" width="${(x1-x0).toFixed(1)}" height="${Math.abs(y1-y0).toFixed(1)}" fill="${fit ? col : "white"}" stroke="${col}" stroke-width="${fit ? 0 : 1.4}" opacity="0.85"/>`);
        if(Math.abs(v) > lim) F.text(p.X(i+dx), v < 0 ? y1 - 4 : y1 + 10, v.toFixed(2), {size:7.5, anchor:"middle", color:col}); });
      if(rE) [[rE[i].rp, -0.2], [rE[i].rs, 0.2]].forEach(([v, dx]) => { if(Number.isFinite(v) && Math.abs(v) <= lim){ const Y = p.Y(v); F.add(`<line x1="${p.X(i+dx-0.22).toFixed(1)}" x2="${p.X(i+dx+0.22).toFixed(1)}" y1="${Y.toFixed(1)}" y2="${Y.toFixed(1)}" stroke="#111" stroke-width="2.2"/>`); } });
      F.text(p.X(i), p.y + p.h + 14, c, {size:8.5, anchor:"end", rotate:-45, color:isFlag(c) ? P.ref : "#111"});
      const tt = (cs.timing || []).find(t => t.c === c);
      if(tt && tt.verdict === "clock") F.text(p.X(i), p.y + 12, `clock ${tt.offset >= 0 ? "+" : ""}${tt.offset.toFixed(2)} s`, {size:8, anchor:"middle", color:P.ref});
      else if(j >= 0 && J.flags[j].some(t => t.startsWith("same-sign"))) F.text(p.X(i), p.y + 12, "timing?", {size:8, anchor:"middle", color:P.ref});
    });
    p.legend([{box:true, color:P.P, label:"P residual"}, {box:true, color:P.S, label:"S residual"}].concat(cs.mainExcl ? [{box:true, color:"white", stroke:P.P, label:"not in the fit"}] : clkC.length ? [{box:true, color:"white", stroke:P.P, label:"before the clock correction"}] : [], cs.JE ? [{line:true, color:"#111", width:2.2, label:cs.altLabel}] : []), "br");
    const tc = (cs.timing || []).filter(t => t.verdict === "clock");
    out.push({file:"fig8_residuals", title:"Station residuals", svg:F.svg(),
      caption:`P and S residuals by station for the joint inversion (${mainName(cs)})${exclTxt} (bars${cs.mainExcl ? "; open bars: residuals predicted for the station(s) not used in the fit" : clkC.length ? "; open bars: residuals of the station(s) with a clock term before the correction" : ""})${cs.JE ? ` and for the inversion ${cs.altLabel} (black ticks)` : ""}; dotted lines at ±0.1 s; values beyond the axis are printed.`
        + (tc.length ? ` ${tc.map(t => `${t.c}: P and S residuals ${t.rp.toFixed(2)} and ${t.rs.toFixed(2)} s, but S−P residual ${t.rsp >= 0 ? "+" : ""}${t.rsp.toFixed(2)} s`).join("; ")}, i.e. a probable clock (timing) error of ${tc.map(t => `${t.offset.toFixed(2)} s`).join(", ")} that leaves the S−P time, and so the three-circle and sphere solutions, unaffected.` : "")
        + ` “timing?” marks stations whose P and S residuals are both large with the same sign.`});
  }

  /* Fig. S3 — depth scan */
  {
    const F = new FK.Figure(720, 290);
    const curves = [[J, P.joint, mainName(cs)], [cs.JK, P.jointAlt, "Vp and Vp/Vs estimated"], [cs.JV, "#b45309", `Vp fixed at ${num("vpRegIn",6).toFixed(2)} km/s`]].filter(c => c[0] && c[0].ok && c[0].profile && c[0].profile.length);
    const ys = curves.map(([Jc]) => { const m = Math.min(...Jc.profile.map(p => p.chi2)), s = Math.max(1, Jc.chi2red || 1); return Jc.profile.map(p => (p.chi2 - m)/s); });
    const hx = J.profile.map(p => p.h);
    const a = F.panel(62, 28, 390, 200, {xlim:[Math.min(...hx), Math.max(...hx)], ylim:[0, Math.min(50, Math.max(5, ...ys.flat().filter(Number.isFinite)))], xlabel:"depth (km)", ylabel:"Δχ² / χ²_red", title:"(a) misfit against depth"});
    curves.forEach(([Jc, col], k) => a.line(Jc.profile.map(p => p.h), ys[k], {color:col, width:1.6}));
    a.hline(1, {color:"#6b7280", dash:"4 3", width:0.8});
    curves.forEach(([Jc, col]) => a.marker(Jc.m[2], 0, {m:"o", r:3.5, fill:col}));
    if(ref) a.vline(ref.depth, {color:P.ref, dash:"4 3", width:1.3});
    a.legend(curves.map(([, col, lab]) => ({line:true, color:col, label:lab})).concat(ref ? [{line:true, color:P.ref, dash:"4 3", label:"reference depth"}] : []), "tr", {width:200});
    const ci = J.profileCI, hz = ci ? [Math.max(a.xlim[0], J.m[2] - 3*Math.max(0.3, (ci.hi-ci.lo))), Math.min(a.xlim[1], J.m[2] + 3*Math.max(0.3, (ci.hi-ci.lo)))] : [J.m[2]-3, J.m[2]+3];
    const b = F.panel(492, 28, 190, 200, {xlim:hz, ylim:[0, 1], xlabel:"depth (km)", title:cs.B ? "(b) zoom and posterior" : "(b) zoom", yticks:[]});
    if(cs.B){ b.ylim = [0, (FK.histMax(cs.B.samples.map(v => v[2]), 40, hz, true) || 1)*1.15];
      b.hist(cs.B.samples.map(v => v[2]), 40, {color:P.bayes, range:hz, density:true, opacity:0.35}); }
    const sc = b.ylim[1]/4;                                   // right axis: Δχ²/χ²_red from 0 to 4
    b.line(J.profile.map(p => p.h), ys[0].map(v => v*sc), {color:P.joint, width:1.6});
    b.hline(1*sc, {color:"#6b7280", dash:"4 3", width:0.8});
    [0, 1, 2, 3, 4].forEach(v => { const Y = b.Y(v*sc); F.add(`<line x1="${b.x+b.w}" x2="${b.x+b.w+4}" y1="${Y.toFixed(1)}" y2="${Y.toFixed(1)}" stroke="#111" stroke-width="0.8"/>`); F.text(b.x + b.w + 6, Y + 3.5, String(v), {size:9.5}); });
    F.text(b.x + b.w + 26, b.y + b.h/2, "Δχ² / χ²_red", {anchor:"middle", size:10, rotate:90});
    if(ci){ b.vline(ci.lo, {color:P.joint, dash:"3 3"}); b.vline(ci.hi, {color:P.joint, dash:"3 3"}); }
    if(ref) b.vline(ref.depth, {color:P.ref, dash:"4 3", width:1.3});
    out.push({file:"figS3_depth_scan", title:"Depth scan", svg:F.svg(),
      caption:`Depth scan of the joint inversion: minimum misfit with the depth held fixed (all other unknowns free), normalized by the reduced χ², for the inversion settings used (${mainName(cs)}) and two variants. The dashed horizontal line marks Δχ²/χ²_red = 1, which defines the depth interval ${ci ? `${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)} km` : ""}${ci && (ci.loOpen || ci.hiOpen) ? " (open: depth poorly constrained)" : ""}. (b) Zoom${cs.B ? " with the posterior depth distribution (shaded)" : ""}.${J.depthWarning.length ? " Warning: " + J.depthWarning.join("; ") + "." : ""}`});
  }

  /* Fig. S4 — residuals against epicentral distance */
  {
    const F = new FK.Figure(720, 280);
    const R = ji.codes.map(c => { const s = state.stations[c]; return C.haversineKm(epiJ.lat, epiJ.lon, s.lat, s.lon); });
    const vals = [...J.rp, ...J.rs].filter(Number.isFinite);
    [[J.rp, P.P, "(a) P residuals"], [J.rs, P.S, "(b) S residuals"]].forEach(([r, col, title], k) => {
      const p = F.panel(62 + k*335, 28, 300, 200, {xlim:[0, Math.max(...R)*1.08], ylim:FK.extent([...vals, 0.1, -0.1], 0.1), xlabel:"epicentral distance (km)", ylabel:k ? "" : "T_obs − T_pred (s)", title});
      p.hline(0, {color:"#111", width:0.8});
      ji.codes.forEach((c,i) => { if(!Number.isFinite(r[i])) return; p.marker(R[i], r[i], {m:"o", r:4, fill:isFlag(c) ? "white" : col, stroke:isFlag(c) ? P.ref : "#111", sw:isFlag(c) ? 1.6 : 0.7}); p.label(R[i], r[i], c, {dx:5, dy:-4, size:7.5}); });
    });
    out.push({file:"figS4_residuals_vs_distance", title:"Residuals against distance", svg:F.svg(),
      caption:`P (a) and S (b) residuals of the joint inversion against epicentral distance. A systematic trend with distance indicates that the homogeneous half-space does not represent the velocity structure (e.g. a velocity gradient); ${cs.mainExcl ? `the stations flagged by the Wadati screen (${cs.flagged.join(", ")}) are not used in this solution` : clkC.length ? `residuals of ${clkC.join(", ")} are after the clock correction; flagged stations are shown with open red symbols` : "flagged stations are shown with open red symbols"}.`});
  }

  /* Fig. S5 — velocity sensitivity */
  if(cs.sens.length){
    const F = new FK.Figure(720, 300), V = cs.sensVp, K = cs.sensK;
    const at = (v, k) => cs.sens.find(r => Math.abs(r.Vp - v) < 1e-9 && Math.abs(r.kappa - k) < 1e-9);
    const base = at(V[2], K[2]) || cs.sens[0];
    const maps = [["(a) epicentre shift (km)", r => Math.hypot(r.x - base.x, r.y - base.y), "#f8fafc", "#1d4ed8"], ["(b) depth (km)", r => r.h, "#fef3c7", "#b45309"]];
    maps.forEach(([title, fn, c0, c1], m) => {
      const vals = cs.sens.map(fn), lo = Math.min(...vals), hi = Math.max(...vals);
      const x0 = 70 + m*340, y0 = 34, cw = 52, ch = 38;
      F.text(x0, y0 - 10, title, {size:11.5, bold:true});
      const lerp = t => { const a = [parseInt(c0.slice(1,3),16), parseInt(c0.slice(3,5),16), parseInt(c0.slice(5,7),16)], b = [parseInt(c1.slice(1,3),16), parseInt(c1.slice(3,5),16), parseInt(c1.slice(5,7),16)]; return `rgb(${a.map((v,i) => Math.round(v + (b[i]-v)*t)).join(",")})`; };
      V.forEach((v,i) => K.forEach((k,j) => { const r = at(v, k); if(!r) return; const val = fn(r), t = hi > lo ? (val - lo)/(hi - lo) : 0;
        F.add(`<rect x="${x0 + j*cw}" y="${y0 + (V.length-1-i)*ch}" width="${cw}" height="${ch}" fill="${lerp(t)}" stroke="white"/>`);
        F.text(x0 + j*cw + cw/2, y0 + (V.length-1-i)*ch + 16, val.toFixed(2) + (r.atBound ? "*" : ""), {anchor:"middle", size:10, color:t > 0.6 ? "white" : "#111"});
        F.text(x0 + j*cw + cw/2, y0 + (V.length-1-i)*ch + 29, `${(r.rms*1000).toFixed(0)} ms`, {anchor:"middle", size:8, color:t > 0.6 ? "#e5e7eb" : "#4b5563"}); }));
      K.forEach((k,j) => F.text(x0 + j*cw + cw/2, y0 + V.length*ch + 14, k.toFixed(3), {anchor:"middle", size:9.5}));
      V.forEach((v,i) => F.text(x0 - 6, y0 + (V.length-1-i)*ch + ch/2 + 4, v.toFixed(2), {anchor:"end", size:9.5}));
      F.text(x0 + K.length*cw/2, y0 + V.length*ch + 30, "V_P/V_S (fixed)", {anchor:"middle", size:11});
      F.text(x0 - 40, y0 + V.length*ch/2, "V_P (km/s, fixed)", {anchor:"middle", size:11, rotate:-90});
    });
    out.push({file:"figS5_velocity_sensitivity", title:"Velocity sensitivity", svg:F.svg(),
      caption:`Sensitivity of the joint solution to the velocity model: V_P and V_P/V_S held fixed on a grid around V_P = ${V[2].toFixed(2)} km/s and V_P/V_S = ${K[2].toFixed(3)}. (a) Epicentral shift from the central solution and (b) depth, each with the residual RMS. Asterisks mark solutions at the upper depth bound.`});
  }

  /* Fig. S6 — posterior marginals (only when Bayesian sampling is part of the joint inversion) */
  if(cs.B){
    const F = new FK.Figure(720, 420), s = cs.B.samples, sm = cs.B.summary;
    const Jb = cs.JK && cs.JK.ok ? cs.JK : J;
    const lab = ["x (km)", "y (km)", "depth h (km)", "T_0 − T_ref (s)", "V_P (km/s)", "V_P/V_S"], lsv = [...Jb.m, Jb.kappa];
    for(let k=0;k<6;k++){
      const col = k % 3, row = Math.floor(k/3), v = s.map(q => q[k]), rng = FK.extent(v, 0.05);
      const p = F.panel(55 + col*225, 30 + row*195, 190, 140, {xlim:rng, ylim:[0, 1], xlabel:lab[k], yticks:[], title:`${lab[k].split(" (")[0]}: ${sm[k].med.toFixed(k === 5 ? 3 : 2)} [${sm[k].q16.toFixed(k === 5 ? 3 : 2)}, ${sm[k].q84.toFixed(k === 5 ? 3 : 2)}]`});
      p.ylim = [0, (FK.histMax(v, 40, rng, true) || 1)*1.15];
      p.hist(v, 40, {color:P.bayes, range:rng, density:true, opacity:0.55});
      p.vline(sm[k].q16, {color:P.bayes, dash:"3 3"}); p.vline(sm[k].q84, {color:P.bayes, dash:"3 3"});
      if(Number.isFinite(lsv[k])) p.vline(lsv[k], {color:P.joint, width:1.6});
      if(k === 2 && ref) p.vline(ref.depth, {color:P.ref, dash:"4 3", width:1.3});
    }
    out.push({file:"figS6_posterior", title:"Posterior distributions", svg:F.svg(),
      caption:`Marginal posterior distributions from ${s.length} samples of two Metropolis chains (acceptance ${cs.B.accept.map(a => a.toFixed(2)).join(" and ")}, maximum R̂ = ${Math.max(...cs.B.rhat).toFixed(3)}), with the 16th and 84th percentiles (dashed) and the least-squares estimate with V_P and V_P/V_S estimated, which started the chains (green)${ref ? " and the reference depth (red)" : ""}. x and y are relative to the station centroid.`});
  }
  /* Fig. 9 — evaluation with the recorded data: station subsets and three-station combinations */
  if(cs.subsets && cs.subsets.length){
    const F = new FK.Figure(760, 600), sb = cs.subsets, ns = [...new Set(sb.map(s => s.n))].sort((p,q) => p-q), N = ji.codes.length;
    const jit = s => s.n + 0.36*(((s.codes.join("").split("").reduce((h,ch) => (h*31 + ch.charCodeAt(0)) % 997, 7))/997) - 0.5);
    const ncol = n => ["#a16207", "#c2410c", "#7c3aed", "#2563eb", "#0f766e", "#15803d"][Math.max(0, Math.min(5, n - 4))];
    const sumOf = n => cs.subsetSummary.find(q => q.n === n);
    const hMC = Math.sqrt(C.summarize(cs.mcJ.m.map(v => v[2])).sigma**2);
    // (a) epicentral shift vs number of stations
    const a = F.panel(62, 30, 290, 200, {xlim:[ns[0] - 0.6, ns[ns.length-1] + 0.6], ylim:[0, Math.max(0.5, ...sb.map(s => s.shift))*1.08], xticks:ns, xfmt:v => String(v),
      xlabel:"number of stations", ylabel:"epicentral shift (km)", title:"(a) epicentre, station subsets", ylabelOffset:38});
    a.scatter(sb.map(jit), sb.map(s => s.shift), {r:1.5, fill:"#64748b", opacity:0.45});
    ns.forEach(n => { const q = sumOf(n).shift; a.errY(n, q.med, q.q16, q.q84, {color:"#111", width:1.4}); a.marker(n, q.med, {m:"s", r:3.5, fill:"#111"}); });
    // (b) depth vs number of stations
    const ds = [...sb.map(s => s.depth), J.m[2] + hMC, J.m[2] - hMC, ...(ref ? [ref.depth] : [])];
    const b = F.panel(440, 30, 290, 200, {xlim:[ns[0] - 0.6, ns[ns.length-1] + 0.6], ylim:FK.extent(ds, 0.06), invertY:true, xticks:ns, xfmt:v => String(v),
      xlabel:"number of stations", ylabel:"depth (km)", title:"(b) depth, station subsets", ylabelOffset:34});
    b.clip(`<rect x="${b.x}" y="${Math.min(b.Y(J.m[2] - hMC), b.Y(J.m[2] + hMC)).toFixed(1)}" width="${b.w}" height="${Math.abs(b.Y(J.m[2] + hMC) - b.Y(J.m[2] - hMC)).toFixed(1)}" fill="${P.joint}" opacity="0.12"/>`);
    b.hline(J.m[2], {color:P.joint, width:1.2});
    if(ref) b.hline(ref.depth, {color:P.ref, dash:"4 3", width:1});
    b.scatter(sb.map(jit), sb.map(s => s.depth), {r:1.5, fill:"#64748b", opacity:0.45});
    ns.forEach(n => { const q = sumOf(n).depth; b.errY(n, q.med, q.q16, q.q84, {color:"#111", width:1.4}); b.marker(n, q.med, {m:"s", r:3.5, fill:"#111"}); });
    if(cs.jack) cs.jack.forEach(j => b.marker(N - 1 + 0.42, j.depth, {m:"D", r:3.2, fill:P.bayes, stroke:"#111", sw:0.5}));
    b.legend([{m:"s", fill:"#111", label:"median, 16th–84th pct."}, {m:"D", fill:P.bayes, label:"leave-one-out (all settings)"}, {line:true, color:P.joint, label:`all ${N} stations ± MC σ`}]
      .concat(ref ? [{line:true, color:P.ref, dash:"4 3", label:RND()}] : []), "bl", {width:178});
    // (c) epicentral shift vs azimuthal gap
    const c3 = F.panel(62, 320, 290, 200, {xlim:[0, Math.min(360, Math.max(...sb.map(s => s.gap)) + 10)], ylim:[0, Math.max(0.5, ...sb.map(s => s.shift))*1.08],
      xlabel:"largest azimuthal gap (°)", ylabel:"epicentral shift (km)", title:"(c) epicentre against azimuthal gap", ylabelOffset:38});
    ns.forEach(n => { const v = sb.filter(s => s.n === n); c3.scatter(v.map(s => s.gap), v.map(s => s.shift), {r:1.8, fill:ncol(n), opacity:0.6}); });
    c3.legend(ns.map(n => ({m:"o", r:3, fill:ncol(n), label:`${n} stations`})), "tl", {width:90});
    // (d) three-station combinations: depth against the mean epicentral distance
    const tr = cs.triples.filter(t => t.ok && Number.isFinite(t.depth)), nf = cs.triples.length - tr.length;
    const dd = [...tr.map(t => t.depth), J.m[2], ...(ref ? [ref.depth] : [])];
    const d = F.panel(440, 320, 290, 200, {xlim:[0, Math.max(...cs.triples.map(t => t.meanR))*1.08], ylim:FK.extent(dd, 0.06), invertY:true,
      xlabel:"mean epicentral distance of the three stations (km)", ylabel:"depth (km)", title:"(d) three-station depths (Eq. 11)", ylabelOffset:34});
    d.hline(J.m[2], {color:P.joint, width:1.2}); if(ref) d.hline(ref.depth, {color:P.ref, dash:"4 3", width:1});
    const good = tr.filter(t => t.gap <= 180), poor = tr.filter(t => t.gap > 180);
    d.scatter(poor.map(t => t.meanR), poor.map(t => t.depth), {r:2.2, fill:"#9ca3af", opacity:0.8});
    d.scatter(good.map(t => t.meanR), good.map(t => t.depth), {r:2.4, fill:P.chord, opacity:0.85});
    const ch3 = cs.chordCodes || [], sel = tr.find(t => t.codes.slice().sort().join() === ch3.slice().sort().join());
    if(sel) d.marker(sel.meanR, sel.depth, {m:"o", r:5, fill:"none", stroke:"#111", sw:1.4});
    d.legend([{m:"o", r:3, fill:P.chord, label:"gap ≤ 180°"}, {m:"o", r:3, fill:"#9ca3af", label:"gap > 180°"}].concat(sel ? [{m:"o", fill:"white", stroke:"#111", sw:1.4, label:ch3.join(", ")}] : []), "bl", {width:120});
    const sm = n => { const q = sumOf(n); return `${n}: ${q.shift.med.toFixed(2)} km and ${q.depth.med.toFixed(2)} km [${q.depth.q16.toFixed(2)}–${q.depth.q84.toFixed(2)}]`; };
    out.push({file:"fig9_station_subsets", title:"Station-subset evaluation", svg:F.svg(),
      caption:`Evaluation of the location with the recorded data of ${evTxt}. (a, b) Joint inversions of all ${sb.length} subsets of ${ns[0]}–${ns[ns.length-1]} of the ${N} stations, with V_P = ${J.m[4].toFixed(2)} km/s and V_P/V_S = ${J.kappa.toFixed(3)} of the main solution held fixed and its clock correction(s) applied as station terms: epicentral shift from the ${N}-station solution and depth (grey: individual subsets; squares and bars: median and 16th–84th percentiles; diamonds: leave-one-station-out inversions with all settings of the main solution; green line and band: ${N}-station depth ± Monte Carlo σ). Median shift and depth by number of stations: ${ns.map(sm).join("; ")}. (c) Epicentral shift against the largest azimuthal gap of the subset. (d) Depth from Eq. 11 (converted to below sea level with the mean station elevation) for all ${cs.triples.length} three-station combinations against their mean epicentral distance${nf ? `; ${nf} combinations gave no real depth` : ""}; orange: gap ≤ 180°; circle: the chord stations used in Figs. 3 and 5.`});
  }
  return out;
}
function chordCs(sol){ return state.caseStudy?.chordCodes || []; }
function mainName(cs){ return `${cs.ji.inp.solveVp ? "Vp estimated" : "Vp fixed"}, ${cs.ji.inp.solveKappa ? "Vp/Vs estimated" : "Vp/Vs fixed"}${cs.ji.inp.huber ? ", Huber weights" : ""}`; }
function niceKm(x){ const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-3)))), m = x/p; return +((m >= 5 ? 5 : m >= 2 ? 2 : 1)*p).toPrecision(2); }

/* ---------- results table ---------- */
function resultsTable(cs){
  const f = (v, d) => Number.isFinite(v) ? v.toFixed(d) : "";
  const sg = (v, d) => Number.isFinite(v) ? (v < 0 ? "−" : "+") + Math.abs(v).toFixed(d) : "";
  const dateOf = t => Number.isFinite(t) ? new Date(Math.round(t*1000)).toISOString().slice(0, 10) : "";
  const timeOf = t => Number.isFinite(t) ? new Date(Math.round(t*1000)).toISOString().slice(11, 23) : "";
  const kmDeg = Math.PI/180*C.R_EARTH, pos = v => Number.isFinite(v) && v > 0;
  /* “value ± uncertainty unit”: the uncertainty has two significant figures and fixes the number of decimals of the value */
  const pm = (v, sd, unit, dmin) => {
    if(!Number.isFinite(v)) return "";
    const u = unit || "", sp = u && !u.startsWith("°") ? " " : "";
    if(!pos(sd)) return `${v.toFixed(dmin ?? 2)}${sp}${u} ± n/a`;
    const d = Math.min(6, Math.max(dmin ?? 0, 1 - Math.floor(Math.log10(sd))));
    return `${v.toFixed(d)}${sp}${u} ± ${sd.toFixed(d)}${sp}${u}`;
  };
  const pmT = (t, sd) => !Number.isFinite(t) ? "" : pos(sd) ? `${timeOf(t)} ± ${sd.toFixed(Math.min(6, Math.max(2, 1 - Math.floor(Math.log10(sd)))))} s` : `${timeOf(t)} ± n/a`;
  const UNC = {MC:"Monte Carlo: σ = ½(q84−q16)", mcgeo:"Monte Carlo of the geometric construction: σ = ½(q84−q16)", asym:"asymptotic (local covariance), conditional", post:"posterior: σ = ½(q84−q16)"};
  const head = ["Role", "Method", "Date (UTC)", "Origin time (UTC) ± σ", "Latitude ± σ", "Longitude ± σ", "Depth ± σ", "Depth 16–84% (km)", "Magnitude", "Vp ± σ", "Vp/Vs", "RMS (ms)", "Uncertainty basis",
    "Δ epicentre (km)", "Δ N (km)", "Δ E (km)", "Δ depth (km)", "Δ T0 (s)", "Δ epicentre/σ", "Δ depth/σ", "Δ T0/σ", "Reference source"];
  const ref = cs.rows.find(r => r.method === "ref"), est = cs.rows.filter(r => r.method !== "ref");
  const srcName = k => !ref || !ref.refSources ? "" : ref.refSources[k] === "csv" ? (state.eventCSV ? state.eventCSV.name : "event file") : ref.refSources[k] === "header" ? "SAC header" : "none";
  const rows = [], plain = [];
  if(ref){
    rows.push(["REFERENCE", ref.name, dateOf(ref.To), ref.To ? timeOf(ref.To) : "", f(ref.lat, 4) + "°", f(ref.lon, 4) + "°", f(ref.depth, 2) + " km", "", f(ref.mag, 2), "", "", "", "reference values: no uncertainty provided in the input", "", "", "", "", "", "", "", "",
      `epicentre: ${srcName("epicentre")}; depth: ${srcName("depth")}; origin time: ${srcName("origin")}; magnitude: ${srcName("magnitude")}`]);
    plain.push(["REFERENCE: " + ref.name, dateOf(ref.To), timeOf(ref.To), f(ref.lat, 4), f(ref.lon, 4), f(ref.depth, 2), f(ref.mag, 2)]);
  }
  for(const r of est){
    const sN = r.sYmc ?? r.sY, sE = r.sXmc ?? r.sX, sD = r.sDepthMC ?? r.sDepth, sT = r.sTmc ?? r.sT, sV = r.sVpmc ?? r.sVp;
    const zE = pos(sN) && pos(sE) && Number.isFinite(r.dN) ? Math.hypot(r.dN/sN, r.dE/sE) : NaN, zD = pos(sD) && Number.isFinite(r.dh) ? Math.abs(r.dh)/sD : NaN, zT = pos(sT) && Number.isFinite(r.dT) ? Math.abs(r.dT)/sT : NaN;
    const dep = Number.isFinite(r.depthSL) ? r.depthSL : r.depth, cl = Math.cos(r.lat*Math.PI/180);
    rows.push(["Estimate", r.name + (r.atBound ? " (at depth bound)" : ""), dateOf(r.To), pmT(r.To, sT), pm(r.lat, pos(sN) ? sN/kmDeg : NaN, "°", 4), pm(r.lon, pos(sE) ? sE/(kmDeg*cl) : NaN, "°", 4), pm(dep, sD, "km", 2),
      r.depthQ && Number.isFinite(r.depthQ[0]) ? `${r.depthQ[0].toFixed(2)}–${r.depthQ[1].toFixed(2)}` : "", "", Number.isFinite(r.Vp) ? pm(r.Vp, sV, "km/s", 2) : "", f(r.kappa, 3), f(r.rms, 0), UNC[r.unc] || "",
      f(r.offset, 2), sg(r.dN, 2), sg(r.dE, 2), sg(r.dh, 2), sg(r.dT, 2), f(zE, 1), f(zD, 1), f(zT, 1), ""]);
    plain.push([r.name, dateOf(r.To), timeOf(r.To), f(r.lat, 4), f(r.lon, 4), f(dep, 2), ""]);
  }
  const notes = [
    "Reference (shown separately, highlighted): hypocentre read from the SAC headers and/or the event file, with the source of every parameter; the inputs carry no uncertainties. Magnitude is a reference parameter only: none of the methods estimates it.",
    "Estimates are given as value ± uncertainty. The uncertainty has two significant figures and sets the decimals of the value; latitude and longitude uncertainties are the north and east standard deviations in km converted to degrees; n/a: the method provides no uncertainty for that parameter. Depth is below sea level when station elevations are used (the three-circle depth of Eq. 11 is converted with the mean elevation of its three stations).",
    "Δ = estimate − reference (N, E positive to the north and east). Δ/σ is the deviation in units of the estimate's own uncertainty (epicentre: √[(ΔN/σN)² + (ΔE/σE)²]); the reference uncertainty is unknown, so these ratios test consistency under the conditional σ, not accuracy.",
    "Origin times of the three-circle and sphere solutions, which use S−P times only, are computed from the P arrivals at the solution (mean over the stations used, station clock terms applied); no σ T0 is given for them.",
    "Monte Carlo and posterior σ are conditional on the model, the selected stations and the nominal pick errors; asymptotic σ additionally assume a linear model and fixed Vp/Vs where stated. None includes the loss of a station or velocity-model error (see the jackknife and velocity-grid results)."];
  const esc = v => /[,"\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const csv = [head, ...rows].map(r => r.map(esc).join(",")).join("\n");
  const md = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map(r => `| ${r.join(" | ")} |`), "", ...notes.map(n => "* " + n)].join("\n");
  const simple = ["Method,Date,Origin Time,Latitude,Longitude,Depth,Magnitude", ...plain.map(r => r.map(esc).join(","))].join("\n");
  const refCsv = ref ? ["Date,Origin Time,Latitude,Longitude,Depth,Magnitude", [dateOf(ref.To), timeOf(ref.To), f(ref.lat, 4), f(ref.lon, 4), f(ref.depth, 2), f(ref.mag, 2)].join(",")].join("\n") : "";
  // separate display tables: the reference and the estimates
  const refHead = ["Role", "Reference", "Date (UTC)", "Origin time (UTC)", "Latitude", "Longitude", "Depth", "Magnitude", "Source of each parameter"];
  const refRows = ref ? [[rows[0][0], rows[0][1], rows[0][2], rows[0][3], rows[0][4], rows[0][5], rows[0][6], rows[0][8], rows[0][21]]] : [];
  const keep = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const estHead = keep.map(i => head[i]), estRows = rows.filter(r => r[0] === "Estimate").map(r => keep.map(i => r[i]));
  return {head, rows, csv, md, notes, simple, refCsv, refHead, refRows, estHead, estRows};
}

/* ---------- gallery and export ---------- */
function renderGallery(cs){
  const g = els.figGallery; g.innerHTML = "";
  const T = resultsTable(cs);
  const mk = (head, rows, style) => { const w = document.createElement("div"); w.className = "tblwrap"; w.style.maxHeight = "none"; w.style.marginBottom = "10px";
    w.innerHTML = `<table><thead><tr>${head.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr${style ? ` style="${style}"` : ""}>${r.map((v, i) => `<td class="${i > 1 ? "mono" : ""}" style="white-space:${i === 1 || String(v).length > 40 ? "normal" : "nowrap"}">${escapeHtml(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`; return w; };
  const th = document.createElement("div"); th.className = "small"; th.style.cssText = "grid-column:1/-1;margin:6px 0 4px"; th.innerHTML = "<b>Reference hypocentre</b> (input values, no uncertainty)"; g.appendChild(th);
  if(T.refRows.length) g.appendChild(mk(T.refHead, T.refRows, "background:#fff3cd;font-weight:600")); else { const nr = document.createElement("div"); nr.className = "small"; nr.textContent = "No reference hypocentre available."; g.appendChild(nr); }
  const te = document.createElement("div"); te.className = "small"; te.style.cssText = "grid-column:1/-1;margin:6px 0 4px"; te.innerHTML = "<b>Estimated hypocentres</b> (value ± uncertainty; deviations from the reference)"; g.appendChild(te);
  g.appendChild(mk(T.estHead, T.estRows, ""));
  const tn = document.createElement("div"); tn.className = "small"; tn.style.cssText = "grid-column:1/-1;margin:6px 0 12px"; tn.innerHTML = T.notes.map(escapeHtml).join(" "); g.appendChild(tn);
  cs.figures.forEach((fg, k) => {
    const card = document.createElement("div"); card.className = "figcard";
    card.innerHTML = `<div class="figimg">${fg.svg}</div><div class="small"><b>${escapeHtml(fg.file)}</b> — ${escapeHtml(fg.caption)}</div>`;
    const row = document.createElement("div"); row.className = "row";
    const b1 = document.createElement("button"); b1.className = "btn gray"; b1.textContent = "SVG"; b1.onclick = () => download(fg.file + ".svg", fg.svg, "image/svg+xml");
    const b2 = document.createElement("button"); b2.className = "btn gray"; b2.textContent = "PNG (300 dpi)";
    b2.onclick = async () => { const b = await FigKit.svgToPng(fg.svg, 3); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = fg.file + ".png"; a.click(); };
    row.append(b1, b2); card.appendChild(row); g.appendChild(card);
  });
  els.btnFigZip.disabled = false; els.btnGMT.disabled = false;
}
async function downloadAllFigures(){
  const cs = state.caseStudy; if(!cs) return;
  els.caseStatus.textContent = "Rasterizing figures and writing the ZIP …";
  const T = resultsTable(cs), files = [];
  for(const fg of cs.figures){ files.push({name:`figures/${fg.file}.svg`, data:fg.svg}); files.push({name:`figures/${fg.file}.png`, data:await FigKit.svgToPng(fg.svg, 3)}); }
  files.push({name:"results/hypocentre_comparison.csv", data:T.csv}, {name:"results/hypocentre_comparison.md", data:T.md}, {name:"results/hypocentre_comparison_simple.csv", data:T.simple}, {name:"results/solutions.csv", data:T.csv}, {name:"results/solutions.md", data:T.md});
  if(T.refCsv) files.push({name:"results/reference_hypocentre.csv", data:T.refCsv});
  const csvOf = (rows, cols) => [cols.join(","), ...rows.map(r => cols.map(k => { const v = r[k]; return typeof v === "number" ? (Number.isFinite(v) ? +v.toFixed(4) : "") : Array.isArray(v) ? v.join(" ") : `"${String(v ?? "").replace(/"/g,'""')}"`; }).join(","))].join("\n");
  if(cs.jack) files.push({name:"results/jackknife.csv", data:csvOf(cs.jack, ["removed","lat","lon","depth","dh","shift","Vp","kappa","rms","clock","resolution"])});
  if(cs.subsets) files.push({name:"results/station_subsets.csv", data:csvOf(cs.subsets, ["n","codes","shift","depth","dh","gap","rms","unresolved"])});
  if(cs.triples) files.push({name:"results/three_station_combinations.csv", data:csvOf(cs.triples, ["codes","ok","shift","depth","sphere","meanR","gap"])});
  if(cs.gmap) files.push({name:"results/apparent_velocity_map.csv", data:csvOf(cs.gmap.rows, ["V","gAll","gChord","depth","sphere"])});
  files.push({name:"captions.txt", data:cs.figures.map(fg => `${fg.file}: ${fg.caption}`).join("\n\n") + "\n"});
  files.push({name:"results/case_study.json", data:JSON.stringify({created:cs.created, app:"EQLocate", author:"Ali Attia", version:APP_VERSION, settings:cs.settings, reference:cs.reference, flagged:cs.flagged,
    chordStations:cs.chordCodes, solutions:cs.rows, wadati:cs.W ? {VpVs:cs.W.kappa, se:cs.W.seKappa, To:cs.W.To, seTo:cs.W.seTo, n:cs.W.n, method:cs.W.method} : null,
    depthScan:cs.J.profile.map(p => ({h:p.h, chi2:p.chi2})), depthInterval:cs.J.profileCI, depthWarnings:cs.J.depthWarning,
    apparentVp:cs.vpEst ? {Vp:cs.vpEst.Vp, sigmaMC:cs.vpEst.sigmaMC, sigma:cs.vpEst.sigma, kappa:cs.vpEst.kappa, depth:cs.vpEst.depth, reliable:cs.vpEst.reliable,
      corrHVp:cs.vpEst.corrHVp, travelTimeCurve:cs.vpEst.tt, warnings:cs.vpEst.warnings, stations:cs.vpEst.codes, mode:els.vpEstMode.value} : null,
    mainWithoutFlagged:cs.mainExcl, mainStations:cs.ji.codes, timingTest:cs.timing || [], sphereStations:cs.spCodes,
    clockTerms:cs.J.clockTerms.map(t => ({station:cs.ji.codes[t.i], c:t.c, sigma:t.sigma})), clockTests:(cs.J.clockTests || []).map(t => ({...t, station:cs.ji.codes[t.station]})),
    wadatiRefit:cs.J.wadatiRefit || null, depthResolution:cs.J.depthResolution ? {...cs.J.depthResolution, nearest:cs.ji.codes[cs.J.depthResolution.nearest]} : null,
    wadatiComparison:cs.WE && cs.WE.ok ? {stations:cs.jiE.ps, VpVs:cs.WE.kappa, se:cs.WE.seKappa, To:cs.WE.To, seTo:cs.WE.seTo} : null,
    jackknife:cs.jack || null, jackknifeSigma:cs.jackSigma || null, subsetSummary:cs.subsetSummary || null, apparentVelocity:cs.gmap ? {codes:cs.gmap.codes, To:cs.gmap.To, fixedPoints:cs.gmap.fixedPoints} : null,
    threeStation:cs.triples ? {n:cs.triples.length, ok:cs.triples.filter(t => t.ok && Number.isFinite(t.depth)).length,
      depth:C.summarize(cs.triples.filter(t => t.ok && Number.isFinite(t.depth)).map(t => t.depth)), depthGap180:C.summarize(cs.triples.filter(t => t.ok && Number.isFinite(t.depth) && t.gap <= 180).map(t => t.depth)),
      shift:C.summarize(cs.triples.filter(t => t.ok).map(t => t.shift))} : null,
    sensitivity:cs.sens, posterior:cs.B ? {summary:cs.B.summary, rhat:cs.B.rhat, accept:cs.B.accept} : null, bayesianSampling:!!cs.B, seconds:cs.seconds}, (k,v) => (typeof v === "number" && !Number.isFinite(v)) ? null : v, 2)});
  files.push({name:"results/session.json", data:sessionJSON()});
  try{ files.push(...GMTMaps.build(cs, state, {bg:els.gmtBg.value})); }catch(e){ console.error("GMT package", e); }
  const z = await FigKit.zip(files);
  const a = document.createElement("a"); a.href = URL.createObjectURL(z); a.download = "eq_location_case_study.zip"; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  els.caseStatus.textContent = `Saved eq_location_case_study.zip (${cs.figures.length} figures as SVG and 300-dpi PNG, solutions table, captions, session).`;
}
els.btnCase.onclick = () => runCaseStudy();
els.btnFigZip.onclick = () => downloadAllFigures();
/* GMT publication maps: data, regions and script as one ZIP (run with GMT 6 on the user's computer) */
async function downloadGMT(){
  const cs = state.caseStudy; if(!cs){ alert("Run the case study first."); return; }
  let files;
  try{ files = GMTMaps.build(cs, state, {bg:els.gmtBg.value}).map(f => ({...f, name:f.name.replace(/^gmt\//, "eqlocate_gmt_maps/")})); }
  catch(e){ alert("The GMT package could not be built: " + e.message); return; }
  const z = await FigKit.zip(files);
  const a = document.createElement("a"); a.href = URL.createObjectURL(z); a.download = "eq_location_gmt_maps.zip"; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  els.caseStatus.textContent = `Saved eq_location_gmt_maps.zip: run “bash make_maps.sh” with GMT 6 to draw G1–G3 (${files.length} files).`;
}
els.btnGMT.onclick = () => downloadGMT();
