import * as THREE from 'three';

export const R_VENUS_M = 6051000;         // rayon de la sphère de référence (m)
export const UNIT_M = 1e6;                // 1 unité de scène = 1000 km
export const R_UNITS = R_VENUS_M / UNIT_M; // 6.051
export const NODATA = -32768;
export const TILE = 256;
export const NODATA_THRESHOLD = -20000;   // en dessous : pas de donnée

const DEG = Math.PI / 180;

export async function loadMeta() {
  const r = await fetch('meta.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('meta.json introuvable : lancez d’abord tools/build_tiles.py');
  return r.json();
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tuile absente : ${url}`));
    img.src = url;
  });
}

/** Décode un canvas Terrarium en Float32Array, ligne 0 = sud (convention uv.y = 0 en bas). */
function decodeCanvas(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = y * w;
    const dst = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) {
      const i = (src + x) * 4;
      out[dst + x] = data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
    }
  }
  return out;
}

/**
 * Champ de hauteurs : données float (ligne 0 = sud), emprise géographique et texture GPU.
 */
export class HeightField {
  constructor({ data, width, height, lonWest, latNorth, degPerPx }) {
    this.data = data;
    this.width = width;
    this.height = height;
    this.lonWest = lonWest;
    this.latNorth = latNorth;
    this.degPerPx = degPerPx;
    this.texture = null;
  }

  get latSouth() { return this.latNorth - this.height * this.degPerPx; }
  get lonEast() { return this.lonWest + this.width * this.degPerPx; }
  get latCenter() { return (this.latNorth + this.latSouth) / 2; }

  /** Altitude (m) au point uv, ou null si nodata. */
  sampleUV(u, v) {
    const x = Math.min(this.width - 1, Math.max(0, Math.floor(u * this.width)));
    const y = Math.min(this.height - 1, Math.max(0, Math.floor(v * this.height)));
    const h = this.data[y * this.width + x];
    return h > NODATA_THRESHOLD ? h : null;
  }

  /** Coordonnées géographiques d'un point uv. */
  uvToLonLat(u, v) {
    return {
      lon: this.lonWest + u * this.width * this.degPerPx,
      lat: this.latSouth + v * this.height * this.degPerPx,
    };
  }

  /** Crée (ou renvoie) la DataTexture flottante ; wrapS = Repeat pour un globe complet. */
  getTexture(renderer, wrapS = THREE.ClampToEdgeWrapping) {
    if (this.texture) return this.texture;
    const floatLinear = renderer.extensions.has('OES_texture_float_linear');
    let tex;
    if (floatLinear) {
      tex = new THREE.DataTexture(this.data, this.width, this.height, THREE.RedFormat, THREE.FloatType);
    } else {
      const half = new Uint16Array(this.data.length);
      for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(this.data[i]);
      tex = new THREE.DataTexture(half, this.width, this.height, THREE.RedFormat, THREE.HalfFloatType);
    }
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = wrapS;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.texture = tex;
    return tex;
  }

  dispose() {
    this.texture?.dispose();
    this.texture = null;
  }
}

/** Carte globale (image plein globe générée par build_tiles.py). */
export async function loadGlobalField(url) {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return new HeightField({
    data: decodeCanvas(ctx, img.width, img.height),
    width: img.width,
    height: img.height,
    lonWest: -180,
    latNorth: 90,
    degPerPx: 360 / img.width,
  });
}

/**
 * Charge un carré de n×n tuiles au zoom z centré sur (lon, lat).
 * Les tuiles absentes (404) restent noires = nodata.
 */
export async function loadRegionField({ zoom, lon, lat, nTiles, onProgress }) {
  const nx = 2 << zoom;
  const ny = 1 << zoom;
  const degPerTile = 180 / ny;
  const tx0 = Math.round((lon + 180) / degPerTile - nTiles / 2);
  let ty0 = Math.round((90 - lat) / degPerTile - nTiles / 2);
  ty0 = Math.max(0, Math.min(ny - nTiles, ty0));

  const size = nTiles * TILE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let done = 0;
  const total = nTiles * nTiles;
  const jobs = [];
  for (let j = 0; j < nTiles; j++) {
    for (let i = 0; i < nTiles; i++) {
      const tx = (((tx0 + i) % nx) + nx) % nx;
      const ty = ty0 + j;
      jobs.push(
        loadImage(`tiles/${zoom}/${tx}/${ty}.png`)
          .then((img) => ctx.drawImage(img, i * TILE, j * TILE))
          .catch(() => {})
          .finally(() => onProgress?.(++done, total)),
      );
    }
  }
  await Promise.all(jobs);

  return new HeightField({
    data: decodeCanvas(ctx, size, size),
    width: size,
    height: size,
    lonWest: -180 + tx0 * degPerTile,
    latNorth: 90 - ty0 * degPerTile,
    degPerPx: degPerTile / TILE,
  });
}

/** Rampe hypsométrique (style cartes Magellan) : arrêts en mètres. */
export const RAMP_STOPS = [
  [-3000, '#1b1550'],
  [-1500, '#2c3f9c'],
  [-500, '#2f7fc4'],
  [0, '#2f9c7c'],
  [700, '#8fbf5a'],
  [1600, '#e3c45f'],
  [2800, '#e07a45'],
  [4500, '#b23a3a'],
  [7000, '#d9c8c0'],
  [11000, '#ffffff'],
];
export const RAMP_MIN = RAMP_STOPS[0][0];
export const RAMP_MAX = RAMP_STOPS[RAMP_STOPS.length - 1][0];

/** Couleur sRGB (CSS) interpolée à l'altitude h. */
export function rampColorAt(h) {
  const t = Math.min(RAMP_MAX, Math.max(RAMP_MIN, h));
  for (let i = 1; i < RAMP_STOPS.length; i++) {
    const [h1, c1] = RAMP_STOPS[i];
    if (t <= h1) {
      const [h0, c0] = RAMP_STOPS[i - 1];
      const f = (t - h0) / (h1 - h0);
      const a = new THREE.Color(c0);
      const b = new THREE.Color(c1);
      return a.lerp(b, f); // lerp en espace linéaire ; utiliser getStyle() pour le CSS
    }
  }
  return new THREE.Color(RAMP_STOPS[RAMP_STOPS.length - 1][1]);
}

export function makeRampTexture() {
  const n = 256;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = rampColorAt(RAMP_MIN + (i / (n - 1)) * (RAMP_MAX - RAMP_MIN));
    data[i * 4] = Math.round(c.r * 255);
    data[i * 4 + 1] = Math.round(c.g * 255);
    data[i * 4 + 2] = Math.round(c.b * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const vertexShader = /* glsl */ `
uniform sampler2D uHeight;
uniform float uExag;
uniform float uUnitM;
uniform float uHmin;
uniform float uHmax;
uniform int uMode; // 0 = plan, 1 = globe

varying vec2 vUv;
varying float vH;
varying vec3 vEast;
varying vec3 vNorth;
varying vec3 vUp;

void main() {
  vUv = uv;
  float h = texture2D(uHeight, uv).r;
  vH = h;
  float d = h > -20000.0 ? clamp(h, uHmin, uHmax) * uExag / uUnitM : 0.0;
  vec3 p = position + normal * d;

  vec3 up = normalize(normal);
  vec3 east;
  if (uMode == 1) {
    float lon = uv.x * 6.28318530718;
    east = vec3(sin(lon), 0.0, cos(lon));
  } else {
    east = vec3(1.0, 0.0, 0.0);
  }
  vec3 north = cross(up, east);
  vEast = normalize(normalMatrix * east);
  vNorth = normalize(normalMatrix * north);
  vUp = normalize(normalMatrix * up);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uHeight;
uniform sampler2D uRamp;
uniform vec2 uTexSize;
uniform vec2 uPxM;        // taille d'un texel en m (x à l'équateur pour le globe, y)
uniform float uExag;
uniform vec3 uSunView;    // direction du soleil en espace vue
uniform int uMode;
uniform int uColorMode;   // 0 hypso+ombrage, 1 ombrage gris, 2 hypso seule, 3 image radar + ombrage
uniform float uRampMin;
uniform float uRampMax;
uniform sampler2D uSar;   // mosaïque radar Magellan (USGS), même emprise que uHeight
uniform int uHasSar;

varying vec2 vUv;
varying float vH;
varying vec3 vEast;
varying vec3 vNorth;
varying vec3 vUp;

void main() {
  vec2 du = vec2(1.0 / uTexSize.x, 0.0);
  vec2 dv = vec2(0.0, 1.0 / uTexSize.y);
  float hl = texture2D(uHeight, vUv - du).r;
  float hr = texture2D(uHeight, vUv + du).r;
  float hd = texture2D(uHeight, vUv - dv).r;
  float hu = texture2D(uHeight, vUv + dv).r;
  bool useSar = uColorMode == 3 && uHasSar == 1;

  if (vH < -20000.0) {
    // Hors couverture VOLT : image radar à plat si disponible, sinon gris.
    vec3 c = useSar ? texture2D(uSar, vUv).rgb * 0.75 : vec3(0.10, 0.10, 0.12);
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
    return;
  }
  // Évite les pentes artificielles au contact des zones sans donnée.
  float hc = vH;
  if (hl < -20000.0) hl = hc;
  if (hr < -20000.0) hr = hc;
  if (hd < -20000.0) hd = hc;
  if (hu < -20000.0) hu = hc;

  float pxX = uPxM.x;
  if (uMode == 1) {
    float lat = (vUv.y - 0.5) * 3.14159265359;
    pxX *= max(cos(lat), 0.02);
  }
  float dhdx = (hr - hl) / (2.0 * pxX);
  float dhdy = (hu - hd) / (2.0 * uPxM.y);
  vec3 nt = normalize(vec3(-dhdx * uExag, -dhdy * uExag, 1.0));
  vec3 n = normalize(vEast * nt.x + vNorth * nt.y + vUp * nt.z);

  float diffuse = max(dot(n, normalize(uSunView)), 0.0);
  float shade = 0.22 + 0.85 * diffuse;

  vec3 base;
  if (useSar) {
    base = texture2D(uSar, vUv).rgb;
    shade = 0.45 + 0.7 * diffuse;
  } else if (uColorMode == 1) {
    base = vec3(0.86, 0.85, 0.82);
  } else {
    float t = clamp((vH - uRampMin) / (uRampMax - uRampMin), 0.0, 1.0);
    base = texture2D(uRamp, vec2(t, 0.5)).rgb;
  }
  if (uColorMode == 2) shade = 0.95;

  gl_FragColor = vec4(base * shade, 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * Matériau de terrain partagé (globe ou plan).
 * @param {object} o
 * @param {THREE.Texture} o.heightTexture
 * @param {[number, number]} o.texSize
 * @param {[number, number]} o.pxM   taille texel en mètres [x, y]
 * @param {0|1} o.mode
 */
export function makeTerrainMaterial({ heightTexture, texSize, pxM, mode, hmin, hmax, rampTexture }) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uHeight: { value: heightTexture },
      uRamp: { value: rampTexture },
      uTexSize: { value: new THREE.Vector2(texSize[0], texSize[1]) },
      uPxM: { value: new THREE.Vector2(pxM[0], pxM[1]) },
      uExag: { value: 25 },
      uUnitM: { value: UNIT_M },
      uHmin: { value: hmin },
      uHmax: { value: hmax },
      uSunView: { value: new THREE.Vector3(0, 0, 1) },
      uMode: { value: mode },
      uColorMode: { value: 0 },
      uRampMin: { value: RAMP_MIN },
      uRampMax: { value: RAMP_MAX },
      uSar: { value: null },
      uHasSar: { value: 0 },
    },
  });
}

/** Attache (ou retire) une texture radar au matériau. */
export function setSarTexture(material, texture) {
  material.uniforms.uSar.value?.dispose();
  material.uniforms.uSar.value = texture;
  material.uniforms.uHasSar.value = texture ? 1 : 0;
}

const USGS_WMS = 'https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/venus/venus_simp_cyl.map';

/**
 * Charge la mosaïque radar Magellan (gauche, cycle 1) de l'USGS pour une emprise donnée.
 * WMS 1.3.0 / EPSG:4326 : bbox = latS,lonW,latN,lonE ; 4096 px maximum par côté.
 */
export async function loadSarTexture({ lonWest, latSouth, lonEast, latNorth, width, height }) {
  const w = Math.min(4096, Math.round(width));
  const h = Math.min(4096, Math.round(height));
  const params = new URLSearchParams({
    service: 'WMS', version: '1.3.0', request: 'GetMap', layers: 'MAGELLAN', styles: '',
    crs: 'EPSG:4326', bbox: `${latSouth},${lonWest},${latNorth},${lonEast}`,
    width: String(w), height: String(h), format: 'image/jpeg',
  });
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const tex = await loader.loadAsync(`${USGS_WMS}&${params}`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  return tex;
}

/** Taille d'un texel en mètres pour un champ donné (x à la latitude fournie). */
export function texelSizeM(field, lat = 0) {
  const m = field.degPerPx * DEG * R_VENUS_M;
  return [m * Math.cos(lat * DEG), m];
}
