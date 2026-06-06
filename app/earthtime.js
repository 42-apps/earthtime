/* =========================================================================
   EarthTime — World Day & Night Clock
   - Real-time solar terminator over an equirectangular Earth.
   - Day/night composite: bright day → near-black night, with city lights
     glowing through the dark side and a thin twilight band at the edge.
   - Day-of-week tabs near the dateline (left / center / right).
   - Hover tooltip: nearest city, local time, sunrise/sunset, day phase.
   - Click-and-drag: great-circle distance + bearing + flight times.
   - User-configurable city list, persisted to localStorage.
   ========================================================================= */

/* =========================================================================
   Earth imagery — user-selectable style × device-adaptive resolution.
   Two day styles ship (Classic dark-ocean + Blue Marble), each at a hi (8192)
   and lo (2048) tier; night ships hi (8192) / lo (2400). Capable machines get
   the crisp 8192 textures; older / weaker GPUs fall back to the small, fast
   "classic EarthTime" set so the globe stays smooth and never exceeds its
   WebGL texture-size limit.
   ========================================================================= */
const MAP_STYLE_KEY = 'earthtime.mapStyle.v1';   /* 'classic' | 'bluemarble' */

function loadMapStyle() {
  try {
    const v = localStorage.getItem(MAP_STYLE_KEY);
    if (v === 'classic' || v === 'bluemarble') return v;
  } catch (e) {}
  return 'classic';
}
let mapStyle = loadMapStyle();

/* Decide a render tier ONCE per load. 'hi' = full 8192 imagery; 'lo' = the
   small, fast set for GPUs that cap texture size below 8192, or memory- /
   CPU-light devices (so they stay as snappy as the original build). */
const renderTier = (function detectRenderTier() {
  try {
    const c  = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return 'lo';
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
    const mem    = navigator.deviceMemory || 4;       /* Chrome-only; assume OK elsewhere */
    const cores  = navigator.hardwareConcurrency || 4;
    if (maxTex < 8192 || mem <= 2 || cores <= 2) return 'lo';
    return 'hi';
  } catch (e) { return 'lo'; }
})();

function dayImgUrl()   { return `images/day_${mapStyle}_${renderTier}.jpg`; }
function nightImgUrl() { return `images/night_${renderTier}.jpg`; }

const canvas        = document.getElementById('mapCanvas');
const ctx           = canvas.getContext('2d');
const overlayCanvas = document.getElementById('overlayCanvas');
const overlayCtx    = overlayCanvas.getContext('2d');
const globeCanvas   = document.getElementById('globeCanvas');
const utcTimeEl = document.getElementById('utcTime');
const dateEl    = document.getElementById('dateDisplay');
const sunInfoEl = document.getElementById('sunInfo');
const citiesEl  = document.getElementById('cities');
const loadingEl = document.getElementById('loading');
const dayTabsEl = document.getElementById('dayTabs');
const tooltipEl = document.getElementById('mapTooltip');

/* Burger menu + family-pin DOM. */
const menuBtn          = document.getElementById('menuBtn');
const appMenu          = document.getElementById('appMenu');
const addPinBtn        = document.getElementById('addPinBtn');
const pinLayer         = document.getElementById('pinLayer');
const pinPlacer        = document.getElementById('pinPlacer');
const pinPlacerCancel  = document.getElementById('pinPlacerCancel');
const pinNameBackdrop  = document.getElementById('pinNameBackdrop');
const pinNameInput     = document.getElementById('pinNameInput');
const pinNameLoc       = document.getElementById('pinNameLoc');
const pinNameAdd       = document.getElementById('pinNameAdd');
const pinNameCancel    = document.getElementById('pinNameCancel');
const pinNameClose     = document.getElementById('pinNameClose');

/* Family-member pins: [{ id, name, lat, lon, tz }]. */
let familyPins   = [];
let placingPin   = false;          /* true while in "click the map to drop a pin" mode */
let pendingPinLoc = null;          /* {lat, lon} captured by the placement click, awaiting a name */
const pinEls     = new Map();      /* pin id → its DOM element */
let draggingPin  = null;           /* the pin currently being dragged, or null */

/* Offscreen working canvases (reused each frame). */
const MW = 720, MH = 360;
const maskCanvas = document.createElement('canvas');
maskCanvas.width = MW; maskCanvas.height = MH;
const maskCtx = maskCanvas.getContext('2d');

const darkCanvas = document.createElement('canvas');
darkCanvas.width = MW; darkCanvas.height = MH;
const darkCtx = darkCanvas.getContext('2d');

const nightLayer = document.createElement('canvas');
nightLayer.width = MW; nightLayer.height = MH;
const nightCtx = nightLayer.getContext('2d');

let dayImg = null;
let nightImg = null;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load ' + url));
    img.src = url;
  });
}

/* ---------- Solar position (NOAA / Meeus low-precision) ---------- */
function getSolarPosition(date) {
  const JD = date.getTime() / 86400000 + 2440587.5;
  const n  = JD - 2451545.0;
  const L  = (((280.460 + 0.9856474 * n) % 360) + 360) % 360;
  const g  = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * Math.PI/180;
  const lambda  = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2*g)) * Math.PI/180;
  const epsilon = (23.439 - 0.0000004 * n) * Math.PI/180;
  const ra   = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const decl = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  let GMST_hours = (18.697374558 + 24.06570982441908 * n);
  GMST_hours = ((GMST_hours % 24) + 24) % 24;
  let subsolarLon = (ra * 180 / Math.PI) - (GMST_hours * 15);
  subsolarLon = ((subsolarLon + 540) % 360) - 180;
  const subsolarLat = decl * 180 / Math.PI;
  return { lat: subsolarLat, lon: subsolarLon };
}

function solarElevation(lat, lon, sLat, sLon) {
  const latR  = lat  * Math.PI / 180;
  const sLatR = sLat * Math.PI / 180;
  const dLon  = (lon - sLon) * Math.PI / 180;
  const s = Math.sin(latR) * Math.sin(sLatR)
          + Math.cos(latR) * Math.cos(sLatR) * Math.cos(dLon);
  return Math.asin(Math.max(-1, Math.min(1, s))) * 180 / Math.PI;
}

/* ---------- Canvas sizing ---------- */
function resizeCanvas() {
  const wrap = canvas.parentElement;
  const W = wrap.clientWidth - 20;
  const H = wrap.clientHeight - 20;
  let cw = W, ch = W / 2;
  if (ch > H) { ch = H; cw = H * 2; }
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width  = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width  = Math.max(1, Math.floor(cw * dpr));
  canvas.height = Math.max(1, Math.floor(ch * dpr));
  /* Overlay canvas mirrors the map canvas exactly so the measurement
     polyline lines up with the projection. */
  overlayCanvas.style.width  = cw + 'px';
  overlayCanvas.style.height = ch + 'px';
  overlayCanvas.width  = canvas.width;
  overlayCanvas.height = canvas.height;
}

