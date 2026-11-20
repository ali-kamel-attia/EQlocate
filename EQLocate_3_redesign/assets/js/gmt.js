/* ---------- GMT publication maps ----------
   Builds a self-contained Generic Mapping Tools (GMT ≥ 6.1) package from the case study: data tables, map regions chosen so
   that every symbol is inside the frame, empty corners for the inset and the scale bar, and a bash script that draws
     G1  location overview: map + two depth cross-sections + locator inset,
     G2  three-circle construction: S−P circles, radical axes and the geometric solutions,
     G3  epicentre uncertainty: Monte Carlo, Bayesian posterior, jackknife and velocity sensitivity (three aligned panels).
   Backgrounds: GMT satellite imagery (@earth_day) shaded with SRTM relief (@earth_relief), SRTM shaded relief, a user GeoTIFF
   (any resolution, e.g. Sentinel-2) or coastlines only (offline). Author: Ali Attia. */
const GMTMaps = (function(){
"use strict";
const KM = Math.PI/180*6371.0;
const fin = Number.isFinite;
const f6 = v => (+v).toFixed(6), f3 = v => (+v).toFixed(3), f2 = v => (+v).toFixed(2);
const niceStep = raw => { const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw/p; return (m >= 5 ? 5 : m >= 2 ? 2 : 1)*p; };

/* region around a set of points: padded, minimum size, aspect kept between 0.7 and 1.35 (height/width), rounded outward */
function region(pts, opt){
  opt = opt || {};
  const la = pts.map(p => p[1]).filter(fin), lo = pts.map(p => p[0]).filter(fin);
  let S = Math.min(...la), N = Math.max(...la), W = Math.min(...lo), E = Math.max(...lo);
  const lat0 = (S + N)/2, kx = KM*Math.cos(lat0*Math.PI/180);
  let wk = (E - W)*kx, hk = (N - S)*KM;
  const pad = opt.pad ?? 0.12, minKm = opt.minKm ?? 10;
  wk = Math.max(minKm, wk*(1 + 2*pad)); hk = Math.max(minKm, hk*(1 + 2*pad));
  const lo2 = opt.aspectLo ?? 0.7, hi2 = opt.aspectHi ?? 1.35;
  if(hk/wk < lo2) hk = wk*lo2; if(hk/wk > hi2) wk = hk/hi2;
  const cx = (W + E)/2, cy = (S + N)/2;
  const spanDeg = Math.max(wk/kx, hk/KM), step = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.05, 0.1].find(v => spanDeg/v >= 30) ? [0.1, 0.05, 0.01, 0.005, 0.002, 0.001, 0.0005, 0.0002, 0.0001].find(v => spanDeg/v >= 30) : 0.0001;
  const r = {W:Math.floor((cx - wk/2/kx)/step)*step, E:Math.ceil((cx + wk/2/kx)/step)*step, S:Math.floor((cy - hk/2/KM)/step)*step, N:Math.ceil((cy + hk/2/KM)/step)*step};
  const dp = Math.max(2, Math.ceil(-Math.log10(step) - 1e-9));
  r.str = `${r.W.toFixed(dp)}/${r.E.toFixed(dp)}/${r.S.toFixed(dp)}/${r.N.toFixed(dp)}`;
  r.wKm = (r.E - r.W)*KM*Math.cos((r.S + r.N)/2*Math.PI/180); r.hKm = (r.N - r.S)*KM;
  return r;
}
/* corners ordered from emptiest to fullest (fraction of the frame width checked: 32 % × 30 %) */
function freeCorners(r, pts){
  const cs = {BL:[0,0], BR:[1,0], TL:[0,1], TR:[1,1]}, score = {};
  for(const [k, [cx, cy]] of Object.entries(cs)){
    let n = 0;
    for(const [lon, lat] of pts){
      const u = (lon - r.W)/(r.E - r.W), v = (lat - r.S)/(r.N - r.S);
      if((cx ? u > 0.68 : u < 0.32) && (cy ? v > 0.70 : v < 0.30)) n++;
    }
    score[k] = n;
  }
  return Object.keys(cs).sort((a, b) => score[a] - score[b] || "BRBLTRTL".indexOf(a) - "BRBLTRTL".indexOf(b));
}
const CIRC = ["#b2182b", "#2166ac", "#1b7837", "#762a83", "#e08214", "#01665e"];
const table = (head, rows) => `# ${head}\n` + rows.map(r => r.join(" ")).join("\n") + "\n";
function cov2(pts){   // pts: [{x,y}] km
  const n = pts.length; if(n < 5) return null;
  const mx = pts.reduce((a, p) => a + p.x, 0)/n, my = pts.reduce((a, p) => a + p.y, 0)/n;
  let xx = 0, yy = 0, xy = 0; for(const p of pts){ xx += (p.x - mx)**2; yy += (p.y - my)**2; xy += (p.x - mx)*(p.y - my); }
  return {mx, my, cxx:xx/(n - 1), cyy:yy/(n - 1), cxy:xy/(n - 1)};
}

function build(cs, st, opts){
  opts = opts || {};
  const C = LocCore, ji = cs.ji, J = cs.J, c0 = ji.c0, ref = st.reference;
  const LL = (x, y) => C.xyToLatLon(x, y, c0.lat, c0.lon), XY = (lat, lon) => C.equirectXY(lat, lon, c0.lat, c0.lon);
  const files = [], put = (name, data) => files.push({name:"gmt/" + name, data});
  const epi = LL(J.m[0], J.m[1]);
  const codes = st.order.filter(c => fin(st.stations[c].lat) && fin(st.stations[c].lon));
  const staPts = codes.map(c => [st.stations[c].lon, st.stations[c].lat]);

  // ---- stations
  put("data/stations.txt", table("lon lat elev_m code used_in_joint_LS", codes.map(c => { const s = st.stations[c];
    return [f6(s.lon), f6(s.lat), fin(s.elev_m) ? s.elev_m.toFixed(0) : "0", c, ji.codes.includes(c) ? 1 : 0]; })));
  // ---- solutions (symbol classes for the legend)
  const SYM = {joint:"main", jointK:"var", jointV:"var", jointH:"var", jointR:"var", jointE:"var", jointN:"var", chord:"chord", sphere3:"sphere", sphereN:"sphere", bayes:"bayes"};
  const sol = cs.rows.filter(r => r.method !== "ref" && fin(r.lat) && fin(r.lon));
  const depOf = r => fin(r.depthSL) ? r.depthSL : r.depth;
  put("data/solutions.txt", table("lon lat depth_km sigma_depth_km class name", sol.map(r => [f6(r.lon), f6(r.lat), fin(depOf(r)) ? f3(depOf(r)) : "NaN",
    fin(r.sDepth) ? f3(r.sDepth) : "0", SYM[r.method] || "var", JSON.stringify(r.name).replace(/\s+/g, "_")])));
  for(const k of ["main", "var", "chord", "sphere", "bayes"])
    put(`data/sol_${k}.txt`, table("lon lat depth_km sigma_depth_km", sol.filter(r => (SYM[r.method] || "var") === k).map(r => [f6(r.lon), f6(r.lat), fin(depOf(r)) ? f3(depOf(r)) : "NaN", fin(r.sDepth) ? f3(r.sDepth) : "0"])));
  if(ref && fin(ref.lat)) put("data/reference.txt", table("lon lat depth_km", [[f6(ref.lon), f6(ref.lat), fin(ref.depth) ? f3(ref.depth) : "NaN"]]));
  else put("data/reference.txt", "# lon lat depth_km (no reference)\n");

  // ---- error ellipses (1σ, 2σ) of the joint inversion from its Monte Carlo cloud, and of the three-circle Monte Carlo
  const mcJ = (cs.mcJ && cs.mcJ.m || []).map(v => ({x:v[0], y:v[1], h:v[2]}));
  const ellipseFile = (cv, cx, cy) => { const e = C.errorEllipse(cv.cxx, cv.cxy, cv.cyy);
    return [1, 2].map(k => "> -Z" + k + "\n" + C.ellipsePolygon(cx, cy, e, k === 1 ? 1 : 2.4477, 120).map(p => { const q = LL(p.x, p.y); return `${f6(q.lon)} ${f6(q.lat)}`; }).join("\n")).join("\n") + "\n"; };
  const cvJ = cov2(mcJ) || {cxx:J.cov[0][0], cyy:J.cov[1][1], cxy:J.cov[0][1]};
  put("data/ellipse_joint.txt", "# 1-sigma (-Z1) and 95 % (-Z2, 2.4477 sigma) error ellipses of the joint LS epicentre, Monte Carlo covariance\n" + ellipseFile(cvJ, J.m[0], J.m[1]));
  const thin = (a, n) => a.length <= n ? a : a.filter((_, i) => i % Math.ceil(a.length/n) === 0);
  put("data/mc_joint.txt", table("lon lat depth_km  (Monte Carlo trials of the joint inversion)", thin(mcJ, 3000).map(p => { const q = LL(p.x, p.y); return [f6(q.lon), f6(q.lat), f3(p.h)]; })));
  let mcC = [];
  if(cs.mcC && cs.mcC.lat){ mcC = cs.mcC.lat.map((la, i) => ({lat:la, lon:cs.mcC.lon[i]})).filter(p => fin(p.lat) && fin(p.lon)); }
  put("data/mc_chord.txt", table("lon lat  (Monte Carlo trials of the three-circle epicentre)", thin(mcC, 3000).map(p => [f6(p.lon), f6(p.lat)])));
  const cvC = cov2(mcC.map(p => XY(p.lat, p.lon)));
  if(cvC && cs.chord && cs.chord.ok){ const q = XY(cs.chord.epi.lat, cs.chord.epi.lon); put("data/ellipse_chord.txt", "# 1-sigma and 95 % ellipses of the three-circle epicentre (Monte Carlo)\n" + ellipseFile(cvC, q.x, q.y)); }
  else put("data/ellipse_chord.txt", "# none\n");
  // ---- Bayesian posterior, jackknife, velocity sensitivity
  const post = cs.B && cs.B.samples ? thin(cs.B.samples, 4000).map(v => { const q = LL(v[0], v[1]); return [q.lon, q.lat, v[2]]; }) : [];
  put("data/posterior.txt", table("lon lat depth_km  (posterior samples, thinned)", post.map(p => [f6(p[0]), f6(p[1]), f3(p[2])])));
  const jack = (cs.jack || []).filter(j => fin(j.lat));
  put("data/jackknife.txt", table("lon lat depth_km removed_station", jack.map(j => [f6(j.lon), f6(j.lat), f3(j.depth), "-" + j.removed])));
  const sens = (cs.sens || []).map(r => { const q = LL(r.x, r.y); return {lon:q.lon, lat:q.lat, Vp:r.Vp, k:r.kappa, h:r.h}; });
  put("data/sensitivity.txt", table("lon lat Vp_km_s VpVs depth_km  (joint solution with the velocities held fixed)", sens.map(s => [f6(s.lon), f6(s.lat), f3(s.Vp), f3(s.k), f3(s.h)])));

  // ---- three-circle construction: S−P circles (Dhyp), radical axes, circle stations
  let circPts = [], ch = cs.chord && cs.chord.ok ? cs.chord : null;
  if(ch){
    const cc = ch.c0, L2 = (x, y) => C.xyToLatLon(x, y, cc.lat, cc.lon);
    const segs = [];
    ch.C.forEach((c, i) => { const ring = []; for(let k = 0; k <= 180; k++){ const t = 2*Math.PI*k/180, q = L2(c.x + ch.D[i]*Math.cos(t), c.y + ch.D[i]*Math.sin(t)); ring.push(`${f6(q.lon)} ${f6(q.lat)}`); circPts.push([q.lon, q.lat]); }
      segs.push(`> -W1.2p,${CIRC[i % CIRC.length]} -L"${cs.chordCodes[i]}"\n` + ring.join("\n")); });
    put("data/circles.txt", "# S-P circles of radius Dhyp = dt*Vp/(Vp/Vs-1) around the three-circle stations (-Z = station index)\n" + segs.join("\n") + "\n");
    put("data/radical_axes.txt", "# radical axes of the circle pairs; -Z1 = the two circles intersect, -Z0 = they do not\n" + ch.segs.filter(g => g && g.p1).map(g => { const a = L2(g.p1.x, g.p1.y), b = L2(g.p2.x, g.p2.y);
      return `> -Z${g.intersecting ? 1 : 0}\n${f6(a.lon)} ${f6(a.lat)}\n${f6(b.lon)} ${f6(b.lat)}`; }).join("\n") + "\n");
    put("data/circle_stations.txt", table("lon lat code Dhyp_km S-P_s", cs.chordCodes.slice(0, ch.D.length).map((c, i) => [f6(st.stations[c].lon), f6(st.stations[c].lat), c, f2(ch.D[i]), f3(st.picks[c].s - st.picks[c].p)])));
  }

  // ---- regions
  const mainPts = [...staPts, ...sol.map(r => [r.lon, r.lat]), ...(ref && fin(ref.lat) ? [[ref.lon, ref.lat]] : [])];
  let R1 = region(mainPts, {pad:0.14, minKm:12, aspectLo:0.72, aspectHi:1.25});
  let R2 = region(ch ? [...circPts, ...staPts.filter((_, i) => cs.chordCodes.includes(codes[i]))] : mainPts, {pad:0.04, minKm:12, aspectLo:0.75, aspectHi:1.2});
  // zoom: 98 % of every cloud around the joint epicentre, square
  const dist = (lon, lat) => { const q = XY(lat, lon); return Math.hypot(q.x - J.m[0], q.y - J.m[1]); };
  const q98 = a => { const s = a.filter(fin).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(0.98*s.length))] : 0; };
  const eJ = C.errorEllipse(cvJ.cxx, cvJ.cxy, cvJ.cyy);
  const half = Math.max(1.2, 1.18*Math.max(q98(mcJ.map(p => Math.hypot(p.x - J.m[0], p.y - J.m[1]))), q98(mcC.map(p => dist(p.lon, p.lat))), q98(post.map(p => dist(p[0], p[1]))),
    ...jack.map(j => dist(j.lon, j.lat)), ...sens.map(s => dist(s.lon, s.lat)), 2.45*eJ.a, ...(ref && fin(ref.lat) ? [dist(ref.lon, ref.lat)] : []), ...sol.filter(r => r.method !== "sphereN").map(r => dist(r.lon, r.lat)).filter(d => d < 15)));
  const zc = [epi.lon, epi.lat], zk = half;
  let R3 = region([[zc[0] - zk/(KM*Math.cos(epi.lat*Math.PI/180)), zc[1] - zk/KM], [zc[0] + zk/(KM*Math.cos(epi.lat*Math.PI/180)), zc[1] + zk/KM]], {pad:0, minKm:2.4, aspectLo:0.98, aspectHi:1.02});
  const half4 = Math.max(0.35, 1.25*Math.max(q98(post.map(p => dist(p[0], p[1]))), ...jack.map(j => dist(j.lon, j.lat)), ...sens.map(s => dist(s.lon, s.lat)), 2.45*eJ.a));
  let R4 = region([[zc[0] - half4/(KM*Math.cos(epi.lat*Math.PI/180)), zc[1] - half4/KM], [zc[0] + half4/(KM*Math.cos(epi.lat*Math.PI/180)), zc[1] + half4/KM]], {pad:0, minKm:0.7, aspectLo:0.98, aspectHi:1.02});
  const cor1 = freeCorners(R1, mainPts), cor2 = freeCorners(R2, ch ? [...circPts, ...mainPts] : mainPts);
  const cor3 = freeCorners(R3, [...mcJ.map(p => { const q = LL(p.x, p.y); return [q.lon, q.lat]; }), ...mcC.map(p => [p.lon, p.lat]), [epi.lon, epi.lat]]);
  const scaleKm = r => niceStep(r.wKm/4.5);
  // depth axis of the sections
  const deps = sol.map(r => depOf(r) + 2*(fin(r.sDepth) ? r.sDepth : 0)).filter(fin);
  const zmax = Math.max(10, Math.ceil(Math.max(...deps, ref && fin(ref.depth) ? ref.depth + 1 : 0)*1.25/5)*5);
  const elevMax = Math.max(0, ...codes.map(c => fin(st.stations[c].elev_m) ? st.stations[c].elev_m/1000 : 0));
  const ztop = -Math.max(0.5, Math.ceil(elevMax*2 + 0.5)/2);
  const span = Math.max(R1.E - R1.W, R1.N - R1.S);
  const tick = (r, nMax) => { const sp = Math.max(r.E - r.W, r.N - r.S), t = [0.001, 0.002, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5].find(v => sp/v <= (nMax || 5.5)) || 5;
    const dec = (String(t).split(".")[1] || "").length;
    return {a:t, f:t/(String(t).includes("25") ? 5 : t >= 1 ? 4 : 2), fmt:dec ? "ddd." + "x".repeat(dec) : "ddd"}; };
  /* grow a region symmetrically (same factor in both directions, so a square stays square) until no annotated tick lies
     within 18 % of a tick interval from an edge: annotations of the two axes then never meet in a corner */
  const clear = (r, t, frac) => {
    const cx = (r.W + r.E)/2, cy = (r.S + r.N)/2, hx = (r.E - r.W)/2, hy = (r.N - r.S)/2, a = t.a;
    const near = (v, f) => Math.abs(v/a - Math.round(v/a)) < f;
    for(let f = frac; f >= 0.05; f -= 0.05)             // relax the clearance rather than enlarge the map by more than 15 %
      for(let k = 0; k <= 30; k++){
        const g = 1 + 0.005*k, W = cx - hx*g, E = cx + hx*g, S = cy - hy*g, N = cy + hy*g;
        if(!near(W, f) && !near(E, f) && !near(S, f) && !near(N, f)){
          const dp = Math.max(3, (String(a).split(".")[1] || "").length + 2);
          return {...r, W, E, S, N, wKm:r.wKm*g, hKm:r.hKm*g, str:`${W.toFixed(dp)}/${E.toFixed(dp)}/${S.toFixed(dp)}/${N.toFixed(dp)}`};
        }
      }
    return r;
  };

  const t1 = tick(R1), t2 = tick(R2), t3 = tick(R3, 3.2), t4 = tick(R4, 3.2);
  R1 = clear(R1, t1, 0.24); R2 = clear(R2, t2, 0.24); R3 = clear(R3, t3, 0.42); R4 = clear(R4, t4, 0.42);
  /* custom axis annotations (value, a|f, label): exact decimals and hemisphere letters on every map and section axis */
  const axis = (name, lo, hi, t, pos, neg) => {
    const dec = (String(t.a).split(".")[1] || "").length, out = [];
    for(let k = Math.ceil(lo/t.f - 1e-9); k*t.f <= hi + 1e-12; k++){
      const v = +(k*t.f).toFixed(10), isA = Math.abs(v/t.a - Math.round(v/t.a)) < 1e-6;
      out.push(isA ? `${v} a ${Math.abs(v).toFixed(dec)}@.${v >= 0 ? pos : neg}` : `${v} f`);
    }
    put(`data/axis_${name}.txt`, out.join("\n") + "\n");
  };
  axis("g1x", R1.W, R1.E, t1, "E", "W"); axis("g1y", R1.S, R1.N, t1, "N", "S");
  axis("g2x", R2.W, R2.E, t2, "E", "W"); axis("g2y", R2.S, R2.N, t2, "N", "S");
  axis("g3x", R3.W, R3.E, t3, "E", "W"); axis("g3y", R3.S, R3.N, t3, "N", "S");
  axis("g4x", R4.W, R4.E, t4, "E", "W"); axis("g4y", R4.S, R4.N, t4, "N", "S");
  const meta = {epi, R1, R2, R3, R4, t1, t2, t3, t4, scale4:niceStep(R4.wKm/4), cor1, cor2, cor3, zmax, ztop, scale1:scaleKm(R1), scale2:scaleKm(R2), scale3:niceStep(R3.wKm/4),
    dayRes:span < 4 ? "30s" : span < 8 ? "01m" : "02m", relRes:span < 1.6 ? "01s" : span < 4 ? "03s" : "15s", zoomRelRes:"01s",
    inset:{lon:(R1.W + R1.E)/2, lat:(R1.S + R1.N)/2, half:Math.max(3, span*5)},
    hasChord:!!ch, nChord:ch ? ch.D.length : 0, hasPost:post.length > 0, hasSens:sens.length > 0, hasJack:jack.length > 0, hasRef:!!(ref && fin(ref.lat)),
    vp:sens.length ? [Math.min(...sens.map(s => s.Vp)), Math.max(...sens.map(s => s.Vp))] : [5, 7]};
  const pdS = post.map(p => p[2]).sort((a, b) => a - b);
  meta.pd = pdS.length ? [Math.max(0, Math.floor(pdS[Math.floor(0.01*pdS.length)])), Math.ceil(pdS[Math.floor(0.99*pdS.length)])] : [0, 10];
  if(meta.pd[1] - meta.pd[0] < 2) meta.pd[1] = meta.pd[0] + 2;
  if(meta.vp[1] - meta.vp[0] < 0.2){ meta.vp[0] -= 0.1; meta.vp[1] += 0.1; }
  meta.bg = ["satellite", "relief", "image", "plain"].includes(opts.bg) ? opts.bg : "satellite";
  put("make_maps.sh", script(meta, cs));
  put("README.txt", readme(meta));
  return files;
}

