/* ---------- Location core (pure functions, no DOM) ----------
   Everything numerical lives here so that it can be verified outside the
   browser: node -e "const C=require('./core.js')" after extracting this block. */
const LocCore = (function(){
"use strict";
const R_EARTH = 6371.0;
const UNDEF = -12345;
const toRad = d => d*Math.PI/180;
const toDeg = r => r*180/Math.PI;

/* ---------- Seeded RNG (mulberry32) + standard normal ---------- */
function makeRng(seed){
  let a = (seed >>> 0) || 1;
  const uni = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if(spare !== null){ const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while(u === 0) u = uni();
    while(v === 0) v = uni();
    const m = Math.sqrt(-2*Math.log(u));
    spare = m*Math.sin(2*Math.PI*v);
    return m*Math.cos(2*Math.PI*v);
  };
  return {uni, normal};
}

/* ---------- Statistics ---------- */
function sortedCopy(a){ return [...a].filter(Number.isFinite).sort((x,y) => x-y); }
function quantile(sorted, p){
  const n = sorted.length;
  if(!n) return NaN;
  const h = (n-1)*p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (h-lo)*(sorted[hi]-sorted[lo]);
}
function median(a){ return quantile(sortedCopy(a), 0.5); }
function mad(a){ const m = median(a); return median(a.map(v => Math.abs(v-m))); }
function summarize(a){
  const s = sortedCopy(a);
  const q16 = quantile(s, 0.16), q84 = quantile(s, 0.84);
  return {n:s.length, med:quantile(s,0.5), q16, q84, sigma:0.5*(q84-q16)};
}

/* ---------- Geometry ---------- */
function equirectXY(lat, lon, lat0, lon0){
  return {x:toRad(lon-lon0)*Math.cos(toRad(lat0))*R_EARTH, y:toRad(lat-lat0)*R_EARTH};
}
function xyToLatLon(x, y, lat0, lon0){
  return {lat:lat0 + toDeg(y/R_EARTH), lon:lon0 + toDeg(x/(R_EARTH*Math.cos(toRad(lat0))))};
}
function haversineKm(lat1, lon1, lat2, lon2){
  const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R_EARTH*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function centroid(sts){
  let la = 0, lo = 0;
  for(const s of sts){ la += s.lat; lo += s.lon; }
  return {lat:la/sts.length, lon:lo/sts.length};
}
/* 1-σ ellipse of a 2×2 covariance [[sxx,sxy],[sxy,syy]] → semi-axes (km) and azimuth of the major axis (deg from north). */
function errorEllipse(cxx, cxy, cyy){
  const tr = cxx + cyy, det = cxx*cyy - cxy*cxy;
  const disc = Math.sqrt(Math.max(0, tr*tr/4 - det));
  const l1 = tr/2 + disc, l2 = Math.max(0, tr/2 - disc);
  const theta = 0.5*Math.atan2(2*cxy, cxx - cyy);   // angle of major axis from +x (east)
  return {a:Math.sqrt(l1), b:Math.sqrt(l2), theta, azimuth:(90 - toDeg(theta) + 360) % 180};
}
function ellipsePolygon(cx, cy, e, k, n){
  const pts = [];
  for(let i=0;i<=n;i++){
    const t = 2*Math.PI*i/n, ca = Math.cos(e.theta), sa = Math.sin(e.theta);
    const u = k*e.a*Math.cos(t), v = k*e.b*Math.sin(t);
    pts.push({x:cx + u*ca - v*sa, y:cy + u*sa + v*ca});
  }
  return pts;
}

/* ---------- SAC reader (binary, either byte order) ---------- */
const KT_OFFSETS = [488,496,504,512,520,528,536,544,552,560];
function readSAC(buffer, name){
  if(buffer.byteLength < 632) throw new Error("file too small for a SAC header (need ≥ 632 bytes)");
  const dv = new DataView(buffer);
  let le = null;
  for(const cand of [true, false]){
    const nvhdr = dv.getInt32(280 + 6*4, cand), npts = dv.getInt32(280 + 9*4, cand), delta = dv.getFloat32(0, cand);
    if(nvhdr >= 1 && nvhdr <= 20 && npts >= 2 && npts <= 1e7 && Number.isFinite(delta) && delta > 0 && delta !== UNDEF){ le = cand; break; }
  }
  if(le === null) throw new Error("could not interpret the SAC header in either byte order");
  const f = i => { const v = dv.getFloat32(i*4, le); return (v === UNDEF || !Number.isFinite(v)) ? NaN : v; };
  const n = i => { const v = dv.getInt32(280 + i*4, le); return v === UNDEF ? NaN : v; };
  const k = (off, len) => {
    let s = "";
    for(let i=0;i<len;i++){ const c = dv.getUint8(off+i); if(c === 0) break; s += String.fromCharCode(c); }
    s = s.trim();
    return s.startsWith("-12345") ? "" : s;
  };
  const npts = n(9), delta = f(0);
  if(buffer.byteLength < 632 + 4*npts) throw new Error(`file truncated: need ${632 + 4*npts} bytes for ${npts} samples`);
  const data = new Array(npts);
  for(let i=0;i<npts;i++) data[i] = dv.getFloat32(632 + 4*i, le);

  // metadata sanity: undefined (-12345) or filler values must never be used as real coordinates
  const warnings = [];
  const rawSt = {lat:f(31), lon:f(32), el:f(33)}, rawEv = {lat:f(35), lon:f(36), dp:f(38)};
  const stOK = Number.isFinite(rawSt.lat) && Number.isFinite(rawSt.lon) && Math.abs(rawSt.lat) <= 90 && Math.abs(rawSt.lon) <= 360 && !(rawSt.lat === 0 && rawSt.lon === 0);
  const evOK = Number.isFinite(rawEv.lat) && Number.isFinite(rawEv.lon) && Math.abs(rawEv.lat) <= 90 && Math.abs(rawEv.lon) <= 360 && !(rawEv.lat === 0 && rawEv.lon === 0);
  if(!stOK) warnings.push("station coordinates (STLA/STLO) undefined or invalid");
  if(!evOK && (Number.isFinite(rawEv.lat) || Number.isFinite(rawEv.lon))) warnings.push(`event coordinates (EVLA/EVLO) are ${rawEv.lat}, ${rawEv.lon}: treated as undefined`);
  const nzyear = n(0), nzjday = n(1);
  let ref = NaN;
  if(Number.isFinite(nzyear) && Number.isFinite(nzjday)){
    ref = Date.UTC(nzyear, 0, 1)/1000 + (nzjday-1)*86400 + (n(2)||0)*3600 + (n(3)||0)*60 + (n(4)||0) + (n(5)||0)/1000;
  }
  const b = Number.isFinite(f(5)) ? f(5) : 0;
  const t = []; for(let i=0;i<10;i++) t.push(f(10+i));
  return {
    name: name || "",
    station: k(440, 8), network: k(608, 8), component: k(600, 8),
    lat: stOK ? rawSt.lat : NaN, lon: stOK ? rawSt.lon : NaN, elev_m: stOK ? rawSt.el : NaN, stCoordOK: stOK, evCoordOK: evOK,
    evla: evOK ? rawEv.lat : NaN, evlo: evOK ? rawEv.lon : NaN, evdp: evOK ? rawEv.dp : NaN, mag: f(39), warnings,
    stla_raw: rawSt.lat, stlo_raw: rawSt.lon, evla_raw: rawEv.lat, evlo_raw: rawEv.lon, evdp_raw: rawEv.dp,
    delta, npts, b, ref_epoch: ref,
    start_epoch: (Number.isFinite(ref) ? ref : 0) + b,
    o: f(7), a: f(8), ka: k(480, 8), t, kt: KT_OFFSETS.map(o => k(o, 8)),
    byteOrder: le ? "little" : "big",
    data,
  };
}
/* All picks stored in the header: [{field, label, rel, phase}] with rel = seconds after the SAC reference time. */
function listHeaderPicks(h){
  const out = [], typ = s => /^[IE]?P/i.test(s || "") ? "P" : /^[IE]?S/i.test(s || "") ? "S" : "?";
  if(Number.isFinite(h.a)) out.push({field:"A", label:h.ka || "", rel:h.a, phase:typ(h.ka)});
  for(let i=0;i<10;i++) if(Number.isFinite(h.t[i])) out.push({field:"T"+i, label:h.kt[i] || "", rel:h.t[i], phase:typ(h.kt[i])});
  return out;
}
/* Onset check at a pick (diagnostic only; picks are never changed): RMS after the pick (post s) over RMS before it (up to pre s,
   at least minPre s). Returns {ok, ratio, nPre, preRms, postRms, note}. tRel = seconds after the first sample. */
function onsetCheck(data, dt, tRel, opts){
  opts = opts || {};
  const pre = opts.pre ?? 2.0, post = opts.post ?? 1.0, minPre = opts.minPre ?? 0.5, gap = opts.gap ?? 0.05;
  const n = data.length, i0 = Math.round(tRel/dt);
  if(!(i0 >= 0 && i0 < n)) return {ok:false, ratio:NaN, note:"pick outside the record"};
  const a0 = Math.max(0, i0 - Math.round(pre/dt)), a1 = Math.max(0, i0 - Math.round(gap/dt)), b1 = Math.min(n, i0 + Math.round(post/dt));
  if((a1 - a0)*dt < minPre) return {ok:false, ratio:NaN, note:`pre-pick window shorter than ${minPre} s`};
  if(b1 - i0 < 5) return {ok:false, ratio:NaN, note:"pick at the end of the record"};
  const rms = (lo, hi) => { let m = 0; for(let i=lo;i<hi;i++) m += data[i]; m /= (hi-lo); let q = 0; for(let i=lo;i<hi;i++) q += (data[i]-m)**2; return Math.sqrt(q/(hi-lo)); };
  const preRms = rms(a0, a1), postRms = rms(i0, b1);
  return {ok:true, ratio:postRms/Math.max(preRms, 1e-30), nPre:a1 - a0, preRms, postRms, note:""};
}
/* Header picks: P from A (or a Tn labelled P), S from a Tn labelled S (or T0 when no label says otherwise).
   Returned relative to the trace start (b). */
function headerPicks(h){
  const rel = v => Number.isFinite(v) ? v - h.b : NaN;
  const isP = s => /^[IE]?P/i.test(s || "");
  const isS = s => /^[IE]?S/i.test(s || "");
  let p = NaN, s = NaN, pSrc = "", sSrc = "";
  if(Number.isFinite(h.a) && !isS(h.ka)){ p = rel(h.a); pSrc = "A"; }
  for(let i=0;i<10;i++){
    if(!Number.isFinite(h.t[i])) continue;
    if(!Number.isFinite(p) && isP(h.kt[i])){ p = rel(h.t[i]); pSrc = "T"+i; }
    if(!Number.isFinite(s) && isS(h.kt[i])){ s = rel(h.t[i]); sSrc = "T"+i; }
  }
  if(!Number.isFinite(s) && Number.isFinite(h.t[0]) && !isP(h.kt[0])){ s = rel(h.t[0]); sSrc = "T0"; }
  if(!Number.isFinite(s) && Number.isFinite(h.a) && isS(h.ka)){ s = rel(h.a); sSrc = "A"; }
  return {p, s, pSrc, sSrc};
}

/* ---------- Zero-phase Butterworth band-pass (2nd-order sections, forward + backward) ---------- */
function biquad(type, f0, fs){
  const w0 = 2*Math.PI*f0/fs, c = Math.cos(w0), al = Math.sin(w0)/(2*Math.SQRT1_2);
  const a0 = 1 + al;
  const b = type === "lp" ? [(1-c)/2, 1-c, (1-c)/2] : [(1+c)/2, -(1+c), (1+c)/2];
  return {b:b.map(v => v/a0), a:[1, -2*c/a0, (1-al)/a0]};
}
function runBiquad(x, q){
  const y = new Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for(let i=0;i<x.length;i++){
    const v = q.b[0]*x[i] + q.b[1]*x1 + q.b[2]*x2 - q.a[1]*y1 - q.a[2]*y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
function filterTrace(data, dt, type, f1, f2, poles){
  // type: "hp" (corner f1), "lp" (corner f2), "bp" (f1–f2); poles: 2 or 4 per pass; applied forward and backward
  const fs = 1/dt, nyq = fs/2;
  const n = data.length, mean = data.reduce((a,b) => a+b, 0)/n;
  let x = data.map(v => v - mean);
  const nt = Math.max(1, Math.floor(0.05*n));                 // 5% cosine taper
  for(let i=0;i<nt;i++){ const w = 0.5*(1 - Math.cos(Math.PI*i/nt)); x[i] *= w; x[n-1-i] *= w; }
  const secs = [], reps = poles === 4 ? 2 : 1;
  for(let k=0;k<reps;k++){
    if((type === "hp" || type === "bp") && f1 > 0 && f1 < nyq) secs.push(biquad("hp", f1, fs));
    if((type === "lp" || type === "bp") && f2 > 0 && f2 < 0.98*nyq) secs.push(biquad("lp", f2, fs));
  }
  for(const q of secs){ x = runBiquad(x, q); x = runBiquad(x.reverse(), q).reverse(); }
  return x;
}
function bandpass(data, dt, fmin, fmax){ return filterTrace(data, dt, "bp", fmin, fmax, 2); }

/* ---------- Wadati regression ----------
   method "dt": Δt = Ts − Tp regressed on Tp (classical Wadati diagram)
   method "ts": Ts regressed on Tp (Δt and Tp errors are then not anti-correlated)
   Times are absolute epoch seconds. Returns κ = Vp/Vs, To and their standard errors. */
function wadatiFit(tp, ts, method, opts){
  opts = opts || {};
  const n = tp.length;
  if(n < 2) return {ok:false, reason:"need ≥ 2 stations with P and S"};
  const tref = Math.min(...tp);
  const x = tp.map(t => t - tref);
  const y = method === "ts" ? ts.map(t => t - tref) : ts.map((t,i) => t - tp[i]);
  const fit = (w) => {
    let sw = 0, xm = 0, ym = 0;
    for(let i=0;i<n;i++){ sw += w[i]; xm += w[i]*x[i]; ym += w[i]*y[i]; }
    xm /= sw; ym /= sw;
    let sxx = 0, sxy = 0;
    for(let i=0;i<n;i++){ sxx += w[i]*(x[i]-xm)**2; sxy += w[i]*(x[i]-xm)*(y[i]-ym); }
    const b1 = sxy/sxx;
    return {b1, b0:ym - b1*xm, xm, sxx, sw};
  };
  let w = new Array(n).fill(1), F = fit(w);
  if(!(F.sxx > 0)) return {ok:false, reason:"all P times are equal"};
  if(opts.robust && n >= 4){                       // Huber IRLS
    for(let it=0; it<30; it++){
      const r = y.map((v,i) => v - (F.b0 + F.b1*x[i]));
      const sc = Math.max(1.4826*mad(r), 1e-4);
      const wn = r.map(v => { const u = Math.abs(v)/sc; return u <= 1.345 ? 1 : 1.345/u; });
      const done = wn.every((v,i) => Math.abs(v - w[i]) < 1e-4);
      w = wn; F = fit(w);
      if(done) break;
    }
  }
  const {b0, b1, xm, sxx, sw} = F;
  const resid = y.map((v,i) => v - (b0 + b1*x[i]));
  const s2 = n > 2 ? resid.reduce((a,r,i) => a + w[i]*r*r, 0)/(sw - 2*sw/n) : NaN;
  const vb1 = s2/sxx, vb0 = s2*(1/sw + xm*xm/sxx), cb = -xm*s2/sxx;
  const conv = (b0, b1) => method === "ts"
    ? {kappa:b1, To:tref + b0/(1-b1), g:[1/(1-b1), b0/((1-b1)**2)]}
    : {kappa:b1 + 1, To:tref - b0/b1, g:[-1/b1, b0/(b1*b1)]};
  const {kappa, To, g} = conv(b0, b1);
  const varTo = g[0]*g[0]*vb0 + 2*g[0]*g[1]*cb + g[1]*g[1]*vb1;
  const dtRes = tp.map((t,i) => (ts[i]-t) - (kappa-1)*(t - To));
  // leave-one-out prediction residuals catch high-leverage stations that pull the line towards themselves
  const loo = new Array(n).fill(NaN);
  if(n >= 4){
    for(let i=0;i<n;i++){
      const wi = w.map((v,k) => k === i ? 0 : v), Fi = fit(wi);
      const ci = conv(Fi.b0, Fi.b1);
      loo[i] = (ts[i]-tp[i]) - (ci.kappa-1)*(tp[i] - ci.To);
    }
  }
  const scale = 1.4826*mad(loo.filter(Number.isFinite));
  const outlier = loo.map(r => Number.isFinite(r) && scale > 0 && Math.abs(r) > 3*scale);
  return {ok:true, method:method === "ts" ? "ts" : "dt", robust:!!opts.robust, n, kappa, To, seKappa:Math.sqrt(vb1),
          seTo:Math.sqrt(varTo), rms:Math.sqrt(dtRes.reduce((a,r) => a + r*r, 0)/n), dtRes, loo, outlier, weights:w};
}

/* ---------- Three-circle (radical-centre) construction ----------
   Circle i: centre c_i, radius r_i. The chord of circles i and j lies on their radical axis
       2 (c_j − c_i)·p = r_i² − r_j² + |c_j|² − |c_i|²,
   which exists even when the circles do not intersect. For three non-collinear stations the three axes meet
   at one point (the radical centre); for N > 3 stations the least-squares point of all N(N−1)/2 axes is used
   and the RMS distance to the axes measures the inconsistency of the S−P distances. */
function radicalCentre(C, r){
  const rows = [];
  for(let i=0;i<C.length;i++) for(let j=i+1;j<C.length;j++){
    const dx = C[j].x - C[i].x, dy = C[j].y - C[i].y, L = Math.hypot(dx, dy);
    if(L < 1e-9) continue;
    const nx = dx/L, ny = dy/L;
    const d = (r[i]*r[i] - r[j]*r[j] + C[j].x**2 + C[j].y**2 - C[i].x**2 - C[i].y**2)/(2*L);
    rows.push({i, j, nx, ny, d});
  }
  if(rows.length < 2) return {ok:false, reason:"need at least three distinct stations"};
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for(const q of rows){ a11 += q.nx*q.nx; a12 += q.nx*q.ny; a22 += q.ny*q.ny; b1 += q.nx*q.d; b2 += q.ny*q.d; }
  const tr = a11 + a22, det = a11*a22 - a12*a12;
  const lmin = tr/2 - Math.sqrt(Math.max(0, tr*tr/4 - det)), lmax = tr - lmin;
  if(!(lmin > 1e-6*lmax)) return {ok:false, reason:"stations are (nearly) collinear: the radical axes are parallel"};
  const p = {x:(a22*b1 - a12*b2)/det, y:(a11*b2 - a12*b1)/det};
  const rms = Math.sqrt(rows.reduce((s,q) => s + (q.nx*p.x + q.ny*p.y - q.d)**2, 0)/rows.length);
  return {ok:true, p, rms, rows, conditioning:lmax/lmin};
}
/* Segment of the radical axis of circles i and j for display: the chord when they intersect,
   otherwise a segment of the axis through its foot point (flagged so it can be drawn dashed). */
function radicalAxisSegment(ci, ri, cj, rj){
  const dx = cj.x - ci.x, dy = cj.y - ci.y, d = Math.hypot(dx, dy);
  const ex = dx/d, ey = dy/d, a = (ri*ri - rj*rj + d*d)/(2*d);
  const fx = ci.x + a*ex, fy = ci.y + a*ey, h2 = ri*ri - a*a;
  const half = h2 > 0 ? Math.sqrt(h2) : 0.5*Math.max(ri, rj);
  return {p1:{x:fx - half*ey, y:fy + half*ex}, p2:{x:fx + half*ey, y:fy - half*ex}, intersecting:h2 > 0};
}

/* Chord solution for N ≥ 3 stations.
   st: [{code, lat, lon}], dt: S−P times (s), Vp (km/s), kappa = Vp/Vs.
   The depth-zero circles (r = Dhyp) give the same radical centre as the epicentral circles for any common depth. */
function chordSolve(st, dt, Vp, kappa, opts){
  opts = opts || {};
  if(st.length < 3) return {ok:false, reason:"need ≥ 3 stations"};
  if(!(Vp > 0) || !(kappa > 1)) return {ok:false, reason:"need Vp > 0 and Vp/Vs > 1"};
  const D = dt.map(v => v*Vp/(kappa-1));
  if(D.some(v => !(v > 0))) return {ok:false, reason:"S−P time must be positive at every station"};
  const c0 = centroid(st);
  const C = st.map(s => equirectXY(s.lat, s.lon, c0.lat, c0.lon));
  const rc = radicalCentre(C, D);
  if(!rc.ok) return rc;
  const epi = xyToLatLon(rc.p.x, rc.p.y, c0.lat, c0.lon);
  const R = st.map(s => haversineKm(epi.lat, epi.lon, s.lat, s.lon));
  const hs = D.map((d,i) => d*d - R[i]*R[i] > 0 ? Math.sqrt(d*d - R[i]*R[i]) : NaN);
  const valid = hs.filter(Number.isFinite);
  const nNeed = Math.max(2, Math.ceil(st.length/2));
  const segs = [];
  for(let i=0;i<C.length;i++) for(let j=i+1;j<C.length;j++) segs.push(radicalAxisSegment(C[i], D[i], C[j], D[j]));
  // three-dimensional sphere solution (depth as an explicit unknown, station elevations optional)
  const xyz = C.map((c,i) => ({x:c.x, y:c.y, z:opts.elev && Number.isFinite(st[i].elev_m) ? st[i].elev_m/1000 : 0}));
  const sigD = (opts.sigP > 0 || opts.sigS > 0) ? Vp/(kappa-1)*Math.sqrt((opts.sigP||0)**2 + (opts.sigS||0)**2) : 0.1;
  const sp = sphereSolve(xyz, D, sigD);
  if(sp.ok) sp.epi = xyToLatLon(sp.xy.x, sp.xy.y, c0.lat, c0.lon);
  if(valid.length < nNeed)
    return {ok:false, reason:`only ${valid.length} of ${st.length} stations have Dhyp > epicentral distance (no real depth)`, sphere:sp};
  return {ok:true, epi, xy:rc.p, c0, C, D, R, hs, depth:median(valid), depthMad:1.4826*mad(valid), nValid:valid.length,
          inconsistencyKm:rc.rms, conditioning:rc.conditioning, segs, sphere:sp};
}

/* Mean apparent velocity √(R_i² + h²)/(Tp_i − To) over stations (all with Tp > To), at a chord solution. */
function apparentVp(sol, stAll, tpAll, To){
  const v = [], codes = [];
  stAll.forEach((s,i) => {
    const tt = tpAll[i] - To;
    if(!(tt > 0)) return;
    const R = haversineKm(sol.epi.lat, sol.epi.lon, s.lat, s.lon);
    v.push(Math.sqrt(R*R + sol.depth*sol.depth)/tt); codes.push(s.code);
  });
  const mean = v.reduce((a,b) => a+b, 0)/Math.max(1, v.length);
  return {mean, values:v, codes};
}
/* Fixed-point diagnostic V ← g(V) = mean apparent Vp. Converges only where |g'| < 1; with three stations alone
   every V is a fixed point. Reported as converged only if the tolerance is met strictly inside the bounds
   and the fixed point is attracting. */
function fixedPointVp(stSel, dtSel, stAll, tpAll, To, kappa, Vseed, opts){
  opts = opts || {};
  const vmin = opts.vmin ?? 2, vmax = opts.vmax ?? 9, tol = opts.tol ?? 0.002, maxIter = opts.maxIter ?? 30;
  const g = V => { const s = chordSolve(stSel, dtSel, V, kappa); return s.ok ? apparentVp(s, stAll, tpAll, To).mean : NaN; };
  let V = Math.min(vmax, Math.max(vmin, Vseed));
  const hist = [V];
  let stop = "max-iter";
  for(let it=0; it<maxIter; it++){
    const target = g(V);
    if(!Number.isFinite(target)){ stop = "chord geometry failed"; break; }
    const next = Math.min(vmax, Math.max(vmin, target));
    hist.push(next);
    if(Math.abs(next - V) < tol){ V = next; stop = "tolerance"; break; }
    V = next;
  }
  const dv = 0.01, gp = (g(V+dv) - g(V-dv))/(2*dv);
  const atBound = V <= vmin + 1e-9 || V >= vmax - 1e-9;
  return {V, gprime:gp, converged:stop === "tolerance" && !atBound && Math.abs(gp) < 1, atBound, stop, history:hist};
}

/* ---------- Joint least-squares inversion ----------
   Station i at local (x_i, y_i) with elevation z_i (km, positive up). Unknowns (x, y, h, To, Vp, κ), any of
   h, Vp and κ may be held fixed. h = depth below sea level (below the station plane when z_i = 0).
       D_i = √((x−x_i)² + (y−y_i)² + (h+z_i)²),  Tp = To + D/Vp,  Ts = To + κ D/Vp
   Missing arrivals (NaN) are skipped, so stations with a single phase contribute one equation.
   Weighted Levenberg–Marquardt with W = diag(1/σ²), optional Huber re-weighting.
   Optional station clock terms c_k (inp.clock = station indices): Tp = To + c_k + D/Vp, Ts = To + c_k + κD/Vp, so
   that a station with a timing error contributes only its S−P time. Optional Gaussian priors (inp.prior =
   {Vp:[μ, σ], kappa:[μ, σ]}) add (m − μ)²/σ² to the objective (maximum a posteriori, as in the Bayesian module). */
const PNAMES = ["x", "y", "h", "To", "Vp", "kappa"];
function jointForward(m, xy, kappa, Vfix){
  const [x, y, h, To] = m, Vp = Vfix ?? m[4];
  if(m.length === 6) kappa = m[5];
  const N = xy.length, r = {tp:new Array(N), ts:new Array(N), D:new Array(N)};
  for(let i=0;i<N;i++){
    const D = Math.sqrt((x-xy[i].x)**2 + (y-xy[i].y)**2 + (h+xy[i].z)**2);
    r.D[i] = D; r.tp[i] = To + D/Vp; r.ts[i] = To + kappa*D/Vp;
  }
  return r;
}
function solveLinear(A, b){
  const n = A.length, M = A.map((row,i) => [...row, b[i]]);
  for(let k=0;k<n;k++){
    let p = k;
    for(let i=k+1;i<n;i++) if(Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    if(Math.abs(M[p][k]) < 1e-14) return null;
    [M[k], M[p]] = [M[p], M[k]];
    for(let i=k+1;i<n;i++){ const f = M[i][k]/M[k][k]; for(let j=k;j<=n;j++) M[i][j] -= f*M[k][j]; }
  }
  const x = new Array(n);
  for(let i=n-1;i>=0;i--){ let s = M[i][n]; for(let j=i+1;j<n;j++) s -= M[i][j]*x[j]; x[i] = s/M[i][i]; }
  return x;
}
function invert(A){
  const n = A.length, out = Array.from({length:n}, () => new Array(n));
  for(let c=0;c<n;c++){
    const e = new Array(n).fill(0); e[c] = 1;
    const x = solveLinear(A, e);
    if(!x) return null;
    for(let r=0;r<n;r++) out[r][c] = x[r];
  }
  return out;
}
function condScaled(A){
  const dg = A.map((row,i) => Math.sqrt(Math.max(row[i], 1e-300)));
  const As = A.map((row,i) => row.map((v,j) => v/(dg[i]*dg[j]))), Ai = invert(As);
  if(!Ai) return Infinity;
  const nrm = M => Math.max(...M.map(row => row.reduce((a,v) => a + Math.abs(v), 0)));
  return nrm(As)*nrm(Ai);
}
function jointLS(inp){
  const {xy, tp, ts} = inp;
  const N = xy.length;
  const solveVp = inp.solveVp !== false, solveKappa = !!inp.solveKappa, fixDepth = Number.isFinite(inp.fixDepth);
  const obsP = tp.map(Number.isFinite), obsS = ts.map(Number.isFinite);
  const clk = [...new Set(inp.clock || [])].filter(i => obsP[i] && obsS[i]), nc = clk.length;   // clock terms need P and S
  const cIdx = new Array(N).fill(-1); clk.forEach((i,j) => cIdx[i] = j);
  const free = [true, true, !fixDepth, true, solveVp, solveKappa, ...clk.map(() => true)];
  const idx = []; free.forEach((f,k) => { if(f) idx.push(k); });
  const np = idx.length, nm = 6 + nc;
  const prior = [];                                     // [parameter index, mean, σ] for free parameters only
  if(inp.prior){ if(solveVp && inp.prior.Vp && inp.prior.Vp[1] > 0) prior.push([4, ...inp.prior.Vp]); if(solveKappa && inp.prior.kappa && inp.prior.kappa[1] > 0) prior.push([5, ...inp.prior.kappa]); }
  const nObs = obsP.filter(Boolean).length + obsS.filter(Boolean).length;
  const nSta = xy.filter((_,i) => obsP[i] || obsS[i]).length;
  const minSta = (solveVp ? 4 : 3) + nc;
  if(nSta < minSta) return {ok:false, reason:`need ≥ ${minSta} stations with picks (${solveVp ? "Vp free" : "Vp fixed"})`};
  if(nObs <= np) return {ok:false, reason:`only ${nObs} arrivals for ${np} unknowns`};
  if(solveKappa && obsS.filter(Boolean).length < 2) return {ok:false, reason:"need S arrivals to estimate Vp/Vs"};
  const sigP = inp.sigP > 0 ? inp.sigP : 0.05, sigS = inp.sigS > 0 ? inp.sigS : 0.1;
  const hmin = Number.isFinite(inp.hmin) ? inp.hmin : -Math.max(...xy.map(s => s.z));   // not above the highest station
  const rows = [];                                      // observed arrivals: {i, S}
  for(let i=0;i<N;i++){ if(obsP[i]) rows.push({i, S:false}); }
  for(let i=0;i<N;i++){ if(obsS[i]) rows.push({i, S:true}); }
  const sig = rows.map(r => r.S ? sigS : sigP);
  let hub = new Array(rows.length).fill(1);
  const c0 = clk.map((i,j) => (inp.c0 && Number.isFinite(inp.c0[j])) ? inp.c0[j] : 0);
  const full = (q) => { const m = [inp.m0[0], inp.m0[1], fixDepth ? inp.fixDepth : inp.m0[2], inp.m0[3], solveVp ? inp.m0[4] : inp.Vp, inp.kappa, ...c0]; idx.forEach((k,j) => m[k] = q[j]); return m; };
  const pred = m => {
    const [x, y, h, To, Vp, kap] = m;
    return rows.map(r => { const s = xy[r.i]; const D = Math.sqrt((x-s.x)**2 + (y-s.y)**2 + (h+s.z)**2); return To + (cIdx[r.i] >= 0 ? m[6 + cIdx[r.i]] : 0) + (r.S ? kap : 1)*D/Vp; });
  };
  const obs = rows.map(r => r.S ? ts[r.i] : tp[r.i]);
  const resid = m => { const p = pred(m); return obs.map((o,k) => o - p[k]); };
  const jac = m => {
    const [x, y, h, , Vp, kap] = m;
    return rows.map(r => {
      const s = xy[r.i], D = Math.max(Math.sqrt((x-s.x)**2 + (y-s.y)**2 + (h+s.z)**2), 1e-9), ph = r.S ? kap : 1;
      const g = [ph*(x-s.x)/(Vp*D), ph*(y-s.y)/(Vp*D), ph*(h+s.z)/(Vp*D), 1, -ph*D/(Vp*Vp), r.S ? D/Vp : 0, ...clk.map((_,j) => cIdx[r.i] === j ? 1 : 0)];
      return idx.map(k => g[k]);
    });
  };
  const wts = () => sig.map((s,k) => hub[k]/(s*s));
  const priorCost = m => prior.reduce((a,[k,mu,s]) => a + ((m[k] - mu)/s)**2, 0);
  const addPrior = (m, A, g) => { for(const [k,mu,s] of prior){ const a = idx.indexOf(k); A[a][a] += 1/(s*s); if(g) g[a] += (mu - m[k])/(s*s); } };
  const cost = (r, w, m) => r.reduce((a,v,k) => a + w[k]*v*v, 0) + (m ? priorCost(m) : 0);
  let q = idx.map(k => [inp.m0[0], inp.m0[1], inp.m0[2], inp.m0[3], inp.m0[4], inp.kappa, ...c0][k]);
  if(!fixDepth){ const j = idx.indexOf(2); if(q[j] < hmin) q[j] = hmin + 0.1; }
  let iterTotal = 0, converged = false;
  const path = inp.trace ? [full(q).slice(0, 6)] : null;
  const lm = () => {
    let lambda = 1e-3, w = wts(), m = full(q), r = resid(m), c = cost(r, w, m);
    converged = false;
    for(let it=0; it<(inp.maxIter ?? 200); it++){
      iterTotal++;
      const J = jac(m), A = Array.from({length:np}, () => new Array(np).fill(0)), g = new Array(np).fill(0);
      for(let k=0;k<J.length;k++) for(let a=0;a<np;a++){ g[a] += J[k][a]*w[k]*r[k]; for(let b=0;b<np;b++) A[a][b] += J[k][a]*w[k]*J[k][b]; }
      addPrior(m, A, g);
      const dq = solveLinear(A.map((row,a) => row.map((v,b) => a === b ? v*(1+lambda) + 1e-12 : v)), g);
      if(!dq){ lambda *= 10; if(lambda > 1e12) break; continue; }
      const qn = q.map((v,a) => v + dq[a]);
      const jh = idx.indexOf(2);
      if(jh >= 0 && qn[jh] < hmin) qn[jh] = hmin + Math.min(hmin - qn[jh], 1.0);   // reflect at the upper bound
      const jv = idx.indexOf(4); if(jv >= 0) qn[jv] = Math.min(12, Math.max(1.0, qn[jv]));
      const jk = idx.indexOf(5); if(jk >= 0) qn[jk] = Math.min(3.0, Math.max(1.05, qn[jk]));
      const mn = full(qn), rn = resid(mn), cn = cost(rn, w, mn);
      if(cn < c){
        const rel = (c - cn)/Math.max(c, 1e-30);
        q = qn; m = mn; r = rn; c = cn; lambda = Math.max(lambda/3, 1e-12);
        if(path) path.push(m.slice(0, 6));
        if(rel < 1e-10 || Math.hypot(...dq) < 1e-7){ converged = true; break; }
      } else {
        lambda *= 4;
        if(lambda > 1e12){ converged = true; break; }      // no further decrease possible: at a minimum
      }
    }
  };
  lm();
  if(inp.huber){
    const k = inp.huberK ?? 1.345;
    for(let outer=0; outer<20; outer++){
      const r = resid(full(q)), old = hub;
      const sc = Math.max(1.4826*mad(r.map((v,i) => v/sig[i])), 1e-3);
      hub = r.map((v,i) => { const u = Math.abs(v)/(sig[i]*sc); return u <= k ? 1 : k/u; });
      lm();
      if(hub.every((v,i) => Math.abs(v - old[i]) < 1e-3)) break;
    }
  }
  const m = full(q), r = resid(m), w = wts(), J = jac(m);
  const A = Array.from({length:np}, () => new Array(np).fill(0));
  for(let k=0;k<J.length;k++) for(let a=0;a<np;a++) for(let b=0;b<np;b++) A[a][b] += J[k][a]*w[k]*J[k][b];
  addPrior(m, A, null);
  const Ainv = invert(A);
  const dof = nObs - np, objective = cost(r, w, m);
  const chi2 = r.reduce((a,v,k) => a + v*v/(sig[k]*sig[k]), 0), chi2red = dof > 0 ? chi2/dof : NaN;
  const scale = Number.isFinite(chi2red) ? chi2red : 1;
  const covAll = Array.from({length:nm}, () => new Array(nm).fill(NaN));
  if(Ainv) idx.forEach((ka,a) => idx.forEach((kb,b) => covAll[ka][kb] = Ainv[a][b]*scale));
  const cov = covAll.slice(0, 6).map(row => row.slice(0, 6));
  const sigma = cov.map((row,i) => Number.isFinite(row[i]) ? Math.sqrt(Math.max(0,row[i])) : NaN);
  const clockTerms = clk.map((i,j) => ({i, c:m[6+j], sigma:Number.isFinite(covAll[6+j][6+j]) ? Math.sqrt(Math.max(0, covAll[6+j][6+j])) : NaN}));
  const rp = new Array(N).fill(NaN), rs = new Array(N).fill(NaN);
  rows.forEach((row,k) => { if(row.S) rs[row.i] = r[k]; else rp[row.i] = r[k]; });
  const z = r.map((v,k) => v/sig[k]), sc = 1.4826*mad(z) || 1;
  const flags = [];
  for(let i=0;i<N;i++){
    const zp = rp[i]/sigP/sc, zs = rs[i]/sigS/sc, f = [];
    if(Math.abs(zp) > 3) f.push("P outlier");
    if(Math.abs(zs) > 3) f.push("S outlier");
    if(Math.abs(zp) > 2.5 && Math.abs(zs) > 2.5 && Math.sign(zp) === Math.sign(zs)) f.push("same-sign P and S: timing error?");
    flags.push(f);
  }
  const atBound = !fixDepth && m[2] < hmin + 0.05;
  return {ok:true, m:m.slice(0,5), kappa:m[5], solveVp, solveKappa, fixDepth, cov, sigma, r, rp, rs, clock:clk, path, clockTerms, prior:inp.prior || null, priorCost:priorCost(m),
          rms:Math.sqrt(r.reduce((a,v) => a + v*v, 0)/r.length), objective, chi2, chi2red, dof, nObs, nSta,
          iterations:iterTotal, converged, cond:Ainv ? condScaled(A) : Infinity, huberWeights:hub, flags, atBound, hmin};
}

/* Depth profile: minimum misfit with the depth held fixed, all other unknowns free.
   The profile shows directly whether the data constrain depth; its minimum is a robust starting point,
   and the Δχ² = χ²_red interval (profile likelihood) is reported alongside the asymptotic σ. */
function depthProfile(inp, depths){
  const out = [];
  let prev = null;
  for(const h of depths){
    let best = null;
    for(const start of [prev, inp.m0].filter(Boolean)){
      const s = jointLS({...inp, fixDepth:h, m0:[start[0], start[1], h, start[3], start[4]], kappa:start[5] ?? inp.kappa, c0:start[6] ?? inp.c0});
      if(s.ok && (!best || s.objective < best.objective)) best = s;
    }
    if(best){ const cc = best.clockTerms.map(t => t.c); out.push({h, chi2:best.chi2, objective:best.objective, rms:best.rms, m:best.m, kappa:best.kappa, c0:cc}); prev = [...best.m, best.kappa, cc]; }
    else out.push({h, chi2:NaN, objective:NaN, rms:NaN});
  }
  return out;
}
function profileInterval(prof, scale){
  // interval where χ²(h) − χ²min ≤ s, with s = χ²_red (the same scaling as the asymptotic covariance); linear interpolation between grid depths
  const ok = prof.filter(p => Number.isFinite(p.chi2));
  if(ok.length < 2) return null;
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const i0 = prof.indexOf(ok.reduce((a,p) => p.chi2 < a.chi2 ? p : a, ok[0]));
  const thr = prof[i0].chi2 + s;
  const cross = (i, j) => { const a = prof[i], b = prof[j]; return a.h + (thr - a.chi2)/(b.chi2 - a.chi2)*(b.h - a.h); };
  let lo = prof[0].h, hi = prof[prof.length-1].h, loOpen = true, hiOpen = true;
  for(let i=i0; i>0; i--) if(prof[i-1].chi2 > thr){ lo = cross(i, i-1); loOpen = false; break; }
  for(let i=i0; i<prof.length-1; i++) if(prof[i+1].chi2 > thr){ hi = cross(i, i+1); hiOpen = false; break; }
  return {hBest:prof[i0].h, lo, hi, loOpen, hiOpen, chi2min:prof[i0].chi2, threshold:s};
}

/* Robust joint solution: depth-profile scan for the global minimum, then free inversion from it and from
   fixed starting depths; the solution with the smallest objective is kept (not the smallest RMS, which is
   not what Huber-weighted or σP ≠ σS inversions minimize). */
function robustCore(inp, opts){
  opts = opts || {};
  const hmin = -Math.max(...inp.xy.map(s => s.z));
  const step = opts.step ?? 1, hmax = opts.hmax ?? 40;
  const depths = []; for(let h = Math.ceil(hmin); h <= hmax + 1e-9; h += step) depths.push(Math.max(h, hmin));
  let prof = opts.profile === false ? [] : depthProfile(inp, depths);
  if(opts.refine !== false){ // refine the scan around its minimum so that the interval is not limited by the grid spacing
    const okc = prof.filter(p => Number.isFinite(p.objective));
    if(okc.length){
      const b = okc.reduce((a,p) => p.objective < a.objective ? p : a, okc[0]), fine = [];
      for(let h = b.h - 2*step; h <= b.h + 2*step + 1e-9; h += step/10) if(h >= hmin && !depths.some(d => Math.abs(d-h) < 1e-9)) fine.push(h);
      prof = [...prof, ...depthProfile({...inp, m0:b.m, kappa:b.kappa, c0:b.c0}, fine)].sort((p,q) => p.h - q.h);
    }
  }
  const starts = [2, 10, 25].map(h => [inp.m0[0], inp.m0[1], h, inp.m0[3], inp.m0[4]]);
  const okp = prof.filter(p => Number.isFinite(p.objective));
  let cBest = inp.c0;
  if(okp.length){ const b = okp.reduce((a,p) => p.objective < a.objective ? p : a, okp[0]); starts.unshift(b.m); cBest = b.c0; }
  let best = null;
  for(const m0 of starts){
    const s = jointLS({...inp, m0, c0:m0 === starts[0] ? cBest : inp.c0});
    if(s.ok && (!best || s.objective < best.objective - 1e-9)) best = s;
  }
  if(!best) return {ok:false, reason:"joint inversion failed from every starting depth"};
  const scale = Number.isFinite(best.chi2red) ? best.chi2red : 1;
  best.profile = prof;
  best.profileCI = prof.length ? profileInterval(prof, scale) : null;
  best.depthWarning = [];
  if(best.atBound) best.depthWarning.push("depth is at the upper bound (highest station): the data do not constrain a source below the surface with this velocity model");
  if(best.profileCI && (best.profileCI.loOpen || best.profileCI.hiOpen)) best.depthWarning.push(`depth interval reaches the scan limit (${best.profileCI.loOpen ? "surface" : hmax + " km"}): depth is poorly constrained`);
  if(best.solveVp && Math.abs(best.cov[2][4]/Math.sqrt(best.cov[2][2]*best.cov[4][4])) > 0.9) best.depthWarning.push("depth and Vp are strongly correlated (|r| > 0.9): consider fixing Vp to a regional value");
  return best;
}

/* Quantiles for the clock-term test: standard normal (Acklam) and F(1, ν) = t(ν)² (Cornish–Fisher expansion of t). */
function normInv(p){
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const cc = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if(p < pl){ const q = Math.sqrt(-2*Math.log(p)); return (((((cc[0]*q+cc[1])*q+cc[2])*q+cc[3])*q+cc[4])*q+cc[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if(p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5, r = q*q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
function fCrit1(nu, alpha){
  const z = normInv(1 - alpha/2), z3 = z**3, z5 = z**5, z7 = z**7;
  const t = z + (z3 + z)/(4*nu) + (5*z5 + 16*z3 + 3*z)/(96*nu*nu) + (3*z7 + 19*z5 + 17*z3 - 15*z)/(384*nu**3);
  return t*t;
}

/* Joint solution with automatic station clock terms and depth-resolution diagnostics.
   A station whose P and S arrivals are offset by a common amount (a clock or timing error) biases the origin time,
   Vp/Vs and especially the depth, and can create a spurious minimum at the surface. Each station with P and S is
   tested in turn with a clock term; the best one is kept when the decrease of the objective is significant
   (F test, family-wise level opts.clockAlpha = 1%) and |c| > 3σ_c, and the search is repeated (at most
   ⌊(N_PS − 5)/2⌋ terms). The station then constrains the location only through its S−P time.
   When inp.kappaFromWadati = {tp, ts, method, robust} is given, Vp/Vs (the fixed value, or the start and the prior
   centre when it is estimated) is refitted by the Wadati regression without the stations that receive a clock term,
   whose absolute times are wrong. */
function jointRobust(inp, opts){
  opts = opts || {};
  const N = inp.xy.length, both = i => Number.isFinite(inp.tp[i]) && Number.isFinite(inp.ts[i]);
  const kw = inp.kappaFromWadati || null;
  const withClock = (cl, c0) => {
    const o = {...inp, clock:cl, c0};
    if(kw && cl.length){
      const keep = []; for(let i=0;i<N;i++) if(both(i) && !cl.includes(i)) keep.push(i);
      const W = wadatiFit(keep.map(i => kw.tp[i]), keep.map(i => kw.ts[i]), kw.method || "dt", {robust:!!kw.robust});
      if(W.ok){
        o.kappa = W.kappa; o.wadatiRefit = {kappa:W.kappa, seKappa:W.seKappa, To:W.To, n:W.n};      // fixed value, or start when estimated
        if(o.prior && o.prior.kappa) o.prior = {...o.prior, kappa:[W.kappa, o.prior.kappa[1]]};  // prior centred on the refitted ratio
      }
    }
    return o;
  };
  let cur = [...(inp.clock || [])], curC = [...(inp.c0 || [])];
  let best = robustCore(withClock(cur, curC), opts);
  if(!best.ok) return best;
  const tests = [];
  const nPS = [...Array(N).keys()].filter(both).length;
  const maxClock = opts.clock === "off" ? 0 : Math.max(0, Math.floor((nPS - 5)/2));
  while(cur.length < maxClock){
    const cand = [...Array(N).keys()].filter(i => both(i) && !cur.includes(i));
    if(!cand.length) break;
    let top = null;
    for(const k of cand){
      const ck = (best.rp[k]/inp.sigP**2 + best.rs[k]/inp.sigS**2)/(1/inp.sigP**2 + 1/inp.sigS**2);
      const cl = [...cur, k], c0 = [...best.clockTerms.map(t => t.c), ck], o = withClock(cl, c0);
      for(const h of [best.m[2], 10]){
        const s = jointLS({...o, m0:[best.m[0], best.m[1], h, best.m[3], best.m[4]], kappa:o.kappa ?? best.kappa});
        if(s.ok && s.dof > 2 && (!top || s.objective < top.s.objective)) top = {k, s, c0:s.clockTerms.map(t => t.c)};
      }
    }
    if(!top) break;
    const F = (best.objective - top.s.objective)/(top.s.objective/top.s.dof), Fc = fCrit1(top.s.dof, (opts.clockAlpha ?? 0.01)/cand.length);
    const term = top.s.clockTerms[top.s.clockTerms.length - 1];
    const accept = F > Fc && Math.abs(term.c) > 3*term.sigma;
    tests.push({station:top.k, F, Fcrit:Fc, c:term.c, sigma:term.sigma, accepted:accept});
    if(!accept) break;
    cur = [...cur, top.k]; curC = top.c0;
    const nb = robustCore(withClock(cur, curC), opts);
    if(!nb.ok) break;
    best = nb;
  }
  best.clockTests = tests;
  if(kw && cur.length){ const o = withClock(cur, curC); best.wadatiRefit = o.wadatiRefit || null; }
  best.depthResolution = depthResolution(best, inp);
  for(const w of best.depthResolution.warnings) best.depthWarning.push(w);
  return best;
}

/* Depth resolution of a joint solution: closest epicentral distance against depth, profile-likelihood interval,
   correlations of depth with origin time and Vp, depth below the local surface, and an independent depth from
   the S−P times alone (sphere fit), which is insensitive to clock errors. */
function depthResolution(J, inp){
  const xy = inp.xy, [x, y, h] = J.m;
  const R = xy.map(s => Math.hypot(s.x - x, s.y - y));
  const order = R.map((r,i) => [r,i]).filter(([,i]) => Number.isFinite(inp.ts[i]) || Number.isFinite(inp.tp[i])).sort((a,b) => a[0] - b[0]);
  const iNear = order[0][1], Rmin = order[0][0], hSurf = h + xy[iNear].z;          // depth below the nearest station
  const corr = (a, b) => J.cov[a][a] > 0 && J.cov[b][b] > 0 ? J.cov[a][b]/Math.sqrt(J.cov[a][a]*J.cov[b][b]) : NaN;
  const ci = J.profileCI, width = ci ? ci.hi - ci.lo : NaN;
  // S−P-only depth (sphere fit) with the velocities of the solution
  const ps = xy.map((_,i) => i).filter(i => Number.isFinite(inp.tp[i]) && Number.isFinite(inp.ts[i]) && inp.ts[i] > inp.tp[i]);
  let sp = null;
  if(ps.length >= 4 && J.kappa > 1){
    const D = ps.map(i => (inp.ts[i] - inp.tp[i])*J.m[4]/(J.kappa - 1));
    const sD = Math.hypot(inp.sigP, inp.sigS)*J.m[4]/(J.kappa - 1);
    const s = sphereSolve(ps.map(i => xy[i]), D, sD);
    if(s.ok) sp = {h:s.h, sigma:s.sigma ? s.sigma[2] : NaN, x:s.xy.x, y:s.xy.y};
  }
  let cls = "unresolved";
  if(ci && !ci.loOpen && !ci.hiOpen) cls = width <= Math.max(2, 0.5*Math.abs(hSurf)) ? "resolved" : "weakly resolved";
  if(J.atBound) cls = "unresolved";
  const warnings = [];
  if(hSurf < 1 && !J.fixDepth) warnings.push(`focal depth only ${hSurf.toFixed(2)} km below the nearest station: physically implausible for a tectonic earthquake of this size; check the station clocks (clock terms), the velocity model and the S picks`);
  if(Rmin > 2*Math.max(hSurf, 1)) warnings.push(`the nearest station is ${Rmin.toFixed(1)} km from the epicentre, more than twice the depth: depth is poorly resolved by the moveout`);
  if(sp && Number.isFinite(sp.sigma) && Number.isFinite(J.sigma[2])){
    const dz = J.m[2] - sp.h, s = Math.hypot(J.sigma[2], sp.sigma);
    if(Math.abs(dz) > 3*s && Math.abs(dz) > 1) warnings.push(`joint depth (${J.m[2].toFixed(2)} km) and S−P-only depth (${sp.h.toFixed(2)} ± ${sp.sigma.toFixed(2)} km) differ by more than 3σ: absolute timing (station clock) problem likely`);
  }
  return {Rmin, nearest:iNear, hSurface:hSurf, ratio:Rmin/Math.max(Math.abs(hSurf), 1e-3), interval:ci, width,
          corrHT0:corr(2, 3), corrHVp:corr(2, 4), spDepth:sp, class:cls, warnings};
}

/* Apparent (half-space) P velocity estimated from the recorded arrivals.
   Maximum-likelihood estimate: joint inversion with Vp free and no velocity prior, Vp/Vs fixed at the Wadati ratio
   (refitted without stations that receive a clock term), the station clock test, and the depth scan, so that Vp is
   constrained by the P and S moveout of all selected stations together with the location. A consistency check fits a
   straight line to the clock-corrected P arrival times against the hypocentral distances of the solution
   (T_P = T_0 + D/V); its slope gives an independent apparent velocity from the P travel-time curve alone.
   The estimate is flagged as unreliable when the depth is unresolved, Vp and depth are strongly correlated, fewer than
   five stations are used, or the value is outside 3–8.5 km/s. */
function estimateApparentVp(inp, opts){
  opts = opts || {};
  const N = inp.xy.length, nSta = inp.xy.filter((_,i) => Number.isFinite(inp.tp[i]) || Number.isFinite(inp.ts[i])).length;
  if(nSta < 4) return {ok:false, reason:`need ≥ 4 stations with picks (${nSta})`};
  const J = jointRobust({...inp, solveVp:true, solveKappa:false, huber:false, prior:null, fixDepth:undefined}, {step:opts.step ?? 0.5, hmax:opts.hmax ?? 40, clock:opts.clock || "auto"});
  if(!J.ok) return {ok:false, reason:J.reason};
  // travel-time-curve check with the clock-corrected P times
  const corr = new Array(N).fill(0); J.clockTerms.forEach(t => corr[t.i] = t.c);
  const D = jointForward(J.m, inp.xy, J.kappa).D, pts = [];
  for(let i=0;i<N;i++) if(Number.isFinite(inp.tp[i])) pts.push([D[i], inp.tp[i] - corr[i]]);
  let tt = null;
  if(pts.length >= 3){
    const n = pts.length, mx = pts.reduce((a,p) => a + p[0], 0)/n, my = pts.reduce((a,p) => a + p[1], 0)/n;
    const sxx = pts.reduce((a,p) => a + (p[0]-mx)**2, 0), sxy = pts.reduce((a,p) => a + (p[0]-mx)*(p[1]-my), 0);
    if(sxx > 0){
      const b = sxy/sxx, a0 = my - b*mx, res = pts.map(p => p[1] - a0 - b*p[0]);
      const s2 = n > 2 ? res.reduce((q,r) => q + r*r, 0)/(n - 2) : NaN, sb = Math.sqrt(s2/sxx);
      const syy = pts.reduce((q,p) => q + (p[1]-my)**2, 0);
      tt = {V:1/b, sigma:sb/(b*b), To:a0, rms:Math.sqrt(res.reduce((q,r) => q + r*r, 0)/n), r2:syy > 0 ? 1 - res.reduce((q,r) => q + r*r, 0)/syy : NaN, n, Dmin:Math.min(...pts.map(p => p[0])), Dmax:Math.max(...pts.map(p => p[0]))};
    }
  }
  const Vp = J.m[4], sig = J.sigma[4], rhv = J.cov[2][4]/Math.sqrt(J.cov[2][2]*J.cov[4][4]);
  const warnings = [];
  if(J.depthResolution && J.depthResolution.class === "unresolved") warnings.push("the depth is unresolved, so Vp trades off with depth");
  if(Math.abs(rhv) > 0.9) warnings.push(`depth and Vp are strongly correlated (r = ${rhv.toFixed(2)})`);
  if(nSta < 5) warnings.push("fewer than five stations: Vp has at most one degree of freedom of support");
  if(!(Vp >= 3 && Vp <= 8.5)) warnings.push(`Vp = ${Vp.toFixed(2)} km/s is outside the plausible crustal range 3–8.5 km/s`);
  if(tt && Number.isFinite(tt.sigma) && Math.abs(tt.V - Vp) > 3*Math.hypot(tt.sigma, sig) && Math.abs(tt.V - Vp) > 0.3) warnings.push(`the travel-time-curve velocity (${tt.V.toFixed(2)} km/s) differs from the joint estimate`);
  const reliable = !(J.depthResolution && J.depthResolution.class === "unresolved") && Math.abs(rhv) <= 0.9 && Vp >= 3 && Vp <= 8.5;
  return {ok:true, reliable, Vp, sigma:sig, kappa:J.kappa, corrHVp:rhv, nSta, J, tt, warnings,
          clock:J.clockTerms.map(t => ({i:t.i, c:t.c, sigma:t.sigma})), wadatiRefit:J.wadatiRefit || null};
}

/* Sensitivity of the joint solution to the velocity model: Vp and Vp/Vs held fixed on a grid. */
function velocitySensitivity(inp, VpList, kList){
  const out = [];
  for(const Vp of VpList) for(const k of kList){
    const s = jointRobust({...inp, solveVp:false, solveKappa:false, Vp, kappa:k, kappaFromWadati:null, m0:[inp.m0[0], inp.m0[1], inp.m0[2], inp.m0[3], Vp]}, {step:2, hmax:40, clock:"off"});
    if(s.ok) out.push({Vp, kappa:k, x:s.m[0], y:s.m[1], h:s.m[2], To:s.m[3], rms:s.rms, chi2red:s.chi2red, atBound:s.atBound});
  }
  return out;
}

/* ---------- Sphere (3-D) geometric solution ----------
   Sphere i: centre (x_i, y_i, z_i), radius D_i (S−P distance). With w = |p|² the sphere equations
   |p|² − 2 c_i·p + |c_i|² = D_i² are linear in (x, y, w) when the stations lie in a plane; the secant
   planes of pairs of spheres are then vertical and constrain only the epicentre (the radical axes of
   Eq. 8), while depth follows from w: h = √(w − x² − y²). The linear solution starts a Gauss–Newton
   refinement of Σ(|p − c_i| − D_i)² in (x, y, h) that includes station elevations, so depth is an explicit
   parameter with its own uncertainty. */
function sphereSolve(xy, D, sigD){
  const N = xy.length;
  if(N < 3) return {ok:false, reason:"need ≥ 3 stations"};
  // linear step (planar approximation)
  const A = [], b = [];
  for(let i=0;i<N;i++){ A.push([2*xy[i].x, 2*xy[i].y, -1]); b.push(xy[i].x**2 + xy[i].y**2 - D[i]**2); }
  const AtA = [[0,0,0],[0,0,0],[0,0,0]], Atb = [0,0,0];
  for(let i=0;i<N;i++) for(let a=0;a<3;a++){ Atb[a] += A[i][a]*b[i]; for(let c=0;c<3;c++) AtA[a][c] += A[i][a]*A[i][c]; }
  const lin = solveLinear(AtA, Atb);
  if(!lin) return {ok:false, reason:"stations are (nearly) collinear"};
  const zbar = xy.reduce((a,s) => a + s.z, 0)/N;
  const h2 = lin[2] - lin[0]**2 - lin[1]**2;
  const hLin = h2 > 0 ? Math.sqrt(h2) - zbar : NaN;
  // Gauss–Newton (Levenberg-damped) on the sphere misfits
  const hmin = -Math.max(...xy.map(s => s.z));
  let p = [lin[0], lin[1], Number.isFinite(hLin) ? Math.max(hLin, hmin + 0.1) : hmin + 0.5];
  const res = q => xy.map((s,i) => Math.sqrt((q[0]-s.x)**2 + (q[1]-s.y)**2 + (q[2]+s.z)**2) - D[i]);
  const jac = q => xy.map(s => { const d = Math.max(Math.sqrt((q[0]-s.x)**2 + (q[1]-s.y)**2 + (q[2]+s.z)**2), 1e-9); return [(q[0]-s.x)/d, (q[1]-s.y)/d, (q[2]+s.z)/d]; });
  let r = res(p), c = r.reduce((a,v) => a + v*v, 0), lambda = 1e-3;
  for(let it=0; it<200; it++){
    const J = jac(p), M = [[0,0,0],[0,0,0],[0,0,0]], g = [0,0,0];
    for(let i=0;i<N;i++) for(let a=0;a<3;a++){ g[a] -= J[i][a]*r[i]; for(let k=0;k<3;k++) M[a][k] += J[i][a]*J[i][k]; }
    const dp = solveLinear(M.map((row,a) => row.map((v,k) => a === k ? v*(1+lambda) + 1e-12 : v)), g);
    if(!dp) break;
    const pn = p.map((v,a) => v + dp[a]); if(pn[2] < hmin) pn[2] = hmin + Math.min(hmin - pn[2], 1);
    const rn = res(pn), cn = rn.reduce((a,v) => a + v*v, 0);
    if(cn < c){ const rel = (c-cn)/Math.max(c,1e-30); p = pn; r = rn; c = cn; lambda /= 3; if(rel < 1e-12 || Math.hypot(...dp) < 1e-8) break; }
    else { lambda *= 4; if(lambda > 1e12) break; }
  }
  const J = jac(p), M = [[0,0,0],[0,0,0],[0,0,0]];
  for(let i=0;i<N;i++) for(let a=0;a<3;a++) for(let k=0;k<3;k++) M[a][k] += J[i][a]*J[i][k];
  const Mi = invert(M);
  const rmsD = Math.sqrt(c/N);
  const s2 = N > 3 ? Math.max(sigD*sigD, c/(N-3)) : sigD*sigD;     // never smaller than the propagated pick noise
  const cov = Mi ? Mi.map(row => row.map(v => v*s2)) : null;
  return {ok:true, xy:{x:p[0], y:p[1]}, h:p[2], hLinear:hLin, rmsD, cov, sigma:cov ? [0,1,2].map(i => Math.sqrt(Math.max(0, cov[i][i]))) : null,
          atBound:p[2] < hmin + 0.05, cond:Mi ? condScaled(M) : Infinity, residuals:r};
}

/* ---------- Bayesian sampling (in the browser) ----------
   Adaptive random-walk Metropolis for θ = (x, y, h, To, Vp, κ) with the Gaussian likelihood of the joint
   inversion and weakly informative priors:
     x, y ~ N(0, 100²) km (relative to the station centroid), h ~ U(hmin, 50) km,
     To ~ N(To_W, 5²) s, Vp ~ TN[2,9](Vp0, 0.5²), κ ~ TN[1.4,2.2](κ0, 0.1²).
   Two chains start from the least-squares solution; the proposal covariance is the LS covariance scaled by
   2.38²/6 and is re-estimated from the chain during burn-in. Convergence is checked with split-R̂. */
function mcmcJoint(inp, opts){
  opts = opts || {};
  const nIter = opts.iter ?? 20000, burn = opts.burn ?? 5000, thin = opts.thin ?? 5;
  const rng = makeRng(opts.seed ?? 1);
  const {xy, tp, ts} = inp, N = xy.length, sigP = inp.sigP, sigS = inp.sigS;
  const hmin = -Math.max(...xy.map(s => s.z));
  const pr = opts.prior;
  // stations with a clock term: the term is integrated out analytically (flat prior), which leaves the S−P time
  const isClk = new Array(N).fill(false); (inp.clock || []).forEach(i => isClk[i] = true);
  const sigSP = Math.hypot(sigP, sigS);
  const logPost = th => {
    const [x, y, h, To, Vp, k] = th;
    if(h < hmin || h > 50 || Vp < 2 || Vp > 9 || k < 1.4 || k > 2.2) return -Infinity;
    let lp = -0.5*((x/100)**2 + (y/100)**2 + ((To - pr.To)/5)**2 + ((Vp - pr.Vp)/0.5)**2 + ((k - pr.kappa)/0.1)**2);
    for(let i=0;i<N;i++){
      const D = Math.sqrt((x-xy[i].x)**2 + (y-xy[i].y)**2 + (h+xy[i].z)**2);
      if(isClk[i]){ lp -= 0.5*((ts[i] - tp[i] - (k - 1)*D/Vp)/sigSP)**2; continue; }
      if(Number.isFinite(tp[i])) lp -= 0.5*((tp[i] - To - D/Vp)/sigP)**2;
      if(Number.isFinite(ts[i])) lp -= 0.5*((ts[i] - To - k*D/Vp)/sigS)**2;
    }
    return lp;
  };
  // proposal: Cholesky of a covariance
  const chol = S => {
    const n = S.length, L = Array.from({length:n}, () => new Array(n).fill(0));
    for(let i=0;i<n;i++) for(let j=0;j<=i;j++){
      let s = S[i][j]; for(let k=0;k<j;k++) s -= L[i][k]*L[j][k];
      if(i === j){ if(s <= 0) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s/L[j][j];
    }
    return L;
  };
  let S0 = opts.cov && opts.cov.every((row,i) => Number.isFinite(row[i]) && row[i] > 0) ? opts.cov.map(r => r.slice()) :
    [[0.25,0,0,0,0,0],[0,0.25,0,0,0,0],[0,0,1,0,0,0],[0,0,0,0.01,0,0],[0,0,0,0,0.04,0],[0,0,0,0,0,0.001]];
  for(let i=0;i<6;i++) for(let j=0;j<6;j++) if(!Number.isFinite(S0[i][j])) S0[i][j] = i === j ? 0.01 : 0;
  const chains = [];
  for(let c=0;c<2;c++){
    let L = chol(S0.map(r => r.map(v => v*2.38*2.38/6)));
    if(!L) L = chol(S0.map((r,i) => r.map((v,j) => i === j ? v*2.38*2.38/6 : 0)));
    let th = opts.start.map((v,i) => v + (c ? 0.5 : -0.5)*Math.sqrt(S0[i][i])), lp = logPost(th);
    if(!Number.isFinite(lp)){ th = opts.start.slice(); lp = logPost(th); }
    const hist = [], keep = [];
    let acc = 0;
    for(let it=0; it<nIter; it++){
      const z = [0,0,0,0,0,0].map(() => rng.normal());
      const prop = th.map((v,i) => v + L[i].reduce((a,l,j) => a + l*z[j], 0));
      const lq = logPost(prop);
      if(Math.log(rng.uni()) < lq - lp){ th = prop; lp = lq; if(it >= burn) acc++; }
      if(it < burn){ hist.push(th.slice()); if(it > 1000 && it % 500 === 0){
        const n = hist.length, mu = [0,1,2,3,4,5].map(i => hist.reduce((a,v) => a + v[i], 0)/n);
        const Sc = mu.map((_,i) => mu.map((_,j) => hist.reduce((a,v) => a + (v[i]-mu[i])*(v[j]-mu[j]), 0)/(n-1) + (i === j ? 1e-8 : 0)));
        const Ln = chol(Sc.map(r => r.map(v => v*2.38*2.38/6))); if(Ln) L = Ln; } }
      else if((it - burn) % thin === 0) keep.push(th.slice());
    }
    chains.push({samples:keep, accept:acc/(nIter - burn)});
  }
  const all = [...chains[0].samples, ...chains[1].samples];
  const rhat = [0,1,2,3,4,5].map(k => {
    const parts = []; for(const ch of chains){ const h = Math.floor(ch.samples.length/2); parts.push(ch.samples.slice(0,h).map(v => v[k]), ch.samples.slice(h,2*h).map(v => v[k])); }
    const n = parts[0].length, means = parts.map(p => p.reduce((a,v) => a+v, 0)/n), mm = means.reduce((a,v) => a+v, 0)/means.length;
    const B = n*means.reduce((a,v) => a + (v-mm)**2, 0)/(means.length-1);
    const W = parts.reduce((a,p,j) => a + p.reduce((s,v) => s + (v-means[j])**2, 0)/(n-1), 0)/parts.length;
    return Math.sqrt(((n-1)/n*W + B/n)/W);
  });
  return {samples:all, accept:chains.map(c => c.accept), rhat, summary:PNAMES.map((name,k) => ({name, ...summarize(all.map(v => v[k]))}))};
}

/* ---------- Monte Carlo propagation ----------
   Each trial perturbs every pick (σP, σS), refits the Wadati line on the perturbed picks (so the uncertainty of
   κ and To is included), perturbs Vp when it is an input, and re-solves. */
function mcChord(cfg){
  const rng = makeRng(cfg.seed ?? 1), out = {lat:[], lon:[], depth:[], sphereDepth:[], failed:0, total:cfg.trials};
  for(let t=0;t<cfg.trials;t++){
    const tp = cfg.tpAll.map(v => v + cfg.sigP*rng.normal()), ts = cfg.tsAll.map(v => v + cfg.sigS*rng.normal());
    let kappa = cfg.kappa;
    if(cfg.refitWadati){ const w = wadatiFit(cfg.wadIdx.map(i => tp[i]), cfg.wadIdx.map(i => ts[i]), cfg.wadMethod); if(!w.ok){ out.failed++; continue; } kappa = w.kappa; }
    const Vp = cfg.Vp + (cfg.sigVp || 0)*rng.normal();
    const sol = chordSolve(cfg.selIdx.map(i => cfg.stAll[i]), cfg.selIdx.map(i => ts[i] - tp[i]), Vp, kappa, {elev:cfg.elev, sigP:cfg.sigP, sigS:cfg.sigS});
    if(!sol.ok){ out.failed++; continue; }
    out.lat.push(sol.epi.lat); out.lon.push(sol.epi.lon); out.depth.push(sol.depth);
    out.sphereDepth.push(sol.sphere && sol.sphere.ok ? sol.sphere.h : NaN);
  }
  return out;
}
function mcJoint(cfg){
  const rng = makeRng(cfg.seed ?? 1), out = {m:[], kappa:[], failed:0, total:cfg.trials};
  for(let t=0;t<cfg.trials;t++){
    const tp = cfg.tp.map(v => v + cfg.sigP*rng.normal()), ts = cfg.ts.map(v => v + cfg.sigS*rng.normal());
    let kappa = cfg.kappa;
    if(cfg.refitWadati){
      const tpW = cfg.wadTp.map((v,i) => cfg.wadMap[i] >= 0 ? tp[cfg.wadMap[i]] : v + cfg.sigP*rng.normal());
      const tsW = cfg.wadTs.map((v,i) => cfg.wadMap[i] >= 0 ? ts[cfg.wadMap[i]] : v + cfg.sigS*rng.normal());
      const w = wadatiFit(tpW, tsW, cfg.wadMethod); if(!w.ok){ out.failed++; continue; } kappa = w.kappa;
    }
    const s = jointLS({...cfg.base, tp, ts, kappa, m0:cfg.m0});
    if(!s.ok || !s.converged){ out.failed++; continue; }
    out.m.push(s.m); out.kappa.push(s.kappa);
  }
  return out;
}

return {estimateApparentVp, fCrit1, normInv, depthResolution, R_EARTH, makeRng, median, mad, quantile, summarize, equirectXY, xyToLatLon, haversineKm, centroid,
        errorEllipse, ellipsePolygon, readSAC, headerPicks, listHeaderPicks, onsetCheck, filterTrace, bandpass, wadatiFit, radicalCentre, radicalAxisSegment,
        chordSolve, sphereSolve, apparentVp, fixedPointVp, jointForward, jointLS, depthProfile, profileInterval, jointRobust,
        velocitySensitivity, mcmcJoint, mcChord, mcJoint};
})();
if(typeof module !== "undefined") module.exports = LocCore;