/* ---------- Main render ---------- */
function render() {
  if (!dayImg || !nightImg) return;
  if (viewMode === '3d') return;   // globe paints itself; don't touch the 2D canvas/overlay
  resizeCanvas();
  const W = canvas.width;
  const H = canvas.height;
  const sun = getSolarPosition(new Date());

  /* 1. Day Earth as base. */
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(dayImg, 0, 0, W, H);

  /* 2. Twilight mask (alpha only). Narrow band = Geochron-style edge. */
  const TWILIGHT_DEG = 1.5;
  const imgData = maskCtx.createImageData(MW, MH);
  const data = imgData.data;
  for (let y = 0; y < MH; y++) {
    const lat = 90 - (y + 0.5) * 180 / MH;
    for (let x = 0; x < MW; x++) {
      const lon = (x + 0.5) * 360 / MW - 180;
      const elev = solarElevation(lat, lon, sun.lat, sun.lon);
      let a = (-elev) / TWILIGHT_DEG;
      if (a < 0) a = 0; else if (a > 1) a = 1;
      const idx = (y * MW + x) * 4;
      data[idx] = 0; data[idx+1] = 0; data[idx+2] = 0;
      data[idx + 3] = (a * 255) | 0;
    }
  }
  maskCtx.putImageData(imgData, 0, 0);

  /* 3. Night overlay. Dark mode crushes the night side to near-black; light
     mode lays a soft light-slate wash instead, so the whole Earth stays bright
     with just a gentle terminator. */
  const lightTheme = (typeof theme !== 'undefined' && theme === 'light');
  darkCtx.globalCompositeOperation = 'source-over';
  darkCtx.fillStyle = lightTheme ? '#9fb4d6' : '#01040c';
  darkCtx.fillRect(0, 0, MW, MH);
  darkCtx.globalCompositeOperation = 'destination-in';
  darkCtx.drawImage(maskCanvas, 0, 0);
  ctx.save();
  ctx.globalAlpha = lightTheme ? 0.42 : 0.94;
  ctx.drawImage(darkCanvas, 0, 0, W, H);
  ctx.restore();

  /* 4. Subtle city lights (faint glow only — Geochron has no lights). */
  nightCtx.globalCompositeOperation = 'source-over';
  nightCtx.clearRect(0, 0, MW, MH);
  nightCtx.drawImage(nightImg, 0, 0, MW, MH);
  nightCtx.globalCompositeOperation = 'destination-in';
  nightCtx.drawImage(maskCanvas, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = lightTheme ? 0.18 : 0.45;
  ctx.drawImage(nightLayer, 0, 0, W, H);
  ctx.restore();

  drawGraticule(W, H);
  drawDateLine(W, H);
  drawTerminator(W, H, sun);
  drawSunMarker(W, H, sun);

  /* Keep any in-flight or finalized distance measurement visible on the
     freshly-sized overlay. */
  drawMeasurement();

  /* Re-place family pins for the new canvas size. */
  repositionPins();

  loadingEl.style.display = 'none';
}

/* ---------- Decorations ---------- */
function drawGraticule(W, H) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = (lon + 180) * W / 360;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = (90 - lat) * H / 180;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  const eqY = H / 2;
  ctx.beginPath(); ctx.moveTo(0, eqY); ctx.lineTo(W, eqY); ctx.stroke();
  ctx.setLineDash([4, 6]);
  ctx.strokeStyle = 'rgba(255, 203, 107, 0.18)';
  for (const lat of [23.4367, -23.4367]) {
    const y = (90 - lat) * H / 180;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.restore();
}

/* International Date Line — drawn along the 180° meridian, which on this
   equirectangular projection appears at BOTH edges (left = -180°, right = +180°).
   The real-world IDL has minor political zigzags around Kiribati, the
   Aleutians, etc.; we draw the straight meridian for clarity. */
function drawDateLine(W, H) {
  ctx.save();
  ctx.strokeStyle = 'rgba(120, 200, 240, 0.55)';
  ctx.lineWidth = Math.max(1.2, W / 900);
  ctx.setLineDash([10, 7]);
  ctx.shadowColor = 'rgba(120, 200, 240, 0.3)';
  ctx.shadowBlur = 4;
  /* Inset by 2 px so the dashed line is fully visible (not clipped). */
  ctx.beginPath();
  ctx.moveTo(2, 0);   ctx.lineTo(2, H);
  ctx.moveTo(W - 2, 0); ctx.lineTo(W - 2, H);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;

  /* "IDL" labels at the top corners. */
  ctx.fillStyle = 'rgba(160, 220, 250, 0.7)';
  const fs = Math.max(10, Math.round(11 * Math.max(1, W / 1400)));
  ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('IDL', 8, 8);
  ctx.textAlign = 'right';
  ctx.fillText('IDL', W - 8, 8);
  ctx.restore();
}

function drawTerminator(W, H, sun) {
  const sdR = sun.lat * Math.PI / 180;
  if (Math.abs(Math.tan(sdR)) < 1e-6) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 203, 107, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = 'rgba(255, 203, 107, 0.35)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i <= W; i += 2) {
    const lon = i / W * 360 - 180;
    const dlonR = (lon - sun.lon) * Math.PI / 180;
    const latR = Math.atan(-Math.cos(dlonR) / Math.tan(sdR));
    const lat = latR * 180 / Math.PI;
    const y = (90 - lat) * H / 180;
    if (!started) { ctx.moveTo(i, y); started = true; }
    else ctx.lineTo(i, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawSunMarker(W, H, sun) {
  const x = (sun.lon + 180) * W / 360;
  const y = (90 - sun.lat) * H / 180;
  const r = Math.max(8, Math.min(W, H) * 0.012);
  ctx.save();
  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 6);
  glow.addColorStop(0.00, 'rgba(255, 230, 150, 0.85)');
  glow.addColorStop(0.30, 'rgba(255, 200, 100, 0.40)');
  glow.addColorStop(1.00, 'rgba(255, 200, 100, 0.00)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, r * 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff4cf';
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();
  ctx.restore();
}

/* =========================================================================
   Sunrise / sunset (NOAA-style approximation, accurate to ~1 minute).
   Returns { sunrise: Date, sunset: Date } or { allDay } / { allNight } when
   the sun never sets or never rises that day (polar regions).
   ========================================================================= */
function sunriseSunset(refDate, lat, lon) {
  const d = Math.PI / 180;
  /* Julian day number for 00:00 UTC of the reference date. */
  const Y = refDate.getUTCFullYear();
  const M = refDate.getUTCMonth() + 1;
  const D = refDate.getUTCDate();
  const a = Math.floor((14 - M) / 12);
  const y = Y + 4800 - a;
  const m = M + 12 * a - 3;
  const JDN = D + Math.floor((153*m + 2)/5) + 365*y
            + Math.floor(y/4) - Math.floor(y/100) + Math.floor(y/400) - 32045;
  const JD = JDN - 0.5;

  /* Julian cycle as an INTEGER day-count since J2000 (longitude-adjusted), so
     mean solar noon lands at local noon. Without the round() the transit fell
     ~12 h off, which shifted sunrise/sunset into the wrong half-day and made
     them look swapped (e.g. Cape Town "sunrise 19:45 / sunset 05:44"). */
  const n = Math.round(JD - 2451545.0 - 0.0009 + lon / 360);
  const Jstar = n + 0.0009 - lon / 360;
  const Mdeg = (((357.5291 + 0.98560028 * Jstar) % 360) + 360) % 360;
  const Mrad = Mdeg * d;
  const C = 1.9148*Math.sin(Mrad) + 0.0200*Math.sin(2*Mrad) + 0.0003*Math.sin(3*Mrad);
  const lambdaDeg = (((Mdeg + C + 180 + 102.9372) % 360) + 360) % 360;
  const lambda = lambdaDeg * d;
  const Jtransit = 2451545.0 + Jstar + 0.0053*Math.sin(Mrad) - 0.0069*Math.sin(2*lambda);
  const delta = Math.asin(Math.sin(lambda) * Math.sin(23.4397 * d));

  const latR = lat * d;
  const cosOmega = (Math.sin(-0.83 * d) - Math.sin(latR)*Math.sin(delta))
                 / (Math.cos(latR) * Math.cos(delta));
  if (cosOmega < -1) return { allDay: true };
  if (cosOmega >  1) return { allNight: true };

  const omegaDeg = Math.acos(cosOmega) / d;
  const Jrise = Jtransit - omegaDeg / 360;
  const Jset  = Jtransit + omegaDeg / 360;
  return {
    sunrise: new Date((Jrise - 2440587.5) * 86400000),
    sunset:  new Date((Jset  - 2440587.5) * 86400000),
  };
}

/* Short HH:MM formatter (no seconds), cached per timezone. */
const tipShortFmtCache = {};
function tipShortFmt(tz) {
  if (!tipShortFmtCache[tz]) {
    try {
      tipShortFmtCache[tz] = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });
    } catch (e) { tipShortFmtCache[tz] = tipShortFmt('UTC'); }
  }
  return tipShortFmtCache[tz];
}

/* "Today" in a given timezone — returns a Date at 12:00 UTC of that local day,
   suitable for feeding into sunriseSunset() so we get the right calendar day. */
function localDateForTz(now, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const [y, m, d] = parts.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  } catch (e) {
    return now;
  }
}

/* =========================================================================
   Distance measurement — click and drag two points on the map to draw
   the great-circle path with distance + bearing.
   ========================================================================= */

let measurement   = null;   /* {startLat, startLon, endLat, endLon, dragging, showFullPill} */
let pendingDown   = null;   /* {startLat, startLon, x, y} — set on mousedown, promoted to measurement once cursor moves (flat map) */
let globeDown     = null;   /* {startLat, startLon, x, y} — same, but for a Shift+drag on the globe */
let hoveringGlobe = false;  /* true while the cursor is over the globe (pauses auto-rotate so the tooltip is readable) */
let pillIdleTimer = null;   /* setTimeout id — fires after the cursor has stopped moving, revealing the full pill */
const PILL_IDLE_MS = 500;

/* Repaint the active measurement onto whichever projection is showing. */
function refreshMeasurement() {
  if (viewMode === '3d') drawGlobeMeasurement();
  else                   drawMeasurement();
}

function schedulePillReveal() {
  if (pillIdleTimer) clearTimeout(pillIdleTimer);
  pillIdleTimer = setTimeout(() => {
    pillIdleTimer = null;
    if (measurement) {
      measurement.showFullPill = true;
      refreshMeasurement();
    }
  }, PILL_IDLE_MS);
}

function cancelPillReveal() {
  if (pillIdleTimer) { clearTimeout(pillIdleTimer); pillIdleTimer = null; }
}

function greatCirclePoints(lat1, lon1, lat2, lon2, n) {
  const d = Math.PI / 180;
  const v = (lat, lon) => [
    Math.cos(lat*d) * Math.cos(lon*d),
    Math.cos(lat*d) * Math.sin(lon*d),
    Math.sin(lat*d),
  ];
  const v1 = v(lat1, lon1);
  const v2 = v(lat2, lon2);
  const dot = v1[0]*v2[0] + v1[1]*v2[1] + v1[2]*v2[2];
  const omega = Math.acos(Math.max(-1, Math.min(1, dot)));
  if (omega < 1e-9) return [[lat1, lon1], [lat2, lon2]];
  const sino = Math.sin(omega);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const A = Math.sin((1 - t) * omega) / sino;
    const B = Math.sin(t * omega) / sino;
    const x = A*v1[0] + B*v2[0];
    const y = A*v1[1] + B*v2[1];
    const z = A*v1[2] + B*v2[2];
    pts.push([
      Math.atan2(z, Math.sqrt(x*x + y*y)) / d,
      Math.atan2(y, x) / d,
    ]);
  }
  return pts;
}