/* ---------- the GMT script ---------- */
function script(m, cs){
  const T = s => s.replace(/^\n/, "");
  const ins = m.cor1[0], sc2 = m.cor2[0], sc3 = m.cor3[0];
  const off = c => c.includes("B") ? "+o0.25c/0.32c" : "+o0.25c/0.25c";
  const date = new Date().toISOString().slice(0, 10);
  return T(`
#!/usr/bin/env bash
# =====================================================================================================
#  EQLocate ${APP_VERSION} — publication maps with GMT (Generic Mapping Tools, version 6.1 or newer)
#  Author: Ali Attia · generated ${date} from the case study (all data in ./data, regions computed by EQLocate)
#
#  Usage   bash make_maps.sh                      satellite imagery (@earth_day) shaded with SRTM relief  [default]
#          BG=relief bash make_maps.sh            SRTM shaded relief (1 arc-second, ~30 m)
#          BG=image IMG=scene.tif bash make_maps.sh   your own high-resolution GeoTIFF (e.g. Sentinel-2 true colour,
#                                                 any resolution, WGS84 / EPSG:4326) shaded with SRTM relief
#          BG=plain bash make_maps.sh             coastlines only (no download, works offline)
#          DPI=1200 FMT=pdf,png,eps bash make_maps.sh
#  Output  G1_location_overview, G2_three_circles, G3_epicentre_uncertainty  (vector PDF + raster PNG)
#  Remote data (@earth_day, @earth_relief) are downloaded once from the GMT data server and cached in ~/.gmt/server.
#  If a download fails the script falls back to relief, then to coastlines, so it always produces the figures.
# =====================================================================================================
set -u
cd "$(dirname "$0")"
command -v gmt >/dev/null 2>&1 || { echo "GMT 6 is required: https://www.generic-mapping-tools.org"; exit 1; }
BG=\${BG:-${m.bg}}; IMG=\${IMG:-}; DPI=\${DPI:-600}; FMT=\${FMT:-pdf,png}
[ "$BG" = image ] && [ ! -f "$IMG" ] && { echo "BG=image needs IMG=<GeoTIFF>"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export GMT_SESSION_NAME="eqlocate_$$_\${RANDOM}"           # private GMT session: never mixes with other or stale sessions

# ---------------- geometry (from EQLocate) ----------------
R1=${m.R1.str}        # G1 map region (stations + all solutions)
R2=${m.R2.str}        # G2 region (S-P circles)
R3=${m.R3.str}        # G3a zoom region (98 % of every Monte Carlo cloud)
R4=${m.R4.str}        # G3b,c zoom region (posterior, jackknife, velocity sensitivity)
EPILON=${f6(m.epi.lon)}; EPILAT=${f6(m.epi.lat)}
ZTOP=${m.ztop}; ZMAX=${m.zmax}                       # depth axis of the cross-sections (km, negative = above sea level)
W1=11.6; HS=3.0; WS=3.0; GAP=0.45                    # G1: map width, section height/width, gap (cm)
W2=12.0; PW=5.2                                      # G2 map width, G3 panel width (cm)
DAYRES=${m.dayRes}; RELRES=${m.relRes}; ZRELRES=${m.zoomRelRes}
INSET_R=${f2(m.inset.lon - m.inset.half)}/${f2(m.inset.lon + m.inset.half)}/${f2(Math.max(-85, m.inset.lat - m.inset.half*0.75))}/${f2(Math.min(85, m.inset.lat + m.inset.half*0.75))}

# ---------------- one house style for every figure ----------------
style () {
  gmt set FONT_ANNOT_PRIMARY 7.5p,Helvetica,black FONT_LABEL 8.5p,Helvetica,black FONT_TITLE 9p,Helvetica-Bold,black \\
          FONT_TAG 10p,Helvetica-Bold,black FONT_HEADING 10p,Helvetica-Bold,black \\
          MAP_FRAME_TYPE plain MAP_FRAME_PEN 0.6p,black MAP_TICK_PEN_PRIMARY 0.5p,black MAP_TICK_LENGTH_PRIMARY 3p/1.5p \\
          MAP_ANNOT_OFFSET_PRIMARY 2.5p MAP_LABEL_OFFSET 5p MAP_TITLE_OFFSET 6p MAP_SCALE_HEIGHT 4p \\
          FORMAT_GEO_MAP ddd.xxF MAP_ANNOT_OBLIQUE lat_parallel PS_LINE_JOIN round COLOR_NAN white \\
          MAP_LOGO false GMT_VERBOSE e
}
# shaded-relief intensity for a region (empty when the relief cannot be obtained)
intensity () {   # $1 region  $2 resolution  $3 output
  gmt grdgradient @earth_relief_$2 -R$1 -A315 -Nt0.55 -G$3 2>/dev/null || return 1
}
# map background:  $1 region  $2 kind (main|zoom)
background () {
  local R=$1 kind=$2; local res=$RELRES int="$TMP/int_$2.nc" mode=$BG
  [ "$kind" = zoom ] && res=$ZRELRES
  if [ "$mode" = satellite ] && [ "$kind" = zoom ]; then mode=hill; fi        # 1-km satellite pixels are too coarse for the zoom
  if [ "$mode" = image ]; then
    if intensity $R $res "$int"; then gmt grdimage "$IMG" -I"$int" -R$R && return 0; fi
    gmt grdimage "$IMG" -R$R && return 0; mode=plain
  fi
  if [ "$mode" = satellite ]; then
    if intensity $R $res "$int" && gmt grdimage @earth_day_$DAYRES -I"$int" -R$R 2>/dev/null; then return 0; fi
    gmt grdimage @earth_day_$DAYRES -R$R 2>/dev/null && return 0
    echo "  satellite imagery unavailable: using shaded relief"; mode=relief
  fi
  if [ "$mode" = relief ]; then
    if intensity $R $res "$int"; then
      gmt makecpt -Cgeo -H -T-3000/3000 > "$TMP/relief.cpt"
      gmt grdimage @earth_relief_$res -R$R -I"$int" -C"$TMP/relief.cpt" 2>/dev/null && return 0
    fi
    echo "  relief unavailable: using coastlines"; mode=plain
  fi
  if [ "$mode" = hill ]; then
    if intensity $R $res "$int"; then
      gmt makecpt -Cgray -H -T-1/1 -G0.55/0.98 > "$TMP/hill.cpt"
      gmt grdimage "$int" -C"$TMP/hill.cpt" -R$R 2>/dev/null && { gmt coast -R$R -Df -Slightsteelblue1 -W0.35p,gray30; return 0; }
    fi
    mode=plain
  fi
  gmt coast -R$R -Df -Gcornsilk1 -Slightsteelblue1 -W0.35p,gray35 -N1/0.4p,gray45,- -A0/0/1
}
dark () { case "$BG" in satellite|image) return 0;; *) return 1;; esac; }    # dark background → white coastlines and halos
coastline () { if dark; then gmt coast -R$1 -Df -W0.45p,white -N1/0.5p,white,- -A0/0/1; else gmt coast -R$1 -Df -W0.45p,gray25 -N1/0.4p,gray40,- -A0/0/1; fi; }

# symbols (one meaning each, identical in every figure)
SYM_MAIN="-Sa0.42c -Gred3 -W0.6p,white";   SYM_CHORD="-Sc0.26c -Ggoldenrod1 -W0.6p,black"
SYM_SPH="-Sd0.26c -Gdeepskyblue -W0.6p,black"; SYM_BAYES="-Sh0.28c -Gorchid2 -W0.6p,black"
SYM_VAR="-Ss0.16c -Gwhite -W0.5p,black";   SYM_STA="-St0.30c -Gwhite -W0.6p,black"
reference () {   # white-haloed black cross
  [ -s data/reference.txt ] && grep -qv '^#' data/reference.txt || return 0
  gmt plot data/reference.txt -Sx0.36c -W2.6p,white "$@"; gmt plot data/reference.txt -Sx0.36c -W1.1p,black "$@"
}
stations () {    # used stations white, others gray; labels with a translucent white box
  awk '!/^#/ && $5==1 {print $1, $2}' data/stations.txt | gmt plot $SYM_STA
  awk '!/^#/ && $5==0 {print $1, $2}' data/stations.txt | gmt plot -St0.30c -Ggray70 -W0.6p,black
  awk '!/^#/ {print $1, $2, $4}' data/stations.txt | gmt text -F+f6.5p,Helvetica-Bold,black+jBL -D0.17c/0.07c -Gwhite@25 -C0.04c/0.03c
}
solutions () {
  gmt plot data/sol_var.txt $SYM_VAR; gmt plot data/sol_sphere.txt $SYM_SPH; gmt plot data/sol_chord.txt $SYM_CHORD
  gmt plot data/sol_bayes.txt $SYM_BAYES; reference; gmt plot data/sol_main.txt $SYM_MAIN
}
ellipses () {    # $1 file (segment 0 = 1σ, segment 1 = 95 %)  $2 colour
  grep -q '^>' $1 || return 0
  gmt convert $1 -Q0 | gmt plot -W1.1p,$2
  gmt convert $1 -Q1 | gmt plot -W0.9p,$2,4_2:0
}
tag () { echo "$1" | gmt text -F+cTL+jBL+f10p,Helvetica-Bold -N -D0c/0.16c; }
scalebar () {    # $1 corner  $2 length km  $3 offset
  gmt basemap -Lj$1+w$2k+l$3 -F+gwhite@15+p0.35p,gray30+c0.1c/0.1c/0.05c/0.1c
}

echo "EQLocate GMT maps — background: $BG"
# =====================================================================================================
# G1  Location overview: (a) map, (b) N–S section, (c) E–W section; locator inset; legend below
# =====================================================================================================
gmt begin G1_location_overview $FMT A+m0.2c,E$DPI
  style
  H1=$(gmt mapproject -R$R1 -JM\${W1}c -Wh)
  gmt basemap -R$R1 -JM\${W1}c -B0 -BWSne -Y$(gmt math -Q $HS 1.35 ADD 4.2 ADD =)c
  background $R1 main
  coastline $R1
  gmt basemap -Bxcdata/axis_g1x.txt -Bycdata/axis_g1y.txt -BWSne
  ellipses data/ellipse_joint.txt red3
  stations
  solutions
  scalebar ${m.cor1[1]} ${m.scale1} ${off(m.cor1[1])}
  tag a
  gmt inset begin -Dj${ins}+o0.18c -F+gwhite+p0.6p,black -R$INSET_R -JM3.0c
    gmt coast -Di -Ggray72 -Swhite -W0.2p,gray40 -N1/0.25p,gray55 -A500 -B0
    echo "${m.R1.W} ${m.R1.S} ${m.R1.E} ${m.R1.N}" | awk '{print $1,$2; print $3,$2; print $3,$4; print $1,$4; print $1,$2}' | gmt plot -W1.2p,red3
  gmt inset end
  # (b) N–S section: depth against latitude, right of the map
  gmt basemap -R$ZTOP/$ZMAX/${m.R1.S}/${m.R1.N} -JX\${WS}c/\${H1}c -X$(gmt math -Q $W1 $GAP ADD =)c -Bxaf+l"Depth (km)" -Bycdata/axis_g1y.txt -BSEnw
  echo "0 ${m.R1.S}" > "$TMP/z"; echo "0 ${m.R1.N}" >> "$TMP/z"; gmt plot "$TMP/z" -W0.5p,gray50,-
  awk '!/^#/ && $3!="NaN" {print $3, $2, $4}' data/sol_var.txt | gmt plot -Ex+p0.5p,gray30 $SYM_VAR
  awk '!/^#/ && $3!="NaN" {print $3, $2, $4}' data/sol_sphere.txt | gmt plot -Ex+p0.5p,gray30 $SYM_SPH
  awk '!/^#/ && $3!="NaN" {print $3, $2, $4}' data/sol_chord.txt | gmt plot -Ex+p0.5p,gray30 $SYM_CHORD
  awk '!/^#/ && $3!="NaN" {print $3, $2, $4}' data/sol_bayes.txt | gmt plot -Ex+p0.5p,gray30 $SYM_BAYES
  awk '!/^#/ && $3!="NaN" {print $3, $2}' data/reference.txt | gmt plot -Sx0.32c -W1.1p,black
  awk '!/^#/ && $3!="NaN" {print $3, $2, $4}' data/sol_main.txt | gmt plot -Ex+p0.6p,red3 -Sa0.38c -Gred3 -W0.5p,black
  awk '!/^#/ {print -$3/1000, $2}' data/stations.txt | gmt plot -St0.22c -Gwhite -W0.5p,black
  tag b
  # (c) E–W section: depth against longitude, below the map
  gmt basemap -R${m.R1.W}/${m.R1.E}/$ZTOP/$ZMAX -JX\${W1}c/-\${HS}c -X-$(gmt math -Q $W1 $GAP ADD =)c -Y-$(gmt math -Q $HS 1.35 ADD =)c -Bxcdata/axis_g1x.txt -Byaf+l"Depth (km)" -BWSne
  if [ "$BG" != plain ]; then
    gmt project -C${m.R1.W}/$EPILAT -E${m.R1.E}/$EPILAT -G0.25k -Q 2>/dev/null | gmt grdtrack -G@earth_relief_$RELRES 2>/dev/null | awk '{print $1, -$4/1000}' > "$TMP/topo" || true
  fi
  if [ -s "$TMP/topo" ]; then { echo "${m.R1.W} $ZMAX"; cat "$TMP/topo"; echo "${m.R1.E} $ZMAX"; } | gmt plot -Ggray94 -W0.6p,gray35
  else printf "${m.R1.W} 0\\n${m.R1.E} 0\\n" | gmt plot -W0.5p,gray50,-; fi
  awk '!/^#/ && $3!="NaN" {print $1, $3, $4}' data/sol_var.txt | gmt plot -Ey+p0.5p,gray30 $SYM_VAR
  awk '!/^#/ && $3!="NaN" {print $1, $3, $4}' data/sol_sphere.txt | gmt plot -Ey+p0.5p,gray30 $SYM_SPH
  awk '!/^#/ && $3!="NaN" {print $1, $3, $4}' data/sol_chord.txt | gmt plot -Ey+p0.5p,gray30 $SYM_CHORD
  awk '!/^#/ && $3!="NaN" {print $1, $3, $4}' data/sol_bayes.txt | gmt plot -Ey+p0.5p,gray30 $SYM_BAYES
  awk '!/^#/ && $3!="NaN" {print $1, $3}' data/reference.txt | gmt plot -Sx0.32c -W1.1p,black
  awk '!/^#/ && $3!="NaN" {print $1, $3, $4}' data/sol_main.txt | gmt plot -Ey+p0.6p,red3 -Sa0.38c -Gred3 -W0.5p,black
  awk '!/^#/ {print $1, -$3/1000}' data/stations.txt | gmt plot -St0.22c -Gwhite -W0.5p,black
  tag c
  # legend below the E–W section, as wide as the map and the N–S section together
  cat > "$TMP/leg1" <<'EOF'
N 3
S 0.3c t 0.30c white 0.6p,black 0.75c Seismic station
S 0.3c a 0.40c red3 0.6p,white 0.75c Joint least squares (main)
S 0.3c - 0.5c - 1.1p,red3,4_2:0 0.75c 95 % ellipse (to scale; see G3)
S 0.3c c 0.26c goldenrod1 0.6p,black 0.75c Three circles
S 0.3c d 0.26c deepskyblue 0.6p,black 0.75c Three / N spheres
${m.hasPost ? "S 0.3c h 0.28c orchid2 0.6p,black 0.75c Bayesian posterior median\n" : ""}S 0.3c s 0.16c white 0.5p,black 0.75c Joint LS variants
S 0.3c x 0.32c - 1.1p,black 0.75c Reference hypocentre
S 0.3c - 0.5c - 0.5p,gray30 0.75c @~\\261@~1@~s@~ depth (sections)
EOF
  gmt legend "$TMP/leg1" -DJBL+o0/1.05c+w$(gmt math -Q $W1 $GAP ADD $WS ADD =)c+jTL -F+p0.4p,gray30+gwhite -C0.12c/0.1c
gmt end

# =====================================================================================================
# G2  Three-circle construction: S-P circles, radical axes, epicentres
# =====================================================================================================
${m.hasChord ? T(`
gmt begin G2_three_circles $FMT A+m0.2c,E$DPI
  style
  gmt basemap -R$R2 -JM\${W2}c -B0 -BWSne -Y3.6c
  background $R2 main
  coastline $R2
  gmt basemap -Bxcdata/axis_g2x.txt -Bycdata/axis_g2y.txt -BWSne
  dark && gmt convert data/circles.txt | sed 's/^> -W[^ ]*/> -W2.6p,white/' | gmt plot -t35
  gmt plot data/circles.txt
  gmt plot data/radical_axes.txt -W1.4p,white
  gmt convert data/radical_axes.txt 2>/dev/null | awk '/^>/{p=($2=="-Z1")} p' | gmt plot -W1.0p,black
  gmt convert data/radical_axes.txt 2>/dev/null | awk '/^>/{p=($2=="-Z0")} p' | gmt plot -W1.0p,black,4_2:0
  stations
  awk '!/^#/ {print $1, $2}' data/circle_stations.txt | gmt plot -St0.34c -Gyellow1 -W0.7p,black
  ellipses data/ellipse_chord.txt darkorange3
  gmt plot data/sol_sphere.txt $SYM_SPH; gmt plot data/sol_chord.txt $SYM_CHORD; reference; gmt plot data/sol_main.txt $SYM_MAIN
  scalebar ${sc2} ${m.scale2} ${off(sc2)}
  cat > "$TMP/leg2" <<'EOF'
N 3
S 0.3c - 0.5c - 1.2p,#b2182b 0.75c S-P circle (radius D@-hyp@-)
S 0.3c - 0.5c - 1.0p,black 0.75c Radical axis
S 0.3c - 0.5c - 1.0p,black,4_2:0 0.75c Axis, disjoint circles
S 0.3c t 0.34c yellow1 0.7p,black 0.75c Circle station
S 0.3c c 0.26c goldenrod1 0.6p,black 0.75c Radical centre
S 0.3c d 0.26c deepskyblue 0.6p,black 0.75c Sphere solution
S 0.3c a 0.40c red3 0.6p,white 0.75c Joint least squares
S 0.3c - 0.5c - 1.1p,darkorange3 0.75c 1@~s@~ / 95 % (Monte Carlo)
S 0.3c x 0.32c - 1.1p,black 0.75c Reference
EOF
  gmt legend "$TMP/leg2" -DJBC+o0/0.95c+w\${W2}c -F+p0.4p,gray30+gwhite -C0.12c/0.1c
gmt end
`) : `echo "G2 skipped: no three-circle solution in the case study"`}

# =====================================================================================================
# G3  Epicentre uncertainty: aligned panels (posterior panel only with Bayesian sampling), keys beneath each panel
# =====================================================================================================
gmt begin G3_epicentre_uncertainty $FMT A+m0.2c,E$DPI
  style
  gmt makecpt -Cbatlow -H -T${m.pd[0]}/${m.pd[1]} -I > "$TMP/depth.cpt"
  gmt makecpt -Croma -H -T${f2(m.vp[0])}/${f2(m.vp[1])} > "$TMP/vp.cpt"
  gmt subplot begin 1x${m.hasPost ? 3 : 2} -Y3.4c -Fs\${PW}c/0 -R$R3 -JM\${PW}c -M0.32c/0.15c -Aa+jTL+o0.1c/0.1c+gwhite+p0.4p,black+c0.07c/0.05c
    # (a) Monte Carlo clouds and error ellipses
    gmt subplot set 0
    gmt basemap -R$R3 -JM\${PW}c -B0
    background $R3 zoom
    gmt basemap -Bxcdata/axis_g3x.txt -Bycdata/axis_g3y.txt -BWSne+t"Monte Carlo (picks, Vp)"
    awk '!/^#/' data/mc_chord.txt | gmt plot -Sc0.035c -Ggoldenrod2@35
    awk '!/^#/' data/mc_joint.txt | gmt plot -Sc0.035c -Gred3@40
    ellipses data/ellipse_chord.txt darkorange3
    ellipses data/ellipse_joint.txt red4
    gmt plot data/sol_chord.txt $SYM_CHORD; reference; gmt plot data/sol_main.txt $SYM_MAIN
    scalebar ${sc3} ${m.scale3} ${off(sc3)}
    cat > "$TMP/leg3" <<'EOF'
N 2
S 0.25c c 0.12c red3 - 0.65c Joint LS trials
S 0.25c c 0.12c goldenrod2 - 0.65c Circle trials
S 0.25c - 0.45c - 1.1p,red4 0.65c Joint 1@~s@~/95 %
S 0.25c - 0.45c - 1.1p,darkorange3 0.65c Circles 1@~s@~/95 %
S 0.25c a 0.32c red3 0.5p,white 0.65c Joint LS
S 0.25c x 0.28c - 1.0p,black 0.65c Reference
EOF
    gmt legend "$TMP/leg3" -DJBC+o0/0.95c+w\${PW}c -F+p0.4p,gray30+gwhite -C0.08c/0.08c --FONT_ANNOT_PRIMARY=7p
${m.hasPost ? `    # (b) Bayesian posterior coloured by depth (only when Bayesian sampling was part of the joint inversion)
    gmt subplot set 1
    gmt basemap -R$R4 -JM\${PW}c -B0
    background $R4 zoom
    gmt basemap -Bxcdata/axis_g4x.txt -Bycdata/axis_g4y.txt -BWSne+t"Bayesian posterior"
    scalebar ${m.cor3[0]} ${m.scale4} ${off(m.cor3[0])}
    ${m.hasPost ? `awk '!/^#/' data/posterior.txt | gmt plot -Sc0.04c -C"$TMP/depth.cpt"` : ":"}
    gmt plot data/sol_bayes.txt $SYM_BAYES; reference; gmt plot data/sol_main.txt $SYM_MAIN
    gmt colorbar -C"$TMP/depth.cpt" -DJBC+o0/0.95c+w$(gmt math -Q $PW 0.8 MUL =)c/0.22c+h -Bxaf+l"Posterior depth (km)" --FONT_ANNOT_PRIMARY=7p --FONT_LABEL=7.5p
` : ""}    # (${m.hasPost ? "c" : "b"}) jackknife and velocity sensitivity
    gmt subplot set ${m.hasPost ? 2 : 1}
    gmt basemap -R$R4 -JM\${PW}c -B0
    background $R4 zoom
    gmt basemap -Bxcdata/axis_g4x.txt -Bycdata/axis_g4y.txt -BWSne+t"Jackknife and velocity sensitivity"${m.hasPost ? "" : `
    scalebar ${m.cor3[0]} ${m.scale4} ${off(m.cor3[0])}`}
    ${m.hasSens ? `awk '!/^#/ {print $1, $2, $3}' data/sensitivity.txt | gmt plot -Sc0.15c -C"$TMP/vp.cpt" -W0.3p,black` : ":"}
    ${m.hasJack ? `awk '!/^#/ {print $1, $2}' data/jackknife.txt | gmt plot -Ss0.20c -W0.8p,black
` : ":"}
    reference; gmt plot data/sol_main.txt $SYM_MAIN
    gmt colorbar -C"$TMP/vp.cpt" -DJBC+o0/0.95c+w$(gmt math -Q $PW 0.8 MUL =)c/0.22c+h -Bxaf+l"Fixed V@-P@- (km/s);  squares: jackknife" --FONT_ANNOT_PRIMARY=7p --FONT_LABEL=7.5p
  gmt subplot end
gmt end

echo "Done: G1_location_overview, G2_three_circles, G3_epicentre_uncertainty ($FMT, $DPI dpi)"
`);
}

