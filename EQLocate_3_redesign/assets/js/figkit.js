/* ---------- FigKit: minimal SVG plotting for publication figures ----------
   Figures are built as SVG strings (vector, journal-ready) and rasterized to PNG at 300 dpi on export. */
const FigKit = (function(){
const FONT = "'Times New Roman', Times, serif";
const PAL = {chord:"#d97706", sphere:"#7c3aed", joint:"#15803d", jointAlt:"#0f766e", bayes:"#2563eb", ref:"#dc2626",
             sta:"#334155", P:"#dc2626", S:"#16a34a", grid:"#e5e7eb", axis:"#111827", excl:"#9ca3af"};
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
/* x_{ab} or x_ab → subscript, x^{ab} or x^2 → superscript */
const rich = s => esc(s).replace(/_\{([^}]*)\}|_([A-Za-z0-9]+)/g, (m, a, b) => `<tspan baseline-shift="sub" font-size="75%">${a ?? b}</tspan>`)
                        .replace(/\^\{([^}]*)\}|\^([0-9A-Za-z−\-]+)/g, (m, a, b) => `<tspan baseline-shift="super" font-size="75%">${a ?? b}</tspan>`);
const f = (v, d=2) => Number.isFinite(v) ? (+v.toFixed(d)).toString() : "";
function niceStep(raw){ const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw/p; return (m >= 7.5 ? 10 : m >= 3.5 ? 5 : m >= 1.5 ? 2 : 1)*p; }
function ticksOf(a, b, n){ if(!(b > a)) return [a]; const s = niceStep((b-a)/Math.max(2,n)), out = []; for(let v = Math.ceil(a/s - 1e-9)*s; v <= b + 1e-9*s; v += s) out.push(Math.abs(v) < 1e-12 ? 0 : v); return out; }
function decimals(t){ return t.length > 1 ? Math.max(0, Math.min(5, -Math.floor(Math.log10(Math.abs(t[1]-t[0])) + 1e-9))) : 1; }
function extent(vals, pad){ const v = vals.filter(Number.isFinite); if(!v.length) return [0,1]; let a = Math.min(...v), b = Math.max(...v); if(a === b){ a -= 1; b += 1; } const p = (b-a)*(pad ?? 0.05); return [a-p, b+p]; }
let uid = 0;