function initialBearing(lat1, lon1, lat2, lon2) {
  const d = Math.PI / 180;
  const φ1 = lat1 * d, φ2 = lat2 * d;
  const Δλ = (lon2 - lon1) * d;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (Math.atan2(y, x) / d + 360) % 360;
}

function compassFromDeg(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

/* =========================================================================
   Flight-time aircraft. Ordered fastest → slowest. Each row uses a single
   ✈ glyph; the row tint colour is what differentiates them.

   Per-aircraft parameters:
     cruiseKmh    — top-of-climb cruise ground speed
     climbKmh     — average horizontal ground speed during climb/descent
                     (lower than cruise because the plane is climbing through
                      dense air with reduced TAS, accelerating from V2 to
                      cruise speed)
     climbDistKm  — typical horizontal distance covered while climbing to
                     cruise altitude (mirrored for descent)
     taxiMin      — combined taxi-out + taxi-in overhead

   Notes:
     - Concorde's real Atlantic block time (~3h 30m for ~5,500 km) is
       matched within ~5 min by this model.
     - Boom Overture parameters are estimates from published target specs.
   ========================================================================= */
const AIRCRAFT = [
  { icon: '✈', label: 'Concorde',      cruiseKmh: 2180, climbKmh: 900, climbDistKm: 500, taxiMin: 15, color: '#ffb088' },
  { icon: '✈', label: 'Boom Overture', cruiseKmh: 1800, climbKmh: 850, climbDistKm: 450, taxiMin: 15, color: '#ff9bc8' },
  { icon: '✈', label: 'Private Jet',   cruiseKmh:  950, climbKmh: 700, climbDistKm: 220, taxiMin: 12, color: '#c9bcff' },
  { icon: '✈', label: 'Jumbo Jet',     cruiseKmh:  905, climbKmh: 600, climbDistKm: 280, taxiMin: 20, color: '#a8d4ff' },
];

/* Approximate block time (taxi → takeoff/climb → cruise → descent/land → taxi).
   For flights shorter than the climb+descent distance, the plane never
   reaches full cruise — fall back to the climb-speed average. */
function flightTimeHours(distKm, ac) {
  const climbDescentDist = 2 * ac.climbDistKm;
  if (distKm <= climbDescentDist) {
    return ac.taxiMin / 60 + distKm / ac.climbKmh;
  }
  return ac.taxiMin / 60
       + climbDescentDist / ac.climbKmh
       + (distKm - climbDescentDist) / ac.cruiseKmh;
}

function fmtFlightTime(hours) {
  const totalMin = Math.max(1, Math.round(hours * 60));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `${h}h ${String(m).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function drawMeasurement() {
  const W = overlayCanvas.width;
  const H = overlayCanvas.height;
  overlayCtx.clearRect(0, 0, W, H);
  if (!measurement) return;

  const { startLat, startLon, endLat, endLon } = measurement;
  const points = greatCirclePoints(startLat, startLon, endLat, endLon, 256);

  /* Polyline with dateline-wrap handling. */
  overlayCtx.save();
  overlayCtx.strokeStyle = 'rgba(255, 203, 107, 0.9)';
  overlayCtx.lineWidth = Math.max(1.5, W / 800);
  overlayCtx.shadowColor = 'rgba(255, 203, 107, 0.55)';
  overlayCtx.shadowBlur = 6;
  overlayCtx.lineJoin = 'round';
  overlayCtx.beginPath();
  let lastX = null;
  for (const [lat, lon] of points) {
    const x = (lon + 180) / 360 * W;
    const y = (90 - lat) / 180 * H;
    if (lastX !== null && Math.abs(x - lastX) > W / 2) overlayCtx.moveTo(x, y);
    else if (lastX === null)                            overlayCtx.moveTo(x, y);
    else                                                overlayCtx.lineTo(x, y);
    lastX = x;
  }
  overlayCtx.stroke();
  overlayCtx.restore();

  /* Endpoint markers. */
  const drawDot = (lat, lon) => {
    const x = (lon + 180) / 360 * W;
    const y = (90 - lat) / 180 * H;
    const r = Math.max(4, W / 220);
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, r, 0, Math.PI * 2);
    overlayCtx.fillStyle = '#fff4cf';
    overlayCtx.fill();
    overlayCtx.lineWidth = 1.5;
    overlayCtx.strokeStyle = 'rgba(0,0,0,0.7)';
    overlayCtx.stroke();
  };
  drawDot(startLat, startLon);
  drawDot(endLat, endLon);

  /* Distance + bearing, then the shared flight panel (projection-agnostic). */
  const distKm  = haversineKm(startLat, startLon, endLat, endLon);
  const bearing = initialBearing(startLat, startLon, endLat, endLon);
  const sx = (startLon + 180) / 360 * W;
  const sy = (90 - startLat) / 180 * H;
  const ex = (endLon + 180) / 360 * W;
  const ey = (90 - endLat) / 180 * H;
  drawDistancePanel(overlayCtx, W, H, sx, sy, ex, ey, distKm, bearing, measurement.showFullPill);
}

/* Shared distance / flight-time panel. Given endpoint pixels (sx,sy)→(ex,ey)
   on canvas `ctx` of size W×H, plus the geodesic distance and bearing, paints
   either a small live "X km" chip (showFullPill === false) or the full
   flight-time pill. Reused by the flat map and the globe overlay so both
   projections share identical styling. */
function drawDistancePanel(ctx, W, H, sx, sy, ex, ey, distKm, bearing, showFullPill) {
  const distMi  = distKm * 0.621371;
  const compass = compassFromDeg(bearing);
  const fmtNum  = (n) => Math.round(n).toLocaleString();
  const distText = `${fmtNum(distKm)} km · ${fmtNum(distMi)} mi`;
  const bearText = `Bearing ${bearing.toFixed(0)}° ${compass}`;
  const subText  = 'Approx flying time';

  /* === While the cursor is still moving (showFullPill === false), draw a
        tiny live "X km" chip near the cursor instead of the heavy pill, so
        the user can see the destination underneath the line. ============= */
  if (!showFullPill) {
    const scale = Math.max(1, W / 1000);
    const chipFont = `600 ${Math.round(12 * scale)}px -apple-system, system-ui, sans-serif`;
    ctx.save();
    ctx.font = chipFont;
    const tw = ctx.measureText(distText).width;
    const padX = 10 * scale;
    const chipW = tw + padX * 2;
    const chipH = 24 * scale;
    /* Place above-right of the cursor; flip if it would go off canvas. */
    let chipX = ex + 14 * scale;
    let chipY = ey - chipH - 12 * scale;
    if (chipX + chipW > W - 4) chipX = ex - chipW - 14 * scale;
    if (chipY < 4)             chipY = ey + 14 * scale;
    if (chipX < 4)             chipX = 4;
    if (chipY + chipH > H - 4) chipY = H - chipH - 4;
    ctx.shadowBlur = 0;
    roundRect(ctx, chipX, chipY, chipW, chipH, 6 * scale);
    ctx.fillStyle = 'rgba(2, 6, 18, 0.90)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 203, 107, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffcb6b';
    ctx.fillText(distText, chipX + chipW / 2, chipY + chipH / 2);
    ctx.restore();
    return;
  }

  const flightRows = AIRCRAFT.map(a => ({
    icon:  a.icon,
    label: a.label,
    time:  fmtFlightTime(flightTimeHours(distKm, a)),
    color: a.color,
  }));

  /* Sizing — everything scales with map width so labels stay readable. */
  const scale = Math.max(1, W / 1000);
  const fontHeader = `600 ${Math.round(14 * scale)}px -apple-system, system-ui, sans-serif`;
  const fontSub    = `${Math.round(11 * scale)}px -apple-system, system-ui, sans-serif`;
  const fontRow    = `${Math.round(12 * scale)}px -apple-system, system-ui, sans-serif`;

  ctx.save();
  ctx.font = fontHeader;
  const wHeader = ctx.measureText(distText).width;
  ctx.font = fontSub;
  const wBear   = ctx.measureText(bearText).width;
  const wSubLbl = ctx.measureText(subText).width;

  /* Layout: "✈  Label"   ...   "Time"  */
  const rowGap = 22 * scale;
  ctx.font = fontRow;
  let maxLeft = 0, maxRight = 0;
  for (const r of flightRows) {
    const wL = ctx.measureText(`${r.icon}  ${r.label}`).width;
    const wR = ctx.measureText(r.time).width;
    if (wL > maxLeft)  maxLeft  = wL;
    if (wR > maxRight) maxRight = wR;
  }
  const rowContentW = maxLeft + rowGap + maxRight;

  const padX     = 16 * scale;
  const padY     = 12 * scale;
  const headerH  = 20 * scale;
  const subH     = 16 * scale;
  const divGap   = 12 * scale;
  const rowH     = 22 * scale;
  const contentW = Math.max(wHeader, wBear, wSubLbl, rowContentW);
  const pillW    = contentW + padX * 2;
  const pillH    = padY * 2 + headerH + subH + divGap + subH + rowH * flightRows.length;

  /* Position the pill "in front of" the end cursor along the line's
     direction — so the line + the start endpoint stay visible behind it,
     even on very short drags. */
  const dx = ex - sx, dy = ey - sy;
  const mag = Math.hypot(dx, dy) || 1;
  const dirX = dx / mag;
  const dirY = dy / mag;
  const standoff = 18 * scale;
  let pillX = ex + dirX * (standoff + pillW / 2) - pillW / 2;
  let pillY = ey + dirY * (standoff + pillH / 2) - pillH / 2;
  if (pillX < 6)              pillX = 6;
  if (pillX + pillW > W - 6)  pillX = W - pillW - 6;
  if (pillY < 6)              pillY = 6;
  if (pillY + pillH > H - 6)  pillY = H - pillH - 6;

  ctx.shadowBlur = 0;
  roundRect(ctx, pillX, pillY, pillW, pillH, 10 * scale);
  ctx.fillStyle = 'rgba(2, 6, 18, 0.95)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 203, 107, 0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textBaseline = 'middle';
  let cy = pillY + padY;

  /* Distance header — centered, gold. */
  ctx.textAlign = 'center';
  ctx.font = fontHeader;
  ctx.fillStyle = '#ffcb6b';
  ctx.fillText(distText, pillX + pillW / 2, cy + headerH / 2);
  cy += headerH;

  /* Bearing — centered, muted. */
  ctx.font = fontSub;
  ctx.fillStyle = '#a8b5cf';
  ctx.fillText(bearText, pillX + pillW / 2, cy + subH / 2);
  cy += subH + divGap / 2;

  /* Divider. */
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pillX + padX, cy);
  ctx.lineTo(pillX + pillW - padX, cy);
  ctx.stroke();
  cy += divGap / 2;

  /* "Approx flying time" label. */
  ctx.textAlign = 'center';
  ctx.font = fontSub;
  ctx.fillStyle = '#7989b3';
  ctx.fillText(subText, pillX + pillW / 2, cy + subH / 2);
  cy += subH;

  /* Aircraft rows — "✈ Label" on the left in row colour, time on the right. */
  ctx.font = fontRow;
  for (const r of flightRows) {
    const rowCY = cy + rowH / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = r.color;
    ctx.fillText(`${r.icon}  ${r.label}`, pillX + padX, rowCY);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#e6ecff';
    ctx.fillText(r.time, pillX + pillW - padX, rowCY);
    cy += rowH;
  }

  ctx.restore();
}

function clearMeasurement() {
  measurement = null;
  pendingDown = null;
  globeDown   = null;
  cancelPillReveal();
  refreshMeasurement();
}

/* =========================================================================
   Globe measurement overlay — draws the active measurement onto #overlayCanvas
   using the globe's spherical projection, so Shift+drag distances work in 3D.
   ========================================================================= */
function drawGlobeMeasurement() {
  if (!globe || !overlayCanvas) return;
  /* Match the overlay backing store to the globe's so project() coords align. */
  if (overlayCanvas.width !== globeCanvas.width || overlayCanvas.height !== globeCanvas.height) {
    overlayCanvas.width  = globeCanvas.width;
    overlayCanvas.height = globeCanvas.height;
  }
  const W = overlayCanvas.width;
  const H = overlayCanvas.height;
  overlayCtx.clearRect(0, 0, W, H);
  if (!measurement) return;

  const { startLat, startLon, endLat, endLon } = measurement;
  const points = greatCirclePoints(startLat, startLon, endLat, endLon, 256);

  /* Great-circle arc — only the front-facing portion is drawn. Each time the
     path dips behind the horizon we lift the pen and restart, so the line
     never cuts across the globe's silhouette. */
  overlayCtx.save();
  overlayCtx.strokeStyle = 'rgba(255, 203, 107, 0.95)';
  overlayCtx.lineWidth = Math.max(1.5, W / 800);
  overlayCtx.shadowColor = 'rgba(255, 203, 107, 0.55)';
  overlayCtx.shadowBlur = 6;
  overlayCtx.lineJoin = 'round';
  overlayCtx.lineCap = 'round';
  overlayCtx.beginPath();
  let penDown = false;
  for (const [lat, lon] of points) {
    const p = globe.project(lat, lon);
    if (!p.visible) { penDown = false; continue; }
    if (!penDown) { overlayCtx.moveTo(p.x, p.y); penDown = true; }
    else            overlayCtx.lineTo(p.x, p.y);
  }
  overlayCtx.stroke();
  overlayCtx.restore();

  /* Endpoint markers (only when on the near side). */
  const drawDot = (lat, lon) => {
    const p = globe.project(lat, lon);
    if (!p.visible) return;
    const r = Math.max(4, W / 220);
    overlayCtx.beginPath();
    overlayCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
    overlayCtx.fillStyle = '#fff4cf';
    overlayCtx.fill();
    overlayCtx.lineWidth = 1.5;
    overlayCtx.strokeStyle = 'rgba(0,0,0,0.7)';
    overlayCtx.stroke();
  };
  drawDot(startLat, startLon);
  drawDot(endLat, endLon);

  /* Distance panel, anchored at the projected endpoints. */
  const distKm  = haversineKm(startLat, startLon, endLat, endLon);
  const bearing = initialBearing(startLat, startLon, endLat, endLon);
  const ps = globe.project(startLat, startLon);
  const pe = globe.project(endLat, endLon);
  drawDistancePanel(overlayCtx, W, H, ps.x, ps.y, pe.x, pe.y, distKm, bearing, measurement.showFullPill);
}

/* Runs after every globe frame (globe.onAfterRender). Pauses auto-rotate
   while the cursor hovers the globe, and repaints the measurement so the arc
   tracks the globe as it spins or is dragged. */
function onGlobeFrame() {
  /* Pause auto-rotate while hovering OR aiming a family pin (so the target
     point stays put under the cursor during placement). */
  if ((hoveringGlobe || placingPin || draggingPin) && globe) globe.lastInteractionTime = performance.now();
  if (measurement) drawGlobeMeasurement();
  /* Track family pins as the globe spins. */
  repositionPins();
}

/* =========================================================================
   Cities — defaults, persistence, and rendering
   ========================================================================= */

/* Ten classic "hotel-lobby" world cities, west → east. Trimmed deliberately
   so a fresh install reads cleanly; everything else (Honolulu, Berlin,
   Zürich, Mumbai, Auroville, Easter Island, Cape Town, Melbourne, etc.) is
   still in cities-db.js and one search-and-click away in the ⚙ Cities panel. */
const DEFAULT_CITIES = [
  { name:'Los Angeles', tz:'America/Los_Angeles', lat: 34.05, lon:-118.24 },
  { name:'New York',    tz:'America/New_York',    lat: 40.71, lon: -74.01 },
  { name:'São Paulo',   tz:'America/Sao_Paulo',   lat:-23.55, lon: -46.63 },
  { name:'London',      tz:'Europe/London',       lat: 51.51, lon:  -0.13 },
  { name:'Paris',       tz:'Europe/Paris',        lat: 48.86, lon:   2.35 },
  { name:'Moscow',      tz:'Europe/Moscow',       lat: 55.76, lon:  37.62 },
  { name:'Dubai',       tz:'Asia/Dubai',          lat: 25.27, lon:  55.30 },
  { name:'Hong Kong',   tz:'Asia/Hong_Kong',      lat: 22.32, lon: 114.17 },
  { name:'Tokyo',       tz:'Asia/Tokyo',          lat: 35.69, lon: 139.69 },
  { name:'Sydney',      tz:'Australia/Sydney',    lat:-33.87, lon: 151.21 },
];

const STORAGE_KEY = 'geochron.cities.v1';

function cityKey(c) { return `${c.name}@${c.tz}@${c.lat.toFixed(2)},${c.lon.toFixed(2)}`; }

function loadCities() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (e) { /* fall through */ }
  return DEFAULT_CITIES.map(c => ({ ...c }));
}

function saveCities() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cities)); } catch (e) {}
}

function sortCitiesByLongitude() {
  cities.sort((a, b) => a.lon - b.lon);
}

let cities = loadCities();
sortCitiesByLongitude();

const fmtCache = {};
function getFmt(tz) {
  if (!fmtCache[tz]) {
    try {
      fmtCache[tz] = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });
    } catch (e) {
      /* Invalid timezone — fall back to UTC so the UI doesn't break. */
      fmtCache[tz] = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
      });
    }
  }
  return fmtCache[tz];
}

function buildCities() {
  citiesEl.innerHTML = '';
  for (const c of cities) {
    const el = document.createElement('div');
    el.className = 'city';
    el.dataset.tz = c.tz;
    el.innerHTML = `
      <div class="name"><span class="dot"></span>${c.name}</div>
      <div class="time">—</div>`;
    citiesEl.appendChild(el);
  }
}

function fmtLatLon(lat, lon) {
  const latH = lat >= 0 ? 'N' : 'S';
  const lonH = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${latH}  ${Math.abs(lon).toFixed(2)}°${lonH}`;
}

function updateTimes() {
  const now = new Date();
  const sun = getSolarPosition(now);

  /* Push the latest sun direction into the 3D globe (if instantiated). */
  if (globe) globe.setSunDirection(sun.lat, sun.lon);

  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  utcTimeEl.textContent = `${hh}:${mm}:${ss} UTC`;

  const dFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  dateEl.textContent = dFmt.format(now);

  sunInfoEl.textContent = `Subsolar ${fmtLatLon(sun.lat, sun.lon)}`;

  const cards = citiesEl.querySelectorAll('.city');
  cards.forEach((el, i) => {
    const c = cities[i];
    if (!c) return;
    el.querySelector('.time').textContent = getFmt(c.tz).format(now);
    const elev = solarElevation(c.lat, c.lon, sun.lat, sun.lon);
    el.classList.toggle('daylight', elev > 0);
  });

  updateDayTabs(now);

  /* Tick each family pin's HH:MM clock. */
  updatePinClocks(now);

  /* Refresh the hover tooltip in place so its clock ticks even when the
     cursor is held still over the map. */
  if (lastHover && !tooltipEl.hidden) renderTooltip();
}

/* =========================================================================
   Day-of-week tabs (overlaid on the map, like the Geochron's
   FRIDAY / THURSDAY tabs around the International Date Line)
   ========================================================================= */

function buildDayTabs() {
  dayTabsEl.innerHTML = `
    <div class="day-tab" id="dayLeft"><span class="arrow">◀</span><span class="label">—</span></div>
    <div class="day-tab center" id="dayCenter"><span class="label">—</span></div>
    <div class="day-tab" id="dayRight"><span class="label">—</span><span class="arrow">▶</span></div>
  `;
}

/* Local solar day of week at a given longitude. Approximate local time
   = UTC + longitude/15 h, which is accurate enough for day-name labels. */
function dayNameAtLongitude(date, lon) {
  const local = new Date(date.getTime() + (lon / 15) * 3600 * 1000);
  return local.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toUpperCase();
}

function updateDayTabs(now) {
  const leftLbl   = document.querySelector('#dayLeft .label');
  const centerLbl = document.querySelector('#dayCenter .label');
  const rightLbl  = document.querySelector('#dayRight .label');
  if (!leftLbl) return;
  /* lon -178°: just east of the IDL (the "earlier" day) */
  leftLbl.textContent   = dayNameAtLongitude(now, -178);
  /* lon 0°: UTC / Greenwich day */
  centerLbl.textContent = dayNameAtLongitude(now, 0);
  /* lon +178°: just west of the IDL (the "later" day) */
  rightLbl.textContent  = dayNameAtLongitude(now, 178);
}

/* =========================================================================
   Map hover tooltip — shows nearest known city + local time at the cursor
   ========================================================================= */

/* Great-circle distance in km via the haversine formula. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat/2) ** 2
          + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon/2) ** 2;
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* Search the embedded DB plus user-added cities for the closest match. */
function findNearestCity(lat, lon) {
  let best = null, bestD = Infinity;
  const search = (list, isUser) => {
    for (const c of list) {
      const d = haversineKm(lat, lon, c.lat, c.lon);
      if (d < bestD) { bestD = d; best = { ...c, _user: !!isUser }; }
    }
  };
  search(CITIES_DB, false);
  /* User-added cities that aren't already in the DB. */
  for (const u of cities) {
    if (!CITIES_DB.some(d => d.name === u.name && d.tz === u.tz)) {
      const d = haversineKm(lat, lon, u.lat, u.lon);
      if (d < bestD) { bestD = d; best = { ...u, country: u.country || 'Custom', _user: true }; }
    }
  }
  return best ? { city: best, distanceKm: bestD } : null;
}

/* Cached Intl formatters keyed by timezone. */
const tipTimeFmtCache = {};
const tipDateFmtCache = {};
function tipTimeFmt(tz) {
  if (!tipTimeFmtCache[tz]) {
    try {
      tipTimeFmtCache[tz] = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
    } catch (e) { tipTimeFmtCache[tz] = tipTimeFmt('UTC'); }
  }
  return tipTimeFmtCache[tz];
}
function tipDateFmt(tz) {
  if (!tipDateFmtCache[tz]) {
    try {
      tipDateFmtCache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
      });
    } catch (e) { tipDateFmtCache[tz] = tipDateFmt('UTC'); }
  }
  return tipDateFmtCache[tz];
}

