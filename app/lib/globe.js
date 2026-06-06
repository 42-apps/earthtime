/* =========================================================================
   EarthTime — 3D globe view
   -------------------------------------------------------------------------
   Raw WebGL implementation (no Three.js — keeps the bundle ~12 KB instead
   of ~600 KB). Renders a textured sphere with a real-time day/night blend
   driven by the world-space sun direction. Supports drag-to-rotate,
   scroll-to-zoom, and a gentle auto-rotate after idle.

   Public API (window.Globe):
     new Globe(canvas, dayImg, nightImg)
     globe.setSunDirection(subsolarLat, subsolarLon)
     globe.resize()    — call after the canvas client size changes
     globe.start()     — start the rAF render loop
     globe.stop()      — stop the rAF render loop
   ========================================================================= */
(function () {
'use strict';

const VERT = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;

uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;

varying vec3 vWorldNormal;
varying vec3 vModelNormal;
varying vec3 vWorldPos;
varying vec2 vUv;

void main() {
  /* Object-space normal — used for the day/night term so lighting stays
     locked to geography regardless of how the globe is rotated. */
  vModelNormal = aNormal;
  /* World-space normal — used only for the view-dependent atmosphere rim. */
  vWorldNormal = normalize(uNormalMat * aNormal);
  vec4 worldPos = uModel * vec4(aPosition, 1.0);
  vWorldPos = worldPos.xyz;
  vUv = aUv;
  gl_Position = uProjection * uView * worldPos;
}
`;

const FRAG = `
precision mediump float;
varying vec3 vWorldNormal;
varying vec3 vModelNormal;
varying vec3 vWorldPos;
varying vec2 vUv;
uniform sampler2D uDayMap;
uniform sampler2D uNightMap;
uniform vec3 uSunDir;
uniform vec3 uCameraPos;
uniform float uNightLift;   // 0 = real day/night; >0 lifts toward a bright Earth (light mode)

void main() {
  vec3 day = texture2D(uDayMap, vUv).rgb;
  vec3 nightTex = texture2D(uNightMap, vUv).rgb;

  /* Day/night computed in object space (the normal and the sun share that
     frame), so the terminator stays locked to geography as the globe spins.
     c is the cosine of the sun-to-surface angle ≈ sin(sun elevation) here. */
  vec3 N = normalize(vModelNormal);
  vec3 S = normalize(uSunDir);
  float c = dot(N, S);

  /* Broad, natural twilight band: full day by c≈+0.10, fading through
     dawn/dusk to full night by c≈-0.30 — a soft gradient, not a hard edge. */
  float dayAmt = smoothstep(-0.30, 0.10, c);

  /* Lit surface, gently dimmed toward the terminator (grazing sunlight) so
     the day side reads as a curved sphere rather than a flat bright disc. */
  vec3 lit = day * (0.6 + 0.4 * smoothstep(-0.05, 0.6, c));

  /* Night surface, built from three parts so the unlit hemisphere always
     reads as a sphere — never a flat black disc, even over open ocean:
       1. a faint deep-blue ambient floor (constant lift, so dark ocean is
          still visible as a dark globe rather than pure black);
       2. faint moonlit land on top, so coastlines/continents stay readable;
       3. city lights that switch on as the sun sets (faded in by 1 - dayAmt
          so they never bleed onto the day side).
     The cool blue weighting throughout reads as natural moonlight. */
  vec3 nightCol = vec3(0.022, 0.028, 0.045)
                + day * vec3(0.15, 0.17, 0.21)
                + nightTex * 1.4 * (1.0 - dayAmt);

  vec3 color = mix(nightCol, lit, dayAmt);

  /* Atmospheric limb glow — blue on the day side, warming to a sunset orange
     through the terminator, then fading away into deep night. */
  vec3 Nworld = normalize(vWorldNormal);
  vec3 V = normalize(uCameraPos - vWorldPos);
  float fres = pow(1.0 - max(0.0, dot(Nworld, V)), 3.0);
  float warm = smoothstep(0.40, -0.10, c);
  vec3 atmoCol = mix(vec3(0.45, 0.65, 1.0), vec3(1.0, 0.5, 0.22), warm);
  float rim = fres * smoothstep(-0.40, 0.0, c);
  color += atmoCol * rim * 0.6 * (1.0 - 0.7 * uNightLift);

  /* Light mode (uNightLift>0): lift the whole sphere toward bright daylight so
     it reads as a bright Earth — a gentle terminator, not a dark night side. */
  vec3 brightEarth = day * (0.80 + 0.20 * smoothstep(-0.35, 0.45, c));
  color = mix(color, brightEarth, uNightLift);

  gl_FragColor = vec4(color, 1.0);
}
`;

/* ---- Starfield: additive GL points on a distant celestial sphere ---- */
const STAR_VERT = `
attribute vec3 aDir;        // unit celestial direction (RA/Dec baked in)
attribute vec3 aColor;      // per-star tint
attribute float aSize;      // base point size (px @ dpr 1)
attribute float aMag;       // brightness 0..1
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uStarModel;    // rotX(el) * rotY(az + gmst)
uniform float uPointScale;  // devicePixelRatio
uniform float uTwinkle;     // shared time phase for a gentle shimmer
varying vec3 vColor;
varying float vMag;
void main() {
  vec4 world = uStarModel * vec4(aDir * 50.0, 1.0);
  gl_Position = uProjection * uView * world;
  /* Subtle per-star twinkle from a hash of its direction. */
  float ph = fract(sin(dot(aDir.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float tw = 0.82 + 0.18 * sin(uTwinkle + ph * 6.2831853);
  gl_PointSize = aSize * uPointScale;
  vColor = aColor;
  vMag = aMag * tw;
}
`;

const STAR_FRAG = `
precision mediump float;
varying vec3 vColor;
varying float vMag;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float glow = 1.0 - r2;
  float a = vMag * glow * glow;   // soft round falloff
  gl_FragColor = vec4(vColor * a, a);
}
`;

class Globe {
  constructor(canvas, dayImg, nightImg) {
    this.canvas = canvas;
    this.dayImg = dayImg;
    this.nightImg = nightImg;
    this.gl = null;
    this.program = null;
    this.buffers = {};
    this.textures = {};
    this.uniforms = {};
    this.attribs = {};

    /* Camera orbit state — azimuth around Y, elevation around X, distance. */
    this.azimuth = 0;
    this.elevation = 0.18;
    this.cameraZ = 2.7;

    /* World-space sun direction (set by setSunDirection). */
    this.sunDir = new Float32Array([0, 0, 1]);

    /* Auto-rotate / inertia. */
    this.autoRotate = true;
    this.autoRotateSpeed = 0.0009;
    this.spinVelocityAz = 0;
    this.spinVelocityEl = 0;
    this.lastInteractionTime = 0;

    /* Drag tracking. */
    this.dragging = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.lastMoveTime = 0;    // time of the last drag move — gates release momentum

    this.running = false;
    this.rafId = null;

    /* Optional hook invoked at the end of every rendered frame — EarthTime
       uses it to redraw the distance-measurement overlay so the arc stays
       glued to the globe as it rotates. */
    this.onAfterRender = null;

    /* ---- Adaptive quality: measure FPS at runtime and, on weak GPUs, step
       quality down (internal render resolution, then starfield density). It
       only ever DOWNGRADES and settles after a few sample windows. On capable
       machines the first window already clears the target and it disables
       itself, so there is zero ongoing effect. ---- */
    this.renderScale = 1;             // internal-resolution multiplier (1 = native)
    this.starDrawCount = 0;           // how many stars to actually draw (set in _initStars)
    this._qualityLevel = 0;           // 0 = full quality; increases as we downgrade
    this._MAX_QUALITY_LEVEL = 3;
    this._adaptActive = true;         // false once settled or at the quality floor
    this._frameDts = [];              // frame deltas (ms) for the current sample window
    this._warmupFrames = 0;           // frames to skip after a change (let it settle)
    this._lastFrameT = null;

    /* Light mode: lift the globe toward a bright Earth on a light sky
       (set via setLightMode). 0 in the default dark mode. */
    this.lightMode = false;

    this._initGL();
    this._buildSphere();
    this._initStars();      // procedural starfield (no-op if the program fails)
    this._initPlanets();    // naked-eye planets (reuses the star shader)
    this._uploadTextures();
    this._wireInteractions();
    this.resize();
  }

  /* ---------- GL setup ---------- */
  _initGL() {
    const gl = this.canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('Shader compile error: ' + gl.getShaderInfoLog(s));
      }
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER,   VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(program));
    }
    this.program = program;

    this.uniforms = {
      uProjection: gl.getUniformLocation(program, 'uProjection'),
      uView:       gl.getUniformLocation(program, 'uView'),
      uModel:      gl.getUniformLocation(program, 'uModel'),
      uNormalMat:  gl.getUniformLocation(program, 'uNormalMat'),
      uSunDir:     gl.getUniformLocation(program, 'uSunDir'),
      uCameraPos:  gl.getUniformLocation(program, 'uCameraPos'),
      uNightLift:  gl.getUniformLocation(program, 'uNightLift'),
      uDayMap:     gl.getUniformLocation(program, 'uDayMap'),
      uNightMap:   gl.getUniformLocation(program, 'uNightMap'),
    };
    this.attribs = {
      aPosition: gl.getAttribLocation(program, 'aPosition'),
      aNormal:   gl.getAttribLocation(program, 'aNormal'),
      aUv:       gl.getAttribLocation(program, 'aUv'),
    };

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  /* ---------- Sphere geometry ----------
     UV mapping:  u = 0 at lon=-180,  u = 1 at lon=+180,
                  v = 1 at lat=+90,   v = 0 at lat=-90    (NASA equirectangular).
     World layout: +Z is camera-facing (lon=0), +X is east (90°E), +Y is north. */
  _buildSphere() {
    const gl = this.gl;
    const R = 1;
    const segments = 96;
    const rings = 64;

    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];

    for (let r = 0; r <= rings; r++) {
      const v = r / rings;
      const theta = v * Math.PI;           // 0 at +Y (north), π at -Y (south)
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);

      for (let s = 0; s <= segments; s++) {
        const u = s / segments;
        const lon = (u - 0.5) * 2 * Math.PI;   // u=0.5 → 0, u=0 → -π, u=1 → +π
        const x = R * sinT * Math.sin(lon);
        const y = R * cosT;
        const z = R * sinT * Math.cos(lon);
        positions.push(x, y, z);
        normals.push(x / R, y / R, z / R);
        /* Flip v so the texture's row-0 (north pole in NASA images) lands at +Y. */
        uvs.push(u, 1 - v);
      }
    }

    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segments; s++) {
        const a = r * (segments + 1) + s;
        const b = a + segments + 1;
        indices.push(a, b, a + 1);
        indices.push(b, b + 1, a + 1);
      }
    }

    const make = (data, type) => {
      const buf = gl.createBuffer();
      gl.bindBuffer(type, buf);
      gl.bufferData(type, data, gl.STATIC_DRAW);
      return buf;
    };
    this.buffers = {
      pos:   make(new Float32Array(positions), gl.ARRAY_BUFFER),
      norm:  make(new Float32Array(normals),   gl.ARRAY_BUFFER),
      uv:    make(new Float32Array(uvs),       gl.ARRAY_BUFFER),
      idx:   make(new Uint16Array(indices),    gl.ELEMENT_ARRAY_BUFFER),
      count: indices.length,
    };
  }

  /* ---------- Starfield ----------
     A fixed set of stars on a distant celestial sphere (radius 50). Each is a
     unit direction from a random Right Ascension / Declination; at render time
     the whole field is spun by (azimuth + GMST) so it tracks the globe as you
     drag AND drifts slowly with date/time (sidereal motion). Drawn additively
     behind the opaque Earth, so the globe naturally occludes the far side. */
  _initStars() {
    const gl = this.gl;
    this.starProgram = null;
    try {
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(s));
        }
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER,   STAR_VERT));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, STAR_FRAG));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(p));
      }
      this.starProgram = p;
      this.starUniforms = {
        uProjection: gl.getUniformLocation(p, 'uProjection'),
        uView:       gl.getUniformLocation(p, 'uView'),
        uStarModel:  gl.getUniformLocation(p, 'uStarModel'),
        uPointScale: gl.getUniformLocation(p, 'uPointScale'),
        uTwinkle:    gl.getUniformLocation(p, 'uTwinkle'),
      };
      this.starAttribs = {
        aDir:   gl.getAttribLocation(p, 'aDir'),
        aColor: gl.getAttribLocation(p, 'aColor'),
        aSize:  gl.getAttribLocation(p, 'aSize'),
        aMag:   gl.getAttribLocation(p, 'aMag'),
      };

      /* Two populations: a dense uniform all-sky field plus a fainter, tighter
         band hugging the Milky Way (the galactic plane) so the sky reads real. */
      const N_UNIFORM = 5200;
      const N_BAND    = 1800;
      const N = N_UNIFORM + N_BAND;
      const dirs = new Float32Array(N * 3);
      const cols = new Float32Array(N * 3);
      const sizes = new Float32Array(N);
      const mags  = new Float32Array(N);
      let seed = 0x9e3779b9 >>> 0;               // deterministic mulberry32
      const rnd = () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      /* Galactic-plane basis, in our (x = cosδ·sinα, y = sinδ, z = cosδ·cosα)
         convention, from the J2000 galactic north pole & galactic centre. */
      const D2R = Math.PI / 180;
      const ourDir = (raDeg, decDeg) => {
        const ra = raDeg * D2R, dec = decDeg * D2R, cd = Math.cos(dec);
        return [cd * Math.sin(ra), Math.sin(dec), cd * Math.cos(ra)];
      };
      const dot3 = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
      const norm3 = (a) => { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/m, a[1]/m, a[2]/m]; };
      const cross3 = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
      const Zg = norm3(ourDir(192.8595, 27.1283));          // galactic north pole
      let   Xg = ourDir(266.4050, -28.9362);                 // galactic centre (l=0)
      Xg = norm3([Xg[0]-dot3(Xg,Zg)*Zg[0], Xg[1]-dot3(Xg,Zg)*Zg[1], Xg[2]-dot3(Xg,Zg)*Zg[2]]);
      const Yg = cross3(Zg, Xg);                             // l = 90°

      const tint = (cr) => {
        if (cr < 0.12) return [0.75, 0.83, 1.0];   // hot blue-white
        if (cr < 0.24) return [1.0, 0.86, 0.68];   // warm yellow
        return [1.0, 1.0, 1.0];
      };
      let idx = 0;
      const put = (dx, dy, dz, size, mag, cr) => {
        dirs[idx*3] = dx; dirs[idx*3+1] = dy; dirs[idx*3+2] = dz;
        const t = tint(cr); cols[idx*3] = t[0]; cols[idx*3+1] = t[1]; cols[idx*3+2] = t[2];
        sizes[idx] = size; mags[idx] = mag; idx++;
      };
      /* Uniform all-sky field. */
      for (let i = 0; i < N_UNIFORM; i++) {
        const dec = Math.asin(2 * rnd() - 1);    // uniform over the sphere
        const ra  = 2 * Math.PI * rnd();
        const cd  = Math.cos(dec);
        put(cd * Math.sin(ra), Math.sin(dec), cd * Math.cos(ra),
            1.0 + 3.0 * Math.pow(rnd(), 3.0),    // few large
            0.22 + 0.78 * Math.pow(rnd(), 2.4),  // mostly faint
            rnd());
      }
      /* Milky Way band: faint stars concentrated near the galactic plane. */
      for (let i = 0; i < N_BAND; i++) {
        const l = 2 * Math.PI * rnd();
        const b = (rnd() + rnd() - 1) * 0.16;    // tight zero-mean spread (≈ ±9°)
        const cb = Math.cos(b), sb = Math.sin(b), cl = Math.cos(l), sl = Math.sin(l);
        put(cb*cl*Xg[0] + cb*sl*Yg[0] + sb*Zg[0],
            cb*cl*Xg[1] + cb*sl*Yg[1] + sb*Zg[1],
            cb*cl*Xg[2] + cb*sl*Yg[2] + sb*Zg[2],
            0.8 + 1.4 * Math.pow(rnd(), 2.0),
            0.12 + 0.30 * rnd(),                 // faint, diffuse glow
            rnd() < 0.7 ? 0.5 : rnd());          // mostly white
      }
      const mk = (data) => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        return b;
      };
      this.starBuffers = { dir: mk(dirs), col: mk(cols), size: mk(sizes), mag: mk(mags) };
      this.starCount = N;
      this.starDrawCount = N;
    } catch (err) {
      console.warn('EarthTime: starfield disabled —', err && err.message);
      this.starProgram = null;
    }
  }

  /* Greenwich Mean Sidereal Time as an angle (radians). Drives the slow
     date/time drift of the starfield. */
  _gmstRadians(date) {
    const jd = date.getTime() / 86400000 + 2440587.5;   // Unix ms → Julian Date
    const d = jd - 2451545.0;                            // days since J2000.0
    let deg = 280.46061837 + 360.98564736629 * d;
    deg = ((deg % 360) + 360) % 360;
    return deg * Math.PI / 180;
  }

  _drawStars(proj, view, nowMs) {
    if (!this.starProgram || !this.starDrawCount) return;
    const gl = this.gl;
    const gmst = this._gmstRadians(new Date());
    const starModel = multiply(rotX(this.elevation), rotY(this.azimuth + gmst));
    gl.useProgram(this.starProgram);
    gl.uniformMatrix4fv(this.starUniforms.uProjection, false, proj);
    gl.uniformMatrix4fv(this.starUniforms.uView,       false, view);
    gl.uniformMatrix4fv(this.starUniforms.uStarModel,  false, starModel);
    gl.uniform1f(this.starUniforms.uPointScale, window.devicePixelRatio || 1);
    gl.uniform1f(this.starUniforms.uTwinkle, (nowMs % 6283) / 1000);
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);            // additive glow on black
    bindAttrib(gl, this.starAttribs.aDir,   this.starBuffers.dir,  3);
    bindAttrib(gl, this.starAttribs.aColor, this.starBuffers.col,  3);
    bindAttrib(gl, this.starAttribs.aSize,  this.starBuffers.size, 1);
    bindAttrib(gl, this.starAttribs.aMag,   this.starBuffers.mag,  1);
    gl.drawArrays(gl.POINTS, 0, this.starDrawCount);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  /* ---------- Planets ----------
     The five naked-eye planets, drawn with the star shader as brighter tinted
     points. Positions come from low-precision (Schlyter) orbital elements —
     good to ~1° — recomputed each frame so they drift across the sky with the
     real date, sitting correctly among the stars. */
  _initPlanets() {
    this.planetCount = 0;
    if (!this.starProgram) return;            // shares the star program; skip if it failed
    const gl = this.gl;
    /* Each: tint, point size, brightness, then [epoch, per-day rate] elements
       (N node, i inclination, w arg. perihelion in °, a in AU, e, M mean anomaly). */
    this._planets = [
      { col: [0.80, 0.76, 0.68], size: 3.0, mag: 0.55,   // Mercury
        N: [48.3313, 3.24587e-5], i: [7.0047, 5.00e-8], w: [29.1241, 1.01444e-5],
        a: [0.387098, 0], e: [0.205635, 5.59e-10], M: [168.6562, 4.0923344368] },
      { col: [1.00, 0.97, 0.88], size: 6.2, mag: 1.00,   // Venus
        N: [76.6799, 2.46590e-5], i: [3.3946, 2.75e-8], w: [54.8910, 1.38374e-5],
        a: [0.723330, 0], e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244] },
      { col: [1.00, 0.52, 0.36], size: 4.4, mag: 0.85,   // Mars
        N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5],
        a: [1.523688, 0], e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766] },
      { col: [1.00, 0.91, 0.76], size: 5.6, mag: 0.97,   // Jupiter
        N: [100.4542, 2.76854e-5], i: [1.3030, -1.557e-7], w: [273.8777, 1.64505e-5],
        a: [5.20256, 0], e: [0.048498, 4.469e-9], M: [19.8950, 0.0830853001] },
      { col: [1.00, 0.89, 0.66], size: 4.8, mag: 0.90,   // Saturn
        N: [113.6634, 2.38980e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5],
        a: [9.55475, 0], e: [0.055546, -9.499e-9], M: [316.9670, 0.0334442282] },
    ];
    this._sunElem = { w: [282.9404, 4.70935e-5], e: [0.016709, -1.151e-9], M: [356.0470, 0.9856002585] };
    this.planetCount = this._planets.length;
    this._planetDirs = new Float32Array(this.planetCount * 3);
    const col = new Float32Array(this.planetCount * 3);
    const size = new Float32Array(this.planetCount);
    const mag = new Float32Array(this.planetCount);
    this._planets.forEach((p, k) => {
      col[k*3] = p.col[0]; col[k*3+1] = p.col[1]; col[k*3+2] = p.col[2];
      size[k] = p.size; mag[k] = p.mag;
    });
    const mk = (data, usage) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      return b;
    };
    this.planetBuffers = {
      dir:  mk(this._planetDirs, gl.DYNAMIC_DRAW),
      col:  mk(col, gl.STATIC_DRAW),
      size: mk(size, gl.STATIC_DRAW),
      mag:  mk(mag, gl.STATIC_DRAW),
    };
  }

  /* Fill this._planetDirs with geocentric equatorial unit directions (our
     x = cosδ·sinα, y = sinδ, z = cosδ·cosα convention) for `date`. */
  _computePlanetDirs(date) {
    const out = this._planetDirs;
    const jd = date.getTime() / 86400000 + 2440587.5;
    const d  = jd - 2451543.5;                  // days since 2000 Jan 0.0
    const D2R = Math.PI / 180;
    const ecl = (23.4393 - 3.563e-7 * d) * D2R;
    const rev = (x) => { x %= 360; return x < 0 ? x + 360 : x; };
    const kepler = (M, e) => {                  // mean → eccentric anomaly (radians)
      let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
      for (let k = 0; k < 12; k++) {
        const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        E -= dE;
        if (Math.abs(dE) < 1e-8) break;
      }
      return E;
    };
    /* Sun → geocentric rectangular ecliptic coords (xs, ys; zs = 0). */
    const S = this._sunElem;
    const Ms = rev(S.M[0] + S.M[1] * d) * D2R;
    const ws = (S.w[0] + S.w[1] * d) * D2R;
    const es = S.e[0] + S.e[1] * d;
    const Es = kepler(Ms, es);
    const xvs = Math.cos(Es) - es, yvs = Math.sqrt(1 - es * es) * Math.sin(Es);
    const lons = Math.atan2(yvs, xvs) + ws;
    const rs = Math.hypot(xvs, yvs);
    const xs = rs * Math.cos(lons), ys = rs * Math.sin(lons);
    for (let k = 0; k < this._planets.length; k++) {
      const p = this._planets[k];
      const N = (p.N[0] + p.N[1] * d) * D2R;
      const i = (p.i[0] + p.i[1] * d) * D2R;
      const w = (p.w[0] + p.w[1] * d) * D2R;
      const a =  p.a[0] + p.a[1] * d;
      const e =  p.e[0] + p.e[1] * d;
      const M = rev(p.M[0] + p.M[1] * d) * D2R;
      const E = kepler(M, e);
      const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
      const v = Math.atan2(yv, xv), r = Math.hypot(xv, yv);
      const cN = Math.cos(N), sN = Math.sin(N), ci = Math.cos(i), si = Math.sin(i);
      const cvw = Math.cos(v + w), svw = Math.sin(v + w);
      /* heliocentric ecliptic → add Sun → geocentric ecliptic */
      const xh = r * (cN * cvw - sN * svw * ci);
      const yh = r * (sN * cvw + cN * svw * ci);
      const zh = r * (svw * si);
      const xg = xh + xs, yg = yh + ys, zg = zh;
      /* ecliptic → equatorial */
      const xe = xg;
      const ye = yg * Math.cos(ecl) - zg * Math.sin(ecl);
      const ze = yg * Math.sin(ecl) + zg * Math.cos(ecl);
      const RA = Math.atan2(ye, xe);
      const Dec = Math.atan2(ze, Math.hypot(xe, ye));
      const cd = Math.cos(Dec);
      out[k*3]   = cd * Math.sin(RA);
      out[k*3+1] = Math.sin(Dec);
      out[k*3+2] = cd * Math.cos(RA);
    }
    return out;
  }

  _drawPlanets(proj, view) {
    if (!this.starProgram || !this.planetCount) return;
    const gl = this.gl;
    this._computePlanetDirs(new Date());
    const gmst = this._gmstRadians(new Date());
    const starModel = multiply(rotX(this.elevation), rotY(this.azimuth + gmst));
    gl.useProgram(this.starProgram);
    gl.uniformMatrix4fv(this.starUniforms.uProjection, false, proj);
    gl.uniformMatrix4fv(this.starUniforms.uView,       false, view);
    gl.uniformMatrix4fv(this.starUniforms.uStarModel,  false, starModel);
    gl.uniform1f(this.starUniforms.uPointScale, window.devicePixelRatio || 1);
    gl.uniform1f(this.starUniforms.uTwinkle, 0.0);     // planets shine steadily
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.planetBuffers.dir);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._planetDirs);
    bindAttrib(gl, this.starAttribs.aDir,   this.planetBuffers.dir,  3);
    bindAttrib(gl, this.starAttribs.aColor, this.planetBuffers.col,  3);
    bindAttrib(gl, this.starAttribs.aSize,  this.planetBuffers.size, 1);
    bindAttrib(gl, this.starAttribs.aMag,   this.planetBuffers.mag,  1);
    gl.drawArrays(gl.POINTS, 0, this.planetCount);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  /* ---------- Textures ---------- */
  _uploadTexture(img) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const isPow2 = (n) => (n & (n - 1)) === 0;
    if (isPow2(img.width) && isPow2(img.height)) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  _uploadTextures() {
    this.textures.day   = this._uploadTexture(this.dayImg);
    this.textures.night = this._uploadTexture(this.nightImg);
  }

  /* Swap the day-map texture in place when the user toggles map style. The
     night city-lights texture is style-independent, so it is left untouched. */
  setDayTexture(img) {
    this.dayImg = img;
    const old = this.textures.day;
    this.textures.day = this._uploadTexture(img);
    if (old) this.gl.deleteTexture(old);
  }

  /* Toggle bright-Earth + light-sky rendering (light mode). */
  setLightMode(on) { this.lightMode = !!on; }

  /* ---------- Interaction ---------- */
  _wireInteractions() {
    const c = this.canvas;
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.shiftKey) return;  // Shift+drag is reserved for the distance tool
      this.dragging = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.spinVelocityAz = 0;
      this.spinVelocityEl = 0;
      this.lastMoveTime = performance.now();
      this.lastInteractionTime = this.lastMoveTime;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      const sens = 0.005;
      /* Grab-and-drag (Google Earth): the surface follows the cursor —
         drag left → the world moves left, drag right → it moves right. */
      const dAz = dx * sens;
      const dEl = dy * sens;
      this.azimuth   += dAz;
      this.elevation += dEl;
      const limit = Math.PI / 2 - 0.05;
      if (this.elevation >  limit) this.elevation =  limit;
      if (this.elevation < -limit) this.elevation = -limit;
      /* Remember the throw velocity (same sign as the drag) for release
         momentum — smoothed over recent moves so a flick gives a consistent
         spin, and clamped so a big jump can't launch the globe. */
      const MAX_THROW = 0.14;
      const cl = (x) => Math.max(-MAX_THROW, Math.min(MAX_THROW, x));
      this.spinVelocityAz = cl(0.5 * this.spinVelocityAz + 0.5 * dAz);
      this.spinVelocityEl = cl(0.5 * this.spinVelocityEl + 0.5 * dEl);
      this.lastMoveTime = performance.now();
      this.lastInteractionTime = this.lastMoveTime;
    });
    window.addEventListener('mouseup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      /* Only a release while still moving imparts momentum; if the cursor was
         paused before letting go, don't fling the globe (matches Google Earth). */
      if (performance.now() - this.lastMoveTime > 90) {
        this.spinVelocityAz = 0;
        this.spinVelocityEl = 0;
      }
    });
    c.addEventListener('wheel', (e) => {
      this.cameraZ *= 1 + e.deltaY * 0.0015;
      if (this.cameraZ < 1.4) this.cameraZ = 1.4;
      if (this.cameraZ > 7)   this.cameraZ = 7;
      this.lastInteractionTime = performance.now();
      e.preventDefault();
    }, { passive: false });
  }

  /* ---------- Public ---------- */
  setSunDirection(subsolarLat, subsolarLon) {
    const lat = subsolarLat * Math.PI / 180;
    const lon = subsolarLon * Math.PI / 180;
    /* Match the sphere's longitude convention exactly: lon=0 at +Z, lon=90° at +X. */
    this.sunDir[0] = Math.cos(lat) * Math.sin(lon);
    this.sunDir[1] = Math.sin(lat);
    this.sunDir[2] = Math.cos(lat) * Math.cos(lon);

    /* First time we learn where the sun is, swing the camera around so the
       daylit hemisphere faces the viewer — a lit Earth makes a far better
       first impression than whatever happens to be at longitude 0. The user
       can still drag freely and auto-rotate takes over after a brief pause. */
    if (!this._orientedToSun) {
      this._orientedToSun = true;
      this.azimuth = lon;
      this.lastInteractionTime = performance.now();
    }
  }

  /* Centre the globe on a surface point — used on first open to face the user's
     own location. Mirrors project()'s convention: azimuth = -lon brings that
     meridian to the front (+Z), elevation = lat tilts it to the screen centre
     (clamped to the same limit as drag). Sets _orientedToSun so the first sun
     update won't swing the camera away. */
  orientTo(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    this.azimuth = -lon * Math.PI / 180;
    const limit = Math.PI / 2 - 0.05;
    const el = lat * Math.PI / 180;
    this.elevation = Math.max(-limit, Math.min(limit, el));
    this._orientedToSun = true;
    this.lastInteractionTime = performance.now();
  }

  /* Screen (client) pixel → { lat, lon } on the sphere, or null if the ray
     misses the globe. The camera is axis-aligned (eye on +Z looking at the
     origin, up = +Y), so view space equals world space up to a translation —
     which lets us build the pick ray analytically without a matrix inverse. */
  pickLatLon(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const fovy = Math.PI / 4.5;
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const tan = Math.tan(fovy / 2);
    let dx = ndcX * tan * aspect, dy = ndcY * tan, dz = -1;
    const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
    const oz = this.cameraZ;                       // ray origin = (0, 0, cameraZ)
    /* Intersect the unit sphere at the origin: |o + s·d|² = 1. */
    const b = 2 * oz * dz;
    const c = oz * oz - 1;
    const disc = b * b - 4 * c;
    if (disc < 0) return null;                      // cursor is off the globe
    const s = (-b - Math.sqrt(disc)) / 2;           // nearest (front-face) hit
    if (s < 0) return null;
    const wx = s * dx, wy = s * dy, wz = oz + s * dz;
    return this._worldToLatLon(wx, wy, wz);
  }

  /* Inverse of the model rotation: world → model = rotY(-az)·rotX(-el). */
  _worldToLatLon(wx, wy, wz) {
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    const y1 =  ce * wy + se * wz;
    const z1 = -se * wy + ce * wz;
    const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
    const mx = ca * wx - sa * z1;
    const my = y1;
    const mz = sa * wx + ca * z1;
    const lat = Math.asin(Math.max(-1, Math.min(1, my))) * 180 / Math.PI;
    const lon = Math.atan2(mx, mz) * 180 / Math.PI;
    return { lat, lon };
  }

  /* { lat, lon } → { x, y, visible } in *device* pixels on the globe canvas.
     `visible` is false when the point sits on the far hemisphere (occluded by
     the globe), so callers can clip arcs to the near side. */
  project(lat, lon) {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const mx = Math.cos(la) * Math.sin(lo);
    const my = Math.sin(la);
    const mz = Math.cos(la) * Math.cos(lo);
    /* model → world: world = rotX(el)·rotY(az)·model. */
    const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
    const x1 = ca * mx + sa * mz, y1 = my, z1 = -sa * mx + ca * mz;
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    const wx = x1, wy = ce * y1 - se * z1, wz = se * y1 + ce * z1;
    const visible = wz > 1 / this.cameraZ;          // near-cap horizon test
    const denom = this.cameraZ - wz;
    const fovy = Math.PI / 4.5;
    const f = 1 / Math.tan(fovy / 2);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const ndcX = (f / aspect * wx) / denom;
    const ndcY = (f * wy) / denom;
    const x = (ndcX * 0.5 + 0.5) * this.canvas.width;
    const y = (0.5 - ndcY * 0.5) * this.canvas.height;
    return { x, y, visible };
  }

  resize() {
    /* renderScale (<1 on weak GPUs) shrinks the drawing buffer; CSS upscales it
       back to the same on-screen size — classic dynamic resolution, the cheapest
       big perf lever. */
    const dpr = (window.devicePixelRatio || 1) * this.renderScale;
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.render();
      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  /* ---------- Render ---------- */
  render() {
    const gl = this.gl;
    if (this._adaptActive) this._measureFrame();
    this.resize();

    const now = performance.now();
    if (!this.dragging) {
      /* Release momentum — continues in the drag direction and eases out. */
      this.azimuth   += this.spinVelocityAz;
      this.elevation += this.spinVelocityEl;
      const FRICTION = 0.965;   // longer, smoother coast (Google-Earth feel)
      this.spinVelocityAz *= FRICTION;
      this.spinVelocityEl *= FRICTION;
      if (Math.abs(this.spinVelocityAz) < 1e-4) this.spinVelocityAz = 0;
      if (Math.abs(this.spinVelocityEl) < 1e-4) this.spinVelocityEl = 0;
      const limit = Math.PI / 2 - 0.05;
      if (this.elevation >  limit) this.elevation =  limit;
      if (this.elevation < -limit) this.elevation = -limit;
      if (this.autoRotate && (now - this.lastInteractionTime > 2000)) {
        this.azimuth += this.autoRotateSpeed;
      }
    }

    if (this.lightMode) gl.clearColor(0.74, 0.83, 0.94, 1.0);    // soft daytime sky
    else                gl.clearColor(0.004, 0.006, 0.013, 1.0); // near-black deep space
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const proj = perspective(Math.PI / 4.5, aspect, 0.1, 100);
    const view = lookAt([0, 0, this.cameraZ], [0, 0, 0], [0, 1, 0]);

    /* Starfield + planets first, as a distant background (skipped in light mode,
       where the sky is bright daytime blue); the opaque Earth drawn next
       naturally hides whatever sits on its far side. */
    if (!this.lightMode) {
      this._drawStars(proj, view, now);
      this._drawPlanets(proj, view);
    }

    gl.useProgram(this.program);
    const model = multiply(rotX(this.elevation), rotY(this.azimuth));
    const nmat = mat3FromMat4(model);

    gl.uniformMatrix4fv(this.uniforms.uProjection, false, proj);
    gl.uniformMatrix4fv(this.uniforms.uView,       false, view);
    gl.uniformMatrix4fv(this.uniforms.uModel,      false, model);
    gl.uniformMatrix3fv(this.uniforms.uNormalMat,  false, nmat);
    gl.uniform3fv(this.uniforms.uSunDir, this.sunDir);
    gl.uniform3f(this.uniforms.uCameraPos, 0, 0, this.cameraZ);
    gl.uniform1f(this.uniforms.uNightLift, this.lightMode ? 0.82 : 0.0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.day);
    gl.uniform1i(this.uniforms.uDayMap, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.night);
    gl.uniform1i(this.uniforms.uNightMap, 1);

    bindAttrib(gl, this.attribs.aPosition, this.buffers.pos, 3);
    bindAttrib(gl, this.attribs.aNormal,   this.buffers.norm, 3);
    bindAttrib(gl, this.attribs.aUv,       this.buffers.uv,   2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.idx);
    gl.drawElements(gl.TRIANGLES, this.buffers.count, gl.UNSIGNED_SHORT, 0);

    if (this.onAfterRender) this.onAfterRender();
  }

  /* ---------- Adaptive quality (runtime FPS scaling) ---------- */
  /* Called once per frame while adapting; collects frame deltas and, after a
     short warmup plus a full window, decides whether to step quality down. */
  _measureFrame() {
    const t = performance.now();
    if (this._lastFrameT !== null) {
      if (this._warmupFrames < 20) {
        this._warmupFrames++;                 // ignore post-change settling frames
      } else {
        this._frameDts.push(t - this._lastFrameT);
        if (this._frameDts.length >= 72) this._evaluateQuality();   // ~1.2s @ 60fps
      }
    }
    this._lastFrameT = t;
  }

  _evaluateQuality() {
    /* Median frame time → FPS (robust to the occasional GC / hitch spike). */
    const dts = this._frameDts.slice().sort((a, b) => a - b);
    const medDt = dts[dts.length >> 1] || 16.7;
    const fps = 1000 / medDt;
    this._frameDts.length = 0;
    const TARGET_FPS = 45;
    if (fps >= TARGET_FPS || this._qualityLevel >= this._MAX_QUALITY_LEVEL) {
      this._adaptActive = false;              // smooth enough, or at the floor — stop
      return;
    }
    this._applyQualityLevel(++this._qualityLevel);
    this._warmupFrames = 0;                   // let the change settle, then re-measure
  }

  /* Downgrade ladder — biggest, cheapest wins first. */
  _applyQualityLevel(level) {
    if (level >= 1) this.renderScale = 0.8;                                 // ~64% the pixels
    if (level >= 2) this.starDrawCount = Math.floor(this.starCount * 0.35); // thin the starfield
    if (level >= 3) this.renderScale = 0.6;                                 // ~36% the pixels
    this.resize();                            // apply the new internal resolution now
  }
}

function bindAttrib(gl, loc, buf, size) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(loc);
}

/* ---------- Tiny matrix library (column-major, Float32) ---------- */
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye, center, up) {
  const fx = eye[0] - center[0], fy = eye[1] - center[1], fz = eye[2] - center[2];
  const fl = Math.hypot(fx, fy, fz);
  const nfx = fx / fl, nfy = fy / fl, nfz = fz / fl;
  let sx = up[1] * nfz - up[2] * nfy;
  let sy = up[2] * nfx - up[0] * nfz;
  let sz = up[0] * nfy - up[1] * nfx;
  const sl = Math.hypot(sx, sy, sz);
  sx /= sl; sy /= sl; sz /= sl;
  const ux = nfy * sz - nfz * sy;
  const uy = nfz * sx - nfx * sz;
  const uz = nfx * sy - nfy * sx;
  return new Float32Array([
    sx, ux, nfx, 0,
    sy, uy, nfy, 0,
    sz, uz, nfz, 0,
    -(sx*eye[0] + sy*eye[1] + sz*eye[2]),
    -(ux*eye[0] + uy*eye[1] + uz*eye[2]),
    -(nfx*eye[0] + nfy*eye[1] + nfz*eye[2]),
    1,
  ]);
}

function rotY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1,
  ]);
}
function rotX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([
    1, 0, 0, 0,
    0, c, s, 0,
    0, -s, c, 0,
    0, 0, 0, 1,
  ]);
}
function multiply(a, b) {
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += a[k * 4 + j] * b[i * 4 + k];
    r[i * 4 + j] = v;
  }
  return r;
}
function mat3FromMat4(m) {
  return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
}

window.Globe = Globe;
})();