function readme(m){
  return `EQLocate ${APP_VERSION} — GMT publication maps
Author: Ali Attia

Requirements: GMT 6.1 or newer (https://www.generic-mapping-tools.org), bash, awk.
Run:  bash make_maps.sh
      BG=relief bash make_maps.sh              SRTM shaded relief (1 arc-second)
      BG=image IMG=sentinel2.tif bash make_maps.sh   your own satellite GeoTIFF (WGS84), shaded with SRTM relief
      BG=plain bash make_maps.sh               coastlines only (offline)
      DPI=1200 FMT=pdf,png,eps bash make_maps.sh

Figures
  G1_location_overview      (a) map with stations, every solution, 1σ/95 % ellipse and locator inset;
                            (b) N–S and (c) E–W depth sections with ±1σ depth bars; one legend below all panels.
  G2_three_circles          S−P circles (radius Dhyp), radical axes, radical centre, sphere and joint solutions.
  G3_epicentre_uncertainty  common zoom: (a) Monte Carlo clouds and ellipses, (b) Bayesian posterior coloured by depth (only when Bayesian sampling was ticked in Joint LS),
                            (c) jackknife epicentres and velocity sensitivity coloured by fixed Vp.

Satellite imagery: GMT's @earth_day (NASA Blue Marble, ~1 km at 30 arc-seconds) is the highest-resolution global
imagery on the GMT server; it is shaded with SRTM relief. For metre-scale imagery export a GeoTIFF (e.g. Sentinel-2
L2A true colour, 10 m, free from the Copernicus Browser) covering ${m.R1.str} (W/E/S/N) and use BG=image.
Respect the licence and attribution of any imagery you add. The zoom panels of G3 use SRTM hillshade.

Data (./data): stations, solutions by class, error ellipses (Monte Carlo covariance), Monte Carlo clouds, posterior
samples, jackknife, velocity sensitivity, S−P circles and radical axes. All coordinates WGS84, depths in km below sea
level where station elevations were used (else below station level).
`;
}
return {build};
})();