/* Last hover position so the per-second tick can refresh the visible tooltip. */
let lastHover = null; /* { clientX, clientY, lat, lon } */

function showTooltipAt(evt) {
  const rect = canvas.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const y = evt.clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    hideTooltip();
    return;
  }
  const lon = (x / rect.width) * 360 - 180;
  const lat = 90 - (y / rect.height) * 180;
  lastHover = { clientX: evt.clientX, clientY: evt.clientY, lat, lon };
  renderTooltip();
}

function renderTooltip() {
  if (!lastHover) return;
  const { clientX, clientY, lat, lon } = lastHover;
  const result = findNearestCity(lat, lon);
  if (!result) { hideTooltip(); return; }

  const { city, distanceKm } = result;
  const now = new Date();
  const sun = getSolarPosition(now);
  const elev = solarElevation(lat, lon, sun.lat, sun.lon);

  let phaseLabel, phaseClass;
  if (elev > 0)        { phaseLabel = 'Daylight';  phaseClass = 'day'; }
  else if (elev > -6)  { phaseLabel = 'Twilight';  phaseClass = 'twilight'; }
  else                 { phaseLabel = 'Night';     phaseClass = 'night'; }

  const distLabel = distanceKm < 1
    ? '<1 km from'
    : `${Math.round(distanceKm).toLocaleString()} km from`;

  /* Sunrise / sunset at the cursor, formatted in the nearest city's tz. */
  const localDate = localDateForTz(now, city.tz);
  const ss = sunriseSunset(localDate, lat, lon);
  let sunriseHtml;
  if (ss.allDay)        sunriseHtml = `<div class="tip-sunrise"><span class="sunrise">☀ Sun above horizon all day</span></div>`;
  else if (ss.allNight) sunriseHtml = `<div class="tip-sunrise"><span class="sunset">☾ Sun below horizon all day</span></div>`;
  else {
    const sr = tipShortFmt(city.tz).format(ss.sunrise);
    const st = tipShortFmt(city.tz).format(ss.sunset);
    sunriseHtml = `<div class="tip-sunrise">
      <span class="sunrise">☀ Sunrise ${sr}</span>
      <span class="sunset">☾ Sunset ${st}</span>
    </div>`;
  }

  tooltipEl.innerHTML = `
    <div class="tip-city">
      <span>${city.name}</span>
      <span class="tip-country">${city.country || city.tz.split('/').pop()}</span>
    </div>
    <div class="tip-time">${tipTimeFmt(city.tz).format(now)}</div>
    <div class="tip-date">${tipDateFmt(city.tz).format(now)} · ${city.tz}</div>
    <div class="tip-phase ${phaseClass}"><span class="swatch"></span>${phaseLabel}</div>
    ${sunriseHtml}
    <div class="tip-coords">
      <span>${fmtLatLon(lat, lon)}</span>
      <span>${distLabel} ${city.name}</span>
    </div>
  `;

  /* Position with edge-aware flipping so it never overflows the viewport. */
  tooltipEl.hidden = false;
  const tw = tooltipEl.offsetWidth;
  const th = tooltipEl.offsetHeight;
  const pad = 14;
  let tx = clientX + 18;
  let ty = clientY + 18;
  if (tx + tw + pad > window.innerWidth)  tx = clientX - tw - 18;
  if (ty + th + pad > window.innerHeight) ty = clientY - th - 18;
  if (tx < pad) tx = pad;
  if (ty < pad) ty = pad;
  tooltipEl.style.left = tx + 'px';
  tooltipEl.style.top  = ty + 'px';
}