class Figure {
  constructor(w, h){ this.w = w; this.h = h; this.parts = []; }
  add(s){ this.parts.push(s); return this; }
  text(x, y, s, o={}){ return this.add(`<text x="${f(x,1)}" y="${f(y,1)}" font-size="${o.size||11}" font-family="${FONT}" text-anchor="${o.anchor||"start"}" ${o.bold ? 'font-weight="bold"' : ""} ${o.italic ? 'font-style="italic"' : ""} fill="${o.color||"#111"}" ${o.rotate ? `transform="rotate(${o.rotate} ${f(x,1)} ${f(y,1)})"` : ""} dominant-baseline="${o.baseline||"auto"}">${o.raw ? s : rich(s)}</text>`); }
  panel(x, y, w, h, o){ return new Panel(this, x, y, w, h, o); }
  svg(){ return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}"><rect width="100%" height="100%" fill="white"/>${this.parts.join("")}</svg>`; }
}
class Panel {
  /* o: {xlim, ylim, xlabel, ylabel, title, equal (km per unit factors kx, ky), invertY, xfmt, yfmt, grid, xticks, yticks, noAxes} */
  constructor(fig, x, y, w, h, o){
    this.fig = fig; this.x = x; this.y = y; this.w = w; this.h = h; this.o = o = o || {};
    let [x0, x1] = o.xlim || [0,1], [y0, y1] = o.ylim || [0,1];
    if(o.equal){                               // equal distance scaling: kx, ky convert data units to km
      const kx = o.equal.kx || 1, ky = o.equal.ky || 1;
      const sx = w/((x1-x0)*kx), sy = h/((y1-y0)*ky), s = Math.min(sx, sy);
      const cx = (x0+x1)/2, cy = (y0+y1)/2, hx = w/s/kx/2, hy = h/s/ky/2;
      x0 = cx - hx; x1 = cx + hx; y0 = cy - hy; y1 = cy + hy;
    }
    this.xlim = [x0, x1]; this.ylim = [y0, y1];
    this.id = "clip" + (++uid);
    fig.add(`<defs><clipPath id="${this.id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath></defs>`);
    if(!o.noAxes) this.axes();
  }
  X(v){ return this.x + (v - this.xlim[0])/(this.xlim[1] - this.xlim[0])*this.w; }
  Y(v){ const t = (v - this.ylim[0])/(this.ylim[1] - this.ylim[0]); return this.o.invertY ? this.y + t*this.h : this.y + this.h - t*this.h; }
  axes(){
    const o = this.o, F = this.fig, xt = o.xticks || ticksOf(...this.xlim, o.nx || 6), yt = o.yticks || ticksOf(...this.ylim, o.ny || 5);
    const dx = decimals(xt), dy = decimals(yt), xf = o.xfmt || (v => v.toFixed(dx)), yf = o.yfmt || (v => v.toFixed(dy));
    let g = "";
    if(o.grid !== false){
      for(const v of xt) if(v >= this.xlim[0] && v <= this.xlim[1]) g += `<line x1="${f(this.X(v),1)}" x2="${f(this.X(v),1)}" y1="${this.y}" y2="${this.y+this.h}" stroke="${PAL.grid}" stroke-width="0.6"/>`;
      for(const v of yt) if(v >= Math.min(...this.ylim) && v <= Math.max(...this.ylim)) g += `<line y1="${f(this.Y(v),1)}" y2="${f(this.Y(v),1)}" x1="${this.x}" x2="${this.x+this.w}" stroke="${PAL.grid}" stroke-width="0.6"/>`;
    }
    g += `<rect x="${this.x}" y="${this.y}" width="${this.w}" height="${this.h}" fill="none" stroke="${PAL.axis}" stroke-width="0.9"/>`;
    for(const v of xt){ if(v < this.xlim[0] || v > this.xlim[1]) continue; const X = this.X(v);
      g += `<line x1="${f(X,1)}" x2="${f(X,1)}" y1="${this.y+this.h}" y2="${this.y+this.h+4}" stroke="${PAL.axis}" stroke-width="0.8"/>`;
      g += `<text x="${f(X,1)}" y="${this.y+this.h+15}" font-size="10" font-family="${FONT}" text-anchor="middle">${esc(xf(v))}</text>`; }
    for(const v of yt){ if(v < Math.min(...this.ylim) || v > Math.max(...this.ylim)) continue; const Y = this.Y(v);
      g += `<line x1="${this.x-4}" x2="${this.x}" y1="${f(Y,1)}" y2="${f(Y,1)}" stroke="${PAL.axis}" stroke-width="0.8"/>`;
      g += `<text x="${this.x-6}" y="${f(Y+3.5,1)}" font-size="10" font-family="${FONT}" text-anchor="end">${esc(yf(v))}</text>`; }
    F.add(g);
    if(o.xlabel) F.text(this.x + this.w/2, this.y + this.h + 31, o.xlabel, {anchor:"middle", size:11, raw:o.rawLabels});
    if(o.ylabel) F.text(this.x - (o.ylabelOffset || 40), this.y + this.h/2, o.ylabel, {anchor:"middle", size:11, rotate:-90, raw:o.rawLabels});
    if(o.title) F.text(this.x, this.y - 7, o.title, {size:11.5, bold:true});
  }
  clip(s){ this.fig.add(`<g clip-path="url(#${this.id})">${s}</g>`); return this; }
  line(xs, ys, st={}){
    let d = "", pen = false;
    for(let i=0;i<xs.length;i++){ if(!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])){ pen = false; continue; } d += (pen ? "L" : "M") + f(this.X(xs[i]),2) + " " + f(this.Y(ys[i]),2); pen = true; }
    return this.clip(`<path d="${d}" fill="none" stroke="${st.color||"#111"}" stroke-width="${st.width||1.2}" ${st.dash ? `stroke-dasharray="${st.dash}"` : ""} opacity="${st.opacity ?? 1}"/>`);
  }
  marker(x, y, st={}){ return this.clip(this.msvg(this.X(x), this.Y(y), st)); }
  msvg(X, Y, st){
    const r = st.r || 4, fill = st.fill ?? "#111", stroke = st.stroke || "#111", sw = st.sw ?? 0.8, op = st.opacity ?? 1, m = st.m || "o";
    if(m === "o") return `<circle cx="${f(X,2)}" cy="${f(Y,2)}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"/>`;
    if(m === "s") return `<rect x="${f(X-r,2)}" y="${f(Y-r,2)}" width="${2*r}" height="${2*r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"/>`;
    if(m === "^") return `<path d="M${f(X,2)} ${f(Y-r*1.15,2)}L${f(X+r,2)} ${f(Y+r*0.75,2)}L${f(X-r,2)} ${f(Y+r*0.75,2)}Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"/>`;
    if(m === "v") return `<path d="M${f(X,2)} ${f(Y+r*1.15,2)}L${f(X+r,2)} ${f(Y-r*0.75,2)}L${f(X-r,2)} ${f(Y-r*0.75,2)}Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"/>`;
    if(m === "D") return `<path d="M${f(X,2)} ${f(Y-r*1.2,2)}L${f(X+r,2)} ${f(Y,2)}L${f(X,2)} ${f(Y+r*1.2,2)}L${f(X-r,2)} ${f(Y,2)}Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"/>`;
    if(m === "x"){ const q = r*0.9; return `<path d="M${f(X-q,2)} ${f(Y-q,2)}L${f(X+q,2)} ${f(Y+q,2)}M${f(X-q,2)} ${f(Y+q,2)}L${f(X+q,2)} ${f(Y-q,2)}" stroke="${fill}" stroke-width="${st.lw||2.6}"/>`; }
    let p = ""; for(let i=0;i<10;i++){ const a = -Math.PI/2 + i*Math.PI/5, rr = i%2 ? r*0.45 : r*1.25; p += (i ? "L" : "M") + f(X+rr*Math.cos(a),2) + " " + f(Y+rr*Math.sin(a),2); }
    return `<path d="${p}Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  }
  scatter(xs, ys, st={}){
    let s = "";
    const r = st.r || 1.6, fill = st.fill || "#111", op = st.opacity ?? 0.5;
    for(let i=0;i<xs.length;i++) if(Number.isFinite(xs[i]) && Number.isFinite(ys[i])) s += `<circle cx="${f(this.X(xs[i]),1)}" cy="${f(this.Y(ys[i]),1)}" r="${r}"/>`;
    return this.clip(`<g fill="${fill}" opacity="${op}">${s}</g>`);
  }
  label(x, y, s, o={}){ this.fig.text(this.X(x) + (o.dx||0), this.Y(y) + (o.dy||0), s, {size:o.size||8.5, color:o.color, anchor:o.anchor}); return this; }
  ellipseCov(cx, cy, cxx, cxy, cyy, st={}){   // cov in data units
    const tr = cxx + cyy, det = cxx*cyy - cxy*cxy, d = Math.sqrt(Math.max(0, tr*tr/4 - det));
    const l1 = tr/2 + d, l2 = Math.max(0, tr/2 - d), th = 0.5*Math.atan2(2*cxy, cxx - cyy), k = st.k || 1;
    const pts = [];
    for(let i=0;i<=90;i++){ const t = 2*Math.PI*i/90, u = k*Math.sqrt(l1)*Math.cos(t), v = k*Math.sqrt(l2)*Math.sin(t);
      pts.push([cx + u*Math.cos(th) - v*Math.sin(th), cy + u*Math.sin(th) + v*Math.cos(th)]); }
    return this.line(pts.map(p => p[0]), pts.map(p => p[1]), st);
  }
  circleKm(cx, cy, rkm, kx, ky, st={}){
    const xs = [], ys = []; for(let i=0;i<=180;i++){ const t = 2*Math.PI*i/180; xs.push(cx + rkm*Math.cos(t)/kx); ys.push(cy + rkm*Math.sin(t)/ky); }
    return this.line(xs, ys, st);
  }
  hist(vals, bins, st={}){
    const v = vals.filter(Number.isFinite); if(!v.length) return this;
    const [a, b] = st.range || [Math.min(...v), Math.max(...v)], w = (b-a)/bins || 1, cnt = new Array(bins).fill(0);
    v.forEach(x => { const k = x === b ? bins-1 : Math.floor((x-a)/w); if(k >= 0 && k < bins) cnt[k]++; });
    const norm = st.density ? 1/(v.length*w) : 1;
    let s = "";
    if(st.step){
      let d = `M${f(this.X(a),1)} ${f(this.Y(0),1)}`;
      cnt.forEach((c,k) => { d += `L${f(this.X(a+k*w),1)} ${f(this.Y(c*norm),1)}L${f(this.X(a+(k+1)*w),1)} ${f(this.Y(c*norm),1)}`; });
      d += `L${f(this.X(b),1)} ${f(this.Y(0),1)}`;
      s = `<path d="${d}" fill="none" stroke="${st.color}" stroke-width="${st.width||1.4}"/>`;
    } else cnt.forEach((c,k) => { const x0 = this.X(a+k*w), x1 = this.X(a+(k+1)*w), y0 = this.Y(c*norm), y1 = this.Y(0);
      s += `<rect x="${f(x0,1)}" y="${f(Math.min(y0,y1),1)}" width="${f(Math.max(0.5, x1-x0-0.4),1)}" height="${f(Math.abs(y1-y0),1)}" fill="${st.color}" opacity="${st.opacity ?? 0.6}"/>`; });
    this.clip(s);
    return Math.max(...cnt)*norm;
  }
  vline(x, st={}){ return this.clip(`<line x1="${f(this.X(x),1)}" x2="${f(this.X(x),1)}" y1="${this.y}" y2="${this.y+this.h}" stroke="${st.color||"#111"}" stroke-width="${st.width||1}" ${st.dash ? `stroke-dasharray="${st.dash}"` : ""}/>`); }
  hline(y, st={}){ return this.clip(`<line y1="${f(this.Y(y),1)}" y2="${f(this.Y(y),1)}" x1="${this.x}" x2="${this.x+this.w}" stroke="${st.color||"#111"}" stroke-width="${st.width||1}" ${st.dash ? `stroke-dasharray="${st.dash}"` : ""}/>`); }
  errY(x, y, lo, hi, st={}){ const X = this.X(x); return this.clip(`<path d="M${f(X,1)} ${f(this.Y(lo),1)}L${f(X,1)} ${f(this.Y(hi),1)}M${f(X-3,1)} ${f(this.Y(lo),1)}L${f(X+3,1)} ${f(this.Y(lo),1)}M${f(X-3,1)} ${f(this.Y(hi),1)}L${f(X+3,1)} ${f(this.Y(hi),1)}" stroke="${st.color||"#111"}" stroke-width="${st.width||1.1}" fill="none"/>`); }
  scaleBar(km, kx, pos){   // kx: km per x data unit
    const L = (this.X(this.xlim[0] + km/kx) - this.X(this.xlim[0]));
    const x0 = pos === "right" ? this.x + this.w - L - 12 : this.x + 12, y0 = this.y + this.h - 14;
    this.fig.add(`<rect x="${f(x0-4,1)}" y="${f(y0-14,1)}" width="${f(L+8,1)}" height="22" fill="white" opacity="0.8"/><rect x="${f(x0,1)}" y="${f(y0,1)}" width="${f(L/2,1)}" height="4" fill="#111"/><rect x="${f(x0+L/2,1)}" y="${f(y0,1)}" width="${f(L/2,1)}" height="4" fill="white" stroke="#111" stroke-width="0.8"/>`);
    this.fig.text(x0 + L/2, y0 - 3, `${km} km`, {anchor:"middle", size:9.5});
  }
  northArrow(){
    const x = this.x + this.w - 16, y = this.y + 14;
    this.fig.add(`<path d="M${x} ${y}L${x+6} ${y+16}L${x} ${y+12}L${x-6} ${y+16}Z" fill="#111"/>`);
    this.fig.text(x, y - 2, "N", {anchor:"middle", size:10, bold:true});
  }
  legendAbs(x0, y0, items, colWidth, ncol){      // legend in rows below/beside the panels, absolute coordinates
    items.forEach((it, i) => {
      const xx = x0 + (i % ncol)*colWidth + 10, yy = y0 + Math.floor(i/ncol)*15;
      if(it.line) this.fig.add(`<line x1="${xx-8}" x2="${xx+8}" y1="${yy}" y2="${yy}" stroke="${it.color}" stroke-width="${it.width||1.6}" ${it.dash ? `stroke-dasharray="${it.dash}"` : ""}/>`);
      else if(it.box) this.fig.add(`<rect x="${xx-6}" y="${yy-5}" width="12" height="9" fill="${it.color}" opacity="${it.opacity ?? 0.7}"${it.stroke ? ` stroke="${it.stroke}" stroke-width="1.4"` : ""}/>`);
      else this.fig.add(this.msvg(xx, yy, {m:it.m, r:it.r||4, fill:it.fill, stroke:it.stroke||"#111", sw:it.sw}));
      this.fig.text(xx + 13, yy + 3.5, it.label, {size:9.5});
    });
  }
  legend(items, pos="tl", o={}){
    const lh = 13, w = o.width || Math.max(...items.map(it => it.label.length))*5.2 + 30, h = items.length*lh + 6;
    const x0 = pos.includes("r") ? this.x + this.w - w - 6 : this.x + 6, y0 = pos.includes("b") ? this.y + this.h - h - 6 : this.y + 6;
    let s = `<rect x="${f(x0,1)}" y="${f(y0,1)}" width="${f(w,1)}" height="${h}" fill="white" opacity="0.88" stroke="#d1d5db" stroke-width="0.6"/>`;
    this.fig.add(s);
    items.forEach((it, k) => {
      const yy = y0 + 10 + k*lh, xx = x0 + 12;
      if(it.line) this.fig.add(`<line x1="${xx-8}" x2="${xx+8}" y1="${yy}" y2="${yy}" stroke="${it.color}" stroke-width="${it.width||1.6}" ${it.dash ? `stroke-dasharray="${it.dash}"` : ""}/>`);
      else if(it.box) this.fig.add(`<rect x="${xx-6}" y="${yy-5}" width="12" height="9" fill="${it.color}" opacity="${it.opacity ?? 0.7}"${it.stroke ? ` stroke="${it.stroke}" stroke-width="1.4"` : ""}/>`);
      else this.fig.add(this.msvg(xx, yy, {m:it.m, r:it.r||4, fill:it.fill, stroke:it.stroke||"#111", sw:it.sw}));
      this.fig.text(xx + 13, yy + 3.5, it.label, {size:9});
    });
  }
}
/* PNG rasterization of an SVG string (scale 1 = 1 px per SVG unit) */
function svgToPng(svg, scale){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = Math.round(img.width*scale); c.height = Math.round(img.height*scale);
      const g = c.getContext("2d"); g.fillStyle = "white"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? resolve(b) : reject(new Error("PNG encoding failed")), "image/png");
    };
    img.onerror = () => reject(new Error("SVG rasterization failed"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}
/* Minimal ZIP writer (stored, no compression) */
const CRC = (() => { const t = new Uint32Array(256); for(let n=0;n<256;n++){ let c = n; for(let k=0;k<8;k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8){ let c = 0xFFFFFFFF; for(let i=0;i<u8.length;i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function zip(files){            // files: [{name, data: Uint8Array | string | Blob}]
  const enc = new TextEncoder(), chunks = [], central = []; let off = 0;
  const now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)), dd = (((now.getFullYear()-1980) << 9) | ((now.getMonth()+1) << 5) | now.getDate());
  for(const fl of files){
    const data = fl.data instanceof Blob ? new Uint8Array(await fl.data.arrayBuffer()) : (typeof fl.data === "string" ? enc.encode(fl.data) : fl.data);
    const name = enc.encode(fl.name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, dt, true); h.setUint16(12, dd, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    chunks.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, dt, true); c.setUint16(14, dd, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + data.length;
  }
  const cs = central.reduce((a,u) => a + u.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
  return new Blob([...chunks, ...central, new Uint8Array(e.buffer)], {type:"application/zip"});
}
function histMax(vals, bins, range, density){
  const v = vals.filter(Number.isFinite); if(!v.length) return 0;
  const [a, b] = range, w = (b-a)/bins || 1, cnt = new Array(bins).fill(0);
  v.forEach(x => { const k = Math.min(bins-1, Math.floor((x-a)/w)); if(k >= 0) cnt[k]++; });
  return Math.max(...cnt)*(density ? 1/(v.length*w) : 1);
}
return {Figure, PAL, ticksOf, extent, svgToPng, zip, esc, histMax};
})();