function hideTooltip() {
  tooltipEl.hidden = true;
  lastHover = null;
}

/* =========================================================================
   Burger menu (top-right) + family-member pins
   -------------------------------------------------------------------------
   Pins are plain DOM nodes living in #pinLayer (a fixed, full-viewport,
   pointer-events:none overlay). We re-project each pin's lat/lon to client
   coordinates every frame so they track the flat map AND the spinning globe,
   and tick a 24-hour HH:MM clock for each location once per second.
   ========================================================================= */

/* ---- Burger menu open/close ---- */
function openMenu()  { appMenu.hidden = false; menuBtn.setAttribute('aria-expanded', 'true'); }
function closeMenu() { appMenu.hidden = true;  menuBtn.setAttribute('aria-expanded', 'false'); }
function toggleMenu() { appMenu.hidden ? openMenu() : closeMenu(); }

/* ---- Pin persistence ---- */
const PIN_KEY = 'earthtime.familyPins.v1';

function loadPins() {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.filter(p => p && typeof p.lat === 'number' && typeof p.lon === 'number');
      }
    }
  } catch (e) {}
  return [];
}

function savePins() {
  try { localStorage.setItem(PIN_KEY, JSON.stringify(familyPins)); } catch (e) {}
}

/* Cached per-timezone HH:MM (24h) formatters — matches the city strip. */
const pinClockFmtCache = {};
function pinClockFmt(tz) {
  if (!pinClockFmtCache[tz]) {
    try {
      pinClockFmtCache[tz] = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });
    } catch (e) {
      pinClockFmtCache[tz] = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
      });
    }
  }
  return pinClockFmtCache[tz];
}

/* ---- Pin geometry: lat/lon → client (viewport) px in the active view ---- */
function projectPinToClient(lat, lon) {
  if (viewMode === '3d' && globe) {
    if (!globeCanvas.width) return null;
    const p = globe.project(lat, lon);                 // device px on globeCanvas
    const rect = globeCanvas.getBoundingClientRect();
    return {
      x: rect.left + (p.x / globeCanvas.width)  * rect.width,
      y: rect.top  + (p.y / globeCanvas.height) * rect.height,
      visible: p.visible,                              // false on the far hemisphere
    };
  }
  /* Flat equirectangular map fills the canvas box exactly. */
  const rect = canvas.getBoundingClientRect();
  return {
    x: rect.left + (lon + 180) / 360 * rect.width,
    y: rect.top  + (90 - lat) / 180 * rect.height,
    visible: true,
  };
}

/* Re-place every pin node for the current frame. Hidden when on the back of
   the globe. Called from render(), onGlobeFrame() and applyViewMode(). */
function repositionPins() {
  if (!pinLayer || !familyPins.length) return;
  for (const pin of familyPins) {
    const el = pinEls.get(pin.id);
    if (!el) continue;
    const pos = projectPinToClient(pin.lat, pin.lon);
    if (!pos || !pos.visible) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.left = pos.x + 'px';
    el.style.top  = pos.y + 'px';
  }
}

/* Tick each pin's HH:MM. Called once per second from updateTimes(). */
function updatePinClocks(now = new Date()) {
  for (const pin of familyPins) {
    const el = pinEls.get(pin.id);
    if (!el) continue;
    const c = el.querySelector('.fam-pin-clock');
    if (c) c.textContent = pinClockFmt(pin.tz).format(now);
  }
}

/* Rebuild the whole pin layer from the familyPins array. */
function renderPinLayer() {
  if (!pinLayer) return;
  pinLayer.innerHTML = '';
  pinEls.clear();
  for (const pin of familyPins) {
    const el = document.createElement('div');
    el.className = 'fam-pin' + (pin.isMe ? ' me-pin' : '');
    el.dataset.id = pin.id;
    el.innerHTML =
      '<div class="fam-pin-dot" title="Drag to move"></div>' +
      '<div class="fam-pin-card">' +
        '<span class="fam-pin-name"></span>' +
        '<span class="fam-pin-clock">--:--</span>' +
        '<button class="fam-pin-del" title="Remove pin" aria-label="Remove pin">×</button>' +
      '</div>';
    el.querySelector('.fam-pin-name').textContent = pin.name;
    el.querySelector('.fam-pin-del').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFamilyPin(pin.id);
    });
    /* Drag the dot to reposition the pin (works on the flat map and the globe). */
    el.querySelector('.fam-pin-dot').addEventListener('mousedown', (e) => startPinDrag(e, pin));
    pinLayer.appendChild(el);
    pinEls.set(pin.id, el);
  }
  updatePinClocks();
  repositionPins();
}

/* ---- Add / remove ---- */
function addFamilyPin(name, lat, lon) {
  const near = findNearestCity(lat, lon);
  const tz = (near && near.city && near.city.tz) ? near.city.tz : 'UTC';
  familyPins.push({
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name, lat, lon, tz,
  });
  savePins();
  renderPinLayer();
}

function removeFamilyPin(id) {
  familyPins = familyPins.filter(p => p.id !== id);
  savePins();
  renderPinLayer();
}

/* ---- "Me" pin: the user's own location + local time, derived purely from the
   browser's IANA timezone — no geolocation permission, no network. Created once;
   a flag survives deletion so it doesn't keep reappearing. ---- */
const ME_PIN_FLAG = 'earthtime.mePinCreated.v1';

/* A representative lat/lon for an IANA timezone: a city in the embedded DB that
   shares that zone, else a rough fallback from the zone's current UTC offset. */
function tzRepresentativeLatLon(tz) {
  const city = CITIES_DB.find(c => c.tz === tz);
  if (city) return { lat: city.lat, lon: city.lon };
  let offsetH = 0;
  try {
    const now = new Date();
    const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const loc = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    offsetH = (loc - utc) / 3600000;
  } catch (e) {}
  let lon = ((offsetH * 15 + 540) % 360) - 180;   // ≈ central meridian of the zone
  return { lat: 0, lon };
}

/* The user's own location for first-open globe orientation: the "Me" pin if it
   exists (so a dragged "Me" re-centres there), else the timezone's point. */
function userLocationLatLon() {
  const me = familyPins.find(p => p.isMe);
  if (me && Number.isFinite(me.lat) && Number.isFinite(me.lon)) {
    return { lat: me.lat, lon: me.lon };
  }
  let tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) {}
  return tzRepresentativeLatLon(tz);
}

function ensureMePin() {
  if (familyPins.some(p => p.isMe)) {              // already present from a prior session
    try { localStorage.setItem(ME_PIN_FLAG, '1'); } catch (e) {}
    return;
  }
  let created = false;
  try { created = !!localStorage.getItem(ME_PIN_FLAG); } catch (e) {}
  if (created) return;                             // user removed it before — respect that
  let tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) {}
  const loc = tzRepresentativeLatLon(tz);
  familyPins.push({ id: 'me', name: 'Me', lat: loc.lat, lon: loc.lon, tz, isMe: true });
  try { localStorage.setItem(ME_PIN_FLAG, '1'); } catch (e) {}
  savePins();
  renderPinLayer();
}

/* ---- Pin dragging (grab the dot; works on the flat map and the globe) ---- */
function startPinDrag(e, pin) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();                             // don't start a map measurement / globe spin
  draggingPin = pin;
  document.body.classList.add('dragging-pin');
}

function onPinDragMove(e) {
  if (!draggingPin) return;
  const ll = clientToLatLon(e.clientX, e.clientY);
  if (!ll) return;                                 // off the Earth — keep the last position
  draggingPin.lat = ll.lat;
  draggingPin.lon = ll.lon;
  /* "Me" always keeps the user's real local time; a family pin adopts the
     timezone of wherever it is dropped. */
  if (!draggingPin.isMe) {
    const near = findNearestCity(ll.lat, ll.lon);
    if (near && near.city) draggingPin.tz = near.city.tz;
  }
  repositionPins();
  updatePinClocks();
}

function endPinDrag() {
  if (!draggingPin) return;
  draggingPin = null;
  document.body.classList.remove('dragging-pin');
  savePins();
}

/* ---- Placement flow: arm → click map/globe → name modal → drop ---- */
function startPlacingPin() {
  closeMenu();
  placingPin = true;
  pinPlacer.hidden = false;
}

function cancelPlacingPin() {
  placingPin = false;
  pinPlacer.hidden = true;
  hideTooltip();
}

/* Cursor (client px) → { lat, lon } on whichever view is active, or null if
   the cursor isn't over the Earth. Shared by placement clicks and the live
   placement hover readout. */
function clientToLatLon(clientX, clientY) {
  if (viewMode === '3d' && globe) {
    return globe.pickLatLon(clientX, clientY);         // {lat,lon} or null
  }
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left, y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  return { lat: 90 - (y / rect.height) * 180, lon: (x / rect.width) * 360 - 180 };
}

/* Convert a placement click to lat/lon, then open the name modal. Returns
   false if the click missed the Earth. */
function placePinFromClient(clientX, clientY) {
  const ll = clientToLatLon(clientX, clientY);
  if (!ll) return false;
  openPinNameModal(ll.lat, ll.lon);
  return true;
}

/* While arming a pin, show the normal hover tooltip (nearest city, local time,
   coords) so you can see exactly where the pin will land. */
function showPlacementHover(clientX, clientY) {
  const ll = clientToLatLon(clientX, clientY);
  if (!ll) { hideTooltip(); return; }
  lastHover = { clientX, clientY, lat: ll.lat, lon: ll.lon };
  renderTooltip();
}

function openPinNameModal(lat, lon) {
  cancelPlacingPin();
  pendingPinLoc = { lat, lon };
  const near = findNearestCity(lat, lon);
  const cn = (near && near.city) ? near.city.name : null;
  pinNameLoc.innerHTML = cn
    ? 'Near <strong>' + escapeHtml(cn) + '</strong> · ' + fmtLatLon(lat, lon)
    : fmtLatLon(lat, lon);
  pinNameInput.value = '';
  pinNameBackdrop.hidden = false;
  setTimeout(() => pinNameInput.focus(), 30);
}

function closePinNameModal() {
  pinNameBackdrop.hidden = true;
  pendingPinLoc = null;
}

function confirmPinName() {
  if (!pendingPinLoc) return;
  const name = pinNameInput.value.trim() || 'Pin';
  addFamilyPin(name, pendingPinLoc.lat, pendingPinLoc.lon);
  closePinNameModal();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* =========================================================================
   Settings modal — add / remove / search cities
   ========================================================================= */

const modal          = document.getElementById('modalBackdrop');
const modalClose     = document.getElementById('modalClose');
const doneBtn        = document.getElementById('doneBtn');
const resetBtn       = document.getElementById('resetCitiesBtn');
const settingsBtn    = document.getElementById('settingsBtn');
const userCityListEl = document.getElementById('userCityList');
const searchInput    = document.getElementById('citySearch');
const searchResults  = document.getElementById('searchResults');
const customNameEl   = document.getElementById('customName');
const customTzEl     = document.getElementById('customTz');
const customLatEl    = document.getElementById('customLat');
const customLonEl    = document.getElementById('customLon');
const customAddBtn   = document.getElementById('customAddBtn');

/* Parse the database into a richer object form once. */
const CITIES_DB = (window.CITIES_DB_RAW || []).map(([name, country, tz, lat, lon]) => ({
  name, country, tz, lat, lon,
}));

function isInUserList(dbCity) {
  return cities.some(c => c.name === dbCity.name && c.tz === dbCity.tz);
}

function renderUserCities() {
  userCityListEl.innerHTML = '';
  if (!cities.length) return;
  for (const c of cities) {
    const li = document.createElement('li');
    li.className = 'city-chip';
    li.innerHTML = `
      <span><strong>${c.name}</strong> <span class="country">${c.tz}</span></span>
      <button class="remove" title="Remove" aria-label="Remove">×</button>`;
    li.querySelector('.remove').addEventListener('click', () => {
      cities = cities.filter(x => !(x.name === c.name && x.tz === c.tz && x.lat === c.lat && x.lon === c.lon));
      sortCitiesByLongitude();
      saveCities();
      renderUserCities();
      buildCities();
      updateTimes();
    });
    userCityListEl.appendChild(li);
  }
}

function renderSearchResults(query) {
  searchResults.innerHTML = '';
  const q = (query || '').trim().toLowerCase();
  const items = (!q
    ? CITIES_DB.slice(0, 30)
    : CITIES_DB.filter(c =>
        c.name.toLowerCase().includes(q) || c.country.toLowerCase().includes(q)
      ).slice(0, 60));

  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'result-row';
    empty.textContent = 'No matches.';
    searchResults.appendChild(empty);
    return;
  }

  for (const c of items) {
    const li = document.createElement('li');
    li.className = 'result-row';
    const added = isInUserList(c);
    if (added) li.classList.add('added');
    li.innerHTML = `
      <span><strong>${c.name}</strong> <span class="meta">— ${c.country} · ${c.tz}</span></span>`;
    if (!added) {
      li.addEventListener('click', () => {
        cities.push({ name: c.name, tz: c.tz, lat: c.lat, lon: c.lon });
        sortCitiesByLongitude();
        saveCities();
        renderUserCities();
        renderSearchResults(searchInput.value);
        buildCities();
        updateTimes();
      });
    }
    searchResults.appendChild(li);
  }
}

function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; }
  catch (e) { return false; }
}

function addCustomCity() {
  const name = customNameEl.value.trim();
  const tz   = customTzEl.value.trim();
  const lat  = parseFloat(customLatEl.value);
  const lon  = parseFloat(customLonEl.value);

  if (!name) { alert('Name is required.'); return; }
  if (!isValidTimeZone(tz)) { alert(`"${tz}" is not a valid IANA timezone.`); return; }
  if (!isFinite(lat) || lat < -90  || lat >  90)  { alert('Latitude must be between -90 and 90.');  return; }
  if (!isFinite(lon) || lon < -180 || lon > 180) { alert('Longitude must be between -180 and 180.'); return; }

  cities.push({ name, tz, lat, lon });
  sortCitiesByLongitude();
  saveCities();
  renderUserCities();
  renderSearchResults(searchInput.value);
  buildCities();
  updateTimes();

  customNameEl.value = '';
  customTzEl.value = '';
  customLatEl.value = '';
  customLonEl.value = '';
}

function openModal() {
  modal.hidden = false;
  renderUserCities();
  renderSearchResults('');
  searchInput.value = '';
  setTimeout(() => searchInput.focus(), 50);
}

function closeModal() {
  modal.hidden = true;
}

function resetCities() {
  if (!confirm('Reset your city list to the defaults?')) return;
  cities = DEFAULT_CITIES.map(c => ({ ...c }));
  sortCitiesByLongitude();
  saveCities();
  renderUserCities();
  renderSearchResults(searchInput.value);
  buildCities();
  updateTimes();
}

/* =========================================================================
   2D ↔ 3D view toggle
   ========================================================================= */

let viewMode = '2d';   /* '2d' | '3d' */
let globe = null;      /* lazily-initialized 3D globe */
const VIEW_KEY = 'earthtime.viewMode.v1';

function loadViewMode() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === '3d' || v === '2d') return v;
  } catch (e) {}
  return '2d';
}
function saveViewMode() {
  try { localStorage.setItem(VIEW_KEY, viewMode); } catch (e) {}
}

function applyViewMode() {
  const is3d = viewMode === '3d';
  canvas.hidden        = is3d;
  overlayCanvas.hidden = false;          // overlay paints hover/measurement chrome in BOTH views
  globeCanvas.hidden   = !is3d;

  /* In 3D the overlay must blanket the globe (100%); in 2D the next
     resizeCanvas() restores the letterbox dimensions. Clear it on entry so a
     stale 2D drawing doesn't linger when there's no active measurement yet. */
  if (is3d) {
    overlayCanvas.style.width  = '100%';
    overlayCanvas.style.height = '100%';
    if (overlayCtx) overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  /* The 2D-only chrome (day-of-week tabs, hover tooltip) is irrelevant on
     the 3D globe — hide it to keep that view clean. */
  document.getElementById('dayTabs').style.display = is3d ? 'none' : '';
  if (is3d) hideTooltip();

  const btn = document.getElementById('viewToggleBtn');
  btn.textContent = is3d ? '🗺 Flat' : '🌐 Globe';
  btn.classList.toggle('active', is3d);

  if (is3d) {
    if (!globe && dayImg && nightImg) {
      try {
        globe = new Globe(globeCanvas, dayImg, nightImg);
        globe.onAfterRender = onGlobeFrame;
        globe.setLightMode(theme === 'light');
        const sun = getSolarPosition(new Date());
        globe.setSunDirection(sun.lat, sun.lon);
        /* Face the user's own location on first open (overrides the sun swing). */
        const here = userLocationLatLon();
        globe.orientTo(here.lat, here.lon);
      } catch (err) {
        console.error('Failed to initialise 3D globe:', err);
        viewMode = '2d';
        saveViewMode();
        applyViewMode();
        return;
      }
    }
    if (globe) globe.start();
  } else {
    if (globe) globe.stop();
    hoveringGlobe = false;
    /* Force a 2D re-render in case the layout changed while in 3D. */
    if (dayImg && nightImg) render();
  }

  /* Re-place family pins for whichever projection we just switched to. */
  repositionPins();
}

function toggleViewMode() {
  clearMeasurement();   // don't carry a half-drawn line across projections
  hideTooltip();
  viewMode = (viewMode === '2d') ? '3d' : '2d';
  saveViewMode();
  applyViewMode();
}

/* =========================================================================
   Map style toggle (Classic dark oceans ↔ Blue Marble)
   ========================================================================= */
function updateMapStyleButton() {
  const btn = document.getElementById('mapStyleBtn');
  if (!btn) return;
  btn.textContent = mapStyle === 'bluemarble' ? '🌊 Map: Blue Marble' : '🗺 Map: Classic';
  btn.classList.toggle('active', mapStyle === 'bluemarble');
}

async function setMapStyle(style) {
  if (style !== 'classic' && style !== 'bluemarble') return;
  if (style === mapStyle) return;
  mapStyle = style;
  try { localStorage.setItem(MAP_STYLE_KEY, style); } catch (e) {}
  updateMapStyleButton();
  /* Only the day image differs between styles; swap it in place (the night
     city-lights map is shared). */
  try {
    const img = await loadImage(dayImgUrl());
    dayImg = img;
    if (globe) globe.setDayTexture(img);   // re-upload the globe's day texture
    if (viewMode !== '3d') render();        // repaint the flat map
  } catch (e) {
    console.error('Failed to switch map style:', e);
  }
}

function toggleMapStyle() {
  setMapStyle(mapStyle === 'classic' ? 'bluemarble' : 'classic');
}

/* =========================================================================
   Theme toggle (Dark ↔ Light). Light re-themes the UI chrome only; the map
   and globe keep their day/night + space look. Default: dark.
   ========================================================================= */
const THEME_KEY = 'earthtime.theme.v1';   /* 'dark' | 'light' */

function loadTheme() {
  try { const v = localStorage.getItem(THEME_KEY); if (v === 'light' || v === 'dark') return v; }
  catch (e) {}
  return 'dark';
}
let theme = loadTheme();

function applyTheme() {
  const light = (theme === 'light');
  if (light) document.documentElement.dataset.theme = 'light';
  else       delete document.documentElement.dataset.theme;
  const btn = document.getElementById('themeBtn');
  if (btn) {
    btn.textContent = light ? '🌗 Theme: Light' : '🌗 Theme: Dark';
    btn.classList.toggle('active', light);
  }
  /* Light mode also brightens the Earth itself: the globe lifts toward a bright
     Earth on a light sky, and the flat map redraws with a softer night wash. */
  if (globe) globe.setLightMode(light);
  if (typeof dayImg !== 'undefined' && dayImg && nightImg && viewMode !== '3d') render();
}

function toggleTheme() {
  theme = (theme === 'light') ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  applyTheme();
}

/* ---------- Boot ---------- */
async function init() {
  buildDayTabs();
  buildCities();
  updateTimes();
  setInterval(updateTimes, 1000);

  /* Wire settings modal. */
  settingsBtn.addEventListener('click', openModal);
  modalClose.addEventListener('click', closeModal);
  doneBtn.addEventListener('click', closeModal);
  resetBtn.addEventListener('click', resetCities);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!pinNameBackdrop.hidden) { closePinNameModal(); return; }
    if (placingPin)              { cancelPlacingPin(); return; }
    if (!appMenu.hidden)         { closeMenu(); return; }
    if (!modal.hidden)           { closeModal(); return; }
    if (measurement)             { clearMeasurement(); }
  });
  searchInput.addEventListener('input', (e) => renderSearchResults(e.target.value));
  customAddBtn.addEventListener('click', addCustomCity);

  /* ---- Burger menu (top-right) ---- */
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  /* Clicking any menu item closes the menu (each item has its own handler). */
  appMenu.addEventListener('click', (e) => {
    if (e.target.closest('.menu-item')) closeMenu();
  });
  /* Click anywhere else closes the menu. */
  document.addEventListener('click', (e) => {
    if (appMenu.hidden) return;
    if (e.target === menuBtn || menuBtn.contains(e.target)) return;
    if (!appMenu.contains(e.target)) closeMenu();
  });

  /* ---- Family-pin placement + name modal ---- */
  addPinBtn.addEventListener('click', startPlacingPin);
  pinPlacerCancel.addEventListener('click', cancelPlacingPin);
  pinPlacer.addEventListener('click', (e) => {
    if (e.target.closest('#pinPlacerCancel')) return;   // the Cancel button
    placePinFromClient(e.clientX, e.clientY);
  });
  /* Live location readout while aiming a pin. */
  pinPlacer.addEventListener('mousemove', (e) => {
    if (e.target.closest('#pinPlacerCancel')) { hideTooltip(); return; }
    showPlacementHover(e.clientX, e.clientY);
  });
  pinPlacer.addEventListener('mouseleave', hideTooltip);
  pinNameClose.addEventListener('click', closePinNameModal);
  pinNameCancel.addEventListener('click', closePinNameModal);
  pinNameAdd.addEventListener('click', confirmPinName);
  pinNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmPinName(); }
  });
  pinNameBackdrop.addEventListener('click', (e) => {
    if (e.target === pinNameBackdrop) closePinNameModal();
  });

  /* Pin dragging is global so the gesture survives the cursor leaving the dot. */
  window.addEventListener('mousemove', onPinDragMove);
  window.addEventListener('mouseup', endPinDrag);

  /* Pre-size the map canvas so the loading screen shows a full, softly-glowing
     dark map area rather than a tiny default 300×150 box. */
  resizeCanvas();

  try {
    [dayImg, nightImg] = await Promise.all([
      loadImage(dayImgUrl()),
      loadImage(nightImgUrl()),
    ]);
  } catch (err) {
    loadingEl.textContent = 'Unable to load Earth imagery. Check internet connection.';
    console.error(err);
    return;
  }

  render();
  setInterval(render, 20000);
  window.addEventListener('resize', render);

  /* Restore saved family pins + the auto "Me" pin now that the map is drawn —
     post-render so they don't flash over the loading screen, and so they're
     positioned against the now-sized canvas. */
  familyPins = loadPins();
  renderPinLayer();
  ensureMePin();

  /* View toggle (2D ↔ 3D). Restore the saved mode now that the images
     are available; the globe will lazy-init the first time we switch. */
  viewMode = loadViewMode();
  document.getElementById('viewToggleBtn').addEventListener('click', toggleViewMode);
  applyViewMode();

  /* Map style toggle (Classic ↔ Blue Marble). */
  document.getElementById('mapStyleBtn').addEventListener('click', toggleMapStyle);
  updateMapStyleButton();

  /* Theme toggle (Dark ↔ Light). */
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);
  applyTheme();
  /* Keep the globe canvas crisp on window resize. */
  window.addEventListener('resize', () => { if (globe && viewMode === '3d') globe.resize(); });

  /* Hover tooltip + click-and-drag distance measurement on the map. */
  function pixelToLatLon(evt) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width,  evt.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, evt.clientY - rect.top));
    return {
      lat: 90 - (y / rect.height) * 180,
      lon: (x / rect.width) * 360 - 180,
      inside: (evt.clientX - rect.left) >= 0 && (evt.clientY - rect.top) >= 0
           && (evt.clientX - rect.left) <= rect.width
           && (evt.clientY - rect.top) <= rect.height,
    };
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const { lat, lon, inside } = pixelToLatLon(e);
    if (!inside) return;
    /* Stash the down position; promote to an actual measurement only once
       the user drags more than a few pixels (so a plain click doesn't flash
       a stray dot on the overlay). */
    pendingDown = { startLat: lat, startLon: lon, x: e.clientX, y: e.clientY };
    /* Clear any prior measurement immediately on a new gesture. */
    if (measurement) clearMeasurement();
    hideTooltip();
    e.preventDefault();
  });

  canvas.addEventListener('mousemove', (e) => {
    if (pendingDown) {
      const dx = e.clientX - pendingDown.x;
      const dy = e.clientY - pendingDown.y;
      const moved = (dx*dx + dy*dy) > 25; /* >5 px */
      if (!measurement && moved) {
        measurement = {
          startLat: pendingDown.startLat, startLon: pendingDown.startLon,
          endLat:   pendingDown.startLat, endLon:   pendingDown.startLon,
          dragging: true,
          showFullPill: false,
        };
      }
      if (measurement) {
        const { lat, lon } = pixelToLatLon(e);
        measurement.endLat = lat;
        measurement.endLon = lon;
        /* Hide the heavy pill while the cursor is actively moving; debounce
           a reveal so it pops in once the user pauses. */
        measurement.showFullPill = false;
        schedulePillReveal();
        drawMeasurement();
      }
    } else {
      showTooltipAt(e);
    }
  });

  /* If the cursor leaves the map mid-drag, finalize and reveal the full pill. */
  canvas.addEventListener('mouseleave', () => {
    hideTooltip();
    if (measurement && measurement.dragging) {
      measurement.dragging = false;
      measurement.showFullPill = true;
      cancelPillReveal();
      drawMeasurement();
    }
  });

  /* Catch mouseup even if the user releases off-canvas — show the full pill
     immediately on release. */
  window.addEventListener('mouseup', () => {
    if (measurement && measurement.dragging) {
      measurement.dragging = false;
      measurement.showFullPill = true;
      cancelPillReveal();
      refreshMeasurement();
    }
    pendingDown = null;
    globeDown   = null;
  });

  /* === Globe interaction: hover tooltip (any drag) + Shift+drag distance ===
     The globe's own pointer handlers own plain drags (rotate) and the wheel
     (zoom); these listeners add the readout + measuring on top. A plain drag
     rotates; holding Shift while dragging measures a great-circle distance. */
  const globePick = (e) => (globe ? globe.pickLatLon(e.clientX, e.clientY) : null);

  globeCanvas.addEventListener('mousedown', (e) => {
    if (viewMode !== '3d' || !globe) return;
    if (e.button !== 0 || !e.shiftKey) return;   // plain drag → rotate (handled by globe)
    const hit = globePick(e);
    if (!hit) return;
    globeDown = { startLat: hit.lat, startLon: hit.lon, x: e.clientX, y: e.clientY };
    if (measurement) clearMeasurement();
    hideTooltip();
    e.preventDefault();
  });

  globeCanvas.addEventListener('mousemove', (e) => {
    if (viewMode !== '3d' || !globe) return;
    hoveringGlobe = true;                       // pauses auto-rotate (see onGlobeFrame)

    /* Active Shift+drag measurement. */
    if (globeDown) {
      const dx = e.clientX - globeDown.x;
      const dy = e.clientY - globeDown.y;
      const moved = (dx*dx + dy*dy) > 25; /* >5 px */
      if (!measurement && moved) {
        measurement = {
          startLat: globeDown.startLat, startLon: globeDown.startLon,
          endLat:   globeDown.startLat, endLon:   globeDown.startLon,
          dragging: true,
          showFullPill: false,
        };
      }
      if (measurement) {
        const hit = globePick(e);
        if (hit) { measurement.endLat = hit.lat; measurement.endLon = hit.lon; }
        measurement.showFullPill = false;
        schedulePillReveal();
        drawGlobeMeasurement();
      }
      return;
    }

    /* Plain hover. Suppress the tooltip while the globe is being rotated. */
    if (globe.dragging) { hideTooltip(); return; }
    const hit = globePick(e);
    if (!hit) { hideTooltip(); return; }   // cursor is off the sphere (in space)
    lastHover = { clientX: e.clientX, clientY: e.clientY, lat: hit.lat, lon: hit.lon };
    renderTooltip();
  });

  globeCanvas.addEventListener('mouseleave', () => {
    if (viewMode !== '3d') return;
    hoveringGlobe = false;
    hideTooltip();
    if (measurement && measurement.dragging) {
      measurement.dragging = false;
      measurement.showFullPill = true;
      cancelPillReveal();
      drawGlobeMeasurement();
    }
  });

  window.addEventListener('scroll', hideTooltip, { passive: true });

  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  });

  /* ---------- Help / tutorial overlay ---------- */
  const helpBackdrop = document.getElementById('helpBackdrop');
  const helpBtn      = document.getElementById('helpBtn');
  const helpClose    = document.getElementById('helpClose');
  const helpDone     = document.getElementById('helpDoneBtn');
  const HELP_SEEN_KEY = 'earthtime.helpSeen.v1';

  function openHelp()  { helpBackdrop.hidden = false; }
  function closeHelp() {
    helpBackdrop.hidden = true;
    try { localStorage.setItem(HELP_SEEN_KEY, '1'); } catch (e) {}
  }

  helpBtn.addEventListener('click', openHelp);
  helpClose.addEventListener('click', closeHelp);
  helpDone.addEventListener('click', closeHelp);
  helpBackdrop.addEventListener('click', (e) => {
    if (e.target === helpBackdrop) closeHelp();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !helpBackdrop.hidden) closeHelp();
  });

  /* Auto-show on first run, after a short delay so the map is visible
     behind it first. */
  let helpSeen = false;
  try { helpSeen = !!localStorage.getItem(HELP_SEEN_KEY); } catch (e) {}
  if (!helpSeen) setTimeout(openHelp, 700);
}

init();
