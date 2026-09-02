import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  R_UNITS, R_VENUS_M, UNIT_M, RAMP_MIN, RAMP_MAX,
  loadMeta, loadGlobalField, loadRegionField,
  makeTerrainMaterial, makeRampTexture, rampColorAt, texelSizeM,
  loadSarTexture, setSarTexture, makeSpherePatchGeometry,
} from './terrain.js';
import { loadNames, makeLabelRenderer, GlobeLabels, RegionLabels, lonLatToDir, TYPE_FR } from './labels.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const MOBILE = window.matchMedia('(max-width: 800px), (pointer: coarse) and (max-width: 1100px)').matches;

// ---------------------------------------------------------------------------
// Scène
// ---------------------------------------------------------------------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
const labelRenderer = makeLabelRenderer();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080c);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 200);

/** Distance « vue d'ensemble » : plus loin en portrait pour que le globe tienne en largeur. */
function homeDistance() {
  return 18 * Math.max(1, 0.85 / camera.aspect);
}
/** Position de caméra face à une longitude donnée (convention uv de SphereGeometry). */
function cameraPosForLon(lonDeg, dist = homeDistance(), height = 4) {
  const a = ((lonDeg + 180) / 360) * Math.PI * 2;
  return new THREE.Vector3(-Math.cos(a) * dist, height, Math.sin(a) * dist);
}
const HOME_LON = 100; // Aphrodite Terra, cœur de la couverture VOLT
camera.position.copy(cameraPosForLon(HOME_LON));

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = R_UNITS + 0.3;
controls.maxDistance = 60;

const rampTexture = makeRampTexture();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const state = {
  meta: null,
  mode: 'globe',          // 'globe' | 'region'
  globe: null,            // { mesh, field, material }
  region: null,           // { mesh, field, material }
  regionCenter: null,     // { lon, lat } du dernier clic
  savedCam: {},           // caméra mémorisée par mode { position, target }
  names: [],              // nomenclature IAU
  globeLabels: null,
  regionLabels: null,
  showNames: true,
  lod: { patch: null, loading: false, lastCheck: 0 }, // patch haute résolution du globe
  exag: 25,
  colorMode: 0,
  sunAz: 315,
  sunEl: 35,
  hovered: null,
  loadingRegion: false,
};

const ui = {
  status: $('status'),
  hint: $('hint'),
  btnGlobe: $('btn-globe'),
  btnRegion: $('btn-region'),
  btnClose: $('btn-close'),
  regionZoom: $('region-zoom'),
  regionSize: $('region-size'),
  regionInfo: $('region-info'),
  roLat: $('ro-lat'),
  roLon: $('ro-lon'),
  roAlt: $('ro-alt'),
  lodInfo: $('lod-info'),
};

/** Tiroir des réglages sur mobile (le panneau est toujours visible sur grand écran). */
function setPanelOpen(open) {
  document.body.classList.toggle('panel-open', open);
  const btn = $('btn-panel');
  btn.textContent = open ? '✕' : '☰';
  btn.setAttribute('aria-expanded', String(open));
}

function setStatus(text, isError = false) {
  ui.status.hidden = !text;
  ui.status.textContent = text ?? '';
  ui.status.classList.toggle('error', isError);
}

function materials() {
  return [state.globe?.material, state.region?.material, state.lod.patch?.material].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Légende
// ---------------------------------------------------------------------------
function drawLegend() {
  const c = $('legend-ramp');
  const ctx = c.getContext('2d');
  for (let x = 0; x < c.width; x++) {
    const h = RAMP_MIN + (x / (c.width - 1)) * (RAMP_MAX - RAMP_MIN);
    ctx.fillStyle = rampColorAt(h).getStyle();
    ctx.fillRect(x, 0, 1, c.height);
  }
  $('legend-min').textContent = `${RAMP_MIN} m`;
  $('legend-max').textContent = `+${RAMP_MAX} m`;
}

// ---------------------------------------------------------------------------
// Globe
// ---------------------------------------------------------------------------
async function buildGlobe(meta) {
  const globals = meta.globals ?? {};
  const zooms = Object.keys(globals).map(Number).sort((a, b) => b - a);
  if (!zooms.length) throw new Error('aucune image globale dans meta.json (option --globals de build_tiles.py)');
  const url = globals[String(zooms[0])];

  setStatus(`Chargement de la carte globale (${url})…`);
  const field = await loadGlobalField(url);
  const tex = field.getTexture(renderer, THREE.RepeatWrapping);

  const material = makeTerrainMaterial({
    heightTexture: tex,
    texSize: [field.width, field.height],
    pxM: texelSizeM(field, 0),
    mode: 1,
    hmin: meta.elevMin,
    hmax: meta.elevMax,
    rampTexture,
  });
  const segments = Math.min(MOBILE ? 512 : 1024, field.width / 2);
  const geometry = new THREE.SphereGeometry(R_UNITS, segments, segments / 2);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  state.globe = { mesh, field, material };
  state.globeLabels = new GlobeLabels(state.names);
  scene.add(state.globeLabels.group);
  setStatus(null);

  // Mosaïque radar globale (USGS WMS), chargée en arrière-plan.
  loadSarTexture({ lonWest: -180, latSouth: -90, lonEast: 180, latNorth: 90, width: 4096, height: 2048 })
    .then((tex) => { tex.wrapS = THREE.RepeatWrapping; setSarTexture(material, tex); })
    .catch((err) => console.warn('mosaïque radar globale indisponible', err));
}

// ---------------------------------------------------------------------------
// Niveau de détail du globe : un morceau de sphère haute résolution centré sur la
// zone regardée, rechargé quand on se déplace ou que l'altitude change.
// ---------------------------------------------------------------------------
const M_PER_DEG = R_VENUS_M * DEG;
const TAN_HALF_FOV = Math.tan((camera.fov / 2) * DEG);
const M_PER_PX_Z0 = (180 * M_PER_DEG) / 256; // taille d'un texel au zoom 0
const LOD_MIN_ZOOM = 5;
const LOD_MAX_TILES = MOBILE ? 6 : 8;
const screenCenter = new THREE.Vector2(0, 0);

/** Zoom, nombre de tuiles et centre souhaités pour la vue courante (null : carte globale suffisante). */
function lodTarget() {
  const alt = camera.position.length() - R_UNITS;
  const viewM = 2 * alt * TAN_HALF_FOV * UNIT_M;        // hauteur du champ de vue au sol (m)
  const groundPxM = viewM / window.innerHeight;
  let zoom = Math.ceil(Math.log2(M_PER_PX_Z0 / groundPxM)); // texel ≈ pixel écran
  if (zoom < LOD_MIN_ZOOM) return null;
  zoom = Math.min(zoom, state.meta.maxZoom);

  const viewDeg = (viewM / M_PER_DEG) * Math.max(1, camera.aspect) * 1.4;
  let n = Math.ceil(viewDeg / (180 / (1 << zoom)));
  while (n > LOD_MAX_TILES && zoom > LOD_MIN_ZOOM) {
    zoom--;
    n = Math.ceil(viewDeg / (180 / (1 << zoom)));
  }
  n = Math.max(2, Math.min(LOD_MAX_TILES, n));

  // Centre : point du globe au centre de l'écran, sinon point sous la caméra.
  raycaster.setFromCamera(screenCenter, camera);
  const hit = raycaster.intersectObject(state.globe.mesh, false)[0];
  let lon, lat;
  if (hit?.uv) {
    ({ lon, lat } = state.globe.field.uvToLonLat(hit.uv.x, hit.uv.y));
  } else {
    const d = camera.position.clone().normalize();
    lat = Math.asin(d.y) / DEG;
    lon = Math.atan2(d.z, -d.x) / DEG - 180;
    if (lon < -180) lon += 360;
  }
  return { zoom, n, lon, lat };
}

/** Le point (lon, lat) est-il dans le patch, à `margin` (fraction) des bords ? */
function patchContains(patch, lon, lat, margin) {
  const f = patch.field;
  const w = f.lonEast - f.lonWest;
  const h = f.latNorth - f.latSouth;
  if (lon < f.lonWest) lon += 360;
  return lon > f.lonWest + w * margin && lon < f.lonEast - w * margin
    && lat > f.latSouth + h * margin && lat < f.latNorth - h * margin;
}

function removePatch() {
  const p = state.lod.patch;
  if (!p) return;
  scene.remove(p.mesh);
  p.mesh.geometry.dispose();
  setSarTexture(p.material, null);
  p.material.dispose();
  p.field.dispose();
  state.lod.patch = null;
  state.globe.material.uniforms.uHoleOn.value = 0;
  ui.lodInfo.textContent = '';
}

async function updateLod(now) {
  const lod = state.lod;
  if (state.mode !== 'globe' || !state.globe || lod.loading || now - lod.lastCheck < 300) return;
  lod.lastCheck = now;
  const t = lodTarget();
  if (!t) {
    if (lod.patch) removePatch();
    return;
  }
  const cur = lod.patch;
  if (cur && cur.zoom === t.zoom && t.n <= cur.n && patchContains(cur, t.lon, t.lat, 0.2)) return;

  lod.loading = true;
  ui.lodInfo.textContent = `Détail : chargement zoom ${t.zoom}…`;
  try {
    const field = await loadRegionField({ zoom: t.zoom, lon: t.lon, lat: t.lat, nTiles: t.n });
    const material = makeTerrainMaterial({
      heightTexture: field.getTexture(renderer),
      texSize: [field.width, field.height],
      pxM: texelSizeM(field, 0),
      mode: 1,
      hmin: state.meta.elevMin,
      hmax: state.meta.elevMax,
      rampTexture,
    });
    const mesh = new THREE.Mesh(makeSpherePatchGeometry(field, Math.min(MOBILE ? 384 : 768, field.width / 2)), material);
    removePatch();
    scene.add(mesh);
    const patch = { mesh, field, material, zoom: t.zoom, n: t.n };
    lod.patch = patch;
    applyUniforms();

    const g = state.globe.material.uniforms;
    g.uHole.value.set(field.lonWest, field.latSouth, field.lonEast, field.latNorth);
    g.uHoleOn.value = 1;

    const mPerPx = texelSizeM(field, 0)[1];
    ui.lodInfo.textContent = `Détail : zoom ${t.zoom} · ${t.n}×${t.n} tuiles · ${mPerPx.toFixed(0)} m/px`;

    if (field.lonEast <= 180) {
      loadSarTexture({
        lonWest: field.lonWest, latSouth: field.latSouth, lonEast: field.lonEast, latNorth: field.latNorth,
        width: field.width, height: field.height,
      })
        .then((tex) => { if (lod.patch === patch) setSarTexture(material, tex); else tex.dispose(); })
        .catch(() => {});
    }
  } catch (err) {
    console.warn('patch LOD indisponible', err);
  } finally {
    lod.loading = false;
  }
}

// ---------------------------------------------------------------------------
// Région
// ---------------------------------------------------------------------------
function disposeRegion() {
  if (!state.region) return;
  scene.remove(state.region.mesh);
  state.region.mesh.geometry.dispose();
  setSarTexture(state.region.material, null);
  state.region.material.dispose();
  state.region.field.dispose();
  state.region = null;
  if (state.regionLabels) {
    scene.remove(state.regionLabels.group);
    state.regionLabels.dispose();
    state.regionLabels = null;
  }
}

async function loadRegionAt(lon, lat) {
  if (state.loadingRegion) return;
  const zoom = Number(ui.regionZoom.value);
  const nTiles = Number(ui.regionSize.value);
  state.loadingRegion = true;
  state.regionCenter = { lon, lat };
  try {
    const field = await loadRegionField({
      zoom, lon, lat, nTiles,
      onProgress: (done, total) => setStatus(`Chargement de la région… ${done}/${total} tuiles`),
    });
    disposeRegion();

    const pxM = texelSizeM(field, field.latCenter);
    const widthU = (field.width * pxM[0]) / UNIT_M;
    const heightU = (field.height * pxM[1]) / UNIT_M;
    const seg = Math.min(MOBILE ? 384 : 768, field.width);
    const geometry = new THREE.PlaneGeometry(widthU, heightU, seg, seg);
    const material = makeTerrainMaterial({
      heightTexture: field.getTexture(renderer),
      texSize: [field.width, field.height],
      pxM,
      mode: 0,
      hmin: state.meta.elevMin,
      hmax: state.meta.elevMax,
      rampTexture,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2; // plan XZ, +y vers le haut, nord vers -z
    scene.add(mesh);
    const region = { mesh, field, material };
    state.region = region;
    state.regionLabels = new RegionLabels(state.names, field, mesh);
    scene.add(state.regionLabels.group);

    // Image radar de la même emprise (sauf si elle chevauche l'antiméridien).
    if (field.lonEast <= 180) {
      loadSarTexture({
        lonWest: field.lonWest, latSouth: field.latSouth, lonEast: field.lonEast, latNorth: field.latNorth,
        width: field.width, height: field.height,
      })
        .then((tex) => { if (state.region === region) setSarTexture(material, tex); else tex.dispose(); })
        .catch((err) => console.warn('image radar indisponible', err));
    }

    const kmW = (field.width * pxM[0]) / 1000;
    ui.regionInfo.textContent =
      `Zoom ${zoom} · ${field.width}×${field.height} px · ${(pxM[1]).toFixed(0)} m/px · ` +
      `~${kmW.toFixed(0)} km de côté · lat ${field.latSouth.toFixed(1)}° à ${field.latNorth.toFixed(1)}°, ` +
      `lon ${field.lonWest.toFixed(1)}° à ${field.lonEast.toFixed(1)}°`;
    ui.btnRegion.disabled = false;
    applyUniforms();
    delete state.savedCam.region;
    setMode('region', { newRegion: true });
    setStatus(null);
  } catch (err) {
    console.error(err);
    setStatus(`Erreur : ${err.message}`, true);
  } finally {
    state.loadingRegion = false;
  }
}

// ---------------------------------------------------------------------------
// Modes et caméra
// ---------------------------------------------------------------------------
/**
 * Bascule globe/région. La caméra de chaque mode est mémorisée pour reprendre
 * là où on était ; opts.newRegion recadre sur une région fraîchement chargée.
 */
function setMode(mode, opts = {}) {
  if (state.mode !== mode) {
    state.savedCam[state.mode] = { position: camera.position.clone(), target: controls.target.clone() };
  }
  state.mode = mode;
  ui.btnGlobe.classList.toggle('active', mode === 'globe');
  ui.btnRegion.classList.toggle('active', mode === 'region');
  if (state.globe) state.globe.mesh.visible = mode === 'globe';
  if (state.lod.patch) state.lod.patch.mesh.visible = mode === 'globe';
  if (state.region) state.region.mesh.visible = mode === 'region';
  ui.btnClose.hidden = mode !== 'region';

  const saved = opts.newRegion ? null : state.savedCam[mode];
  if (mode === 'globe') {
    controls.minDistance = R_UNITS + 0.08;
    controls.maxDistance = 60;
    ui.hint.textContent = 'Zoomez (molette) : le relief se précise automatiquement. Cliquez pour ouvrir une région à plat.';
    if (saved) {
      camera.position.copy(saved.position);
      controls.target.copy(saved.target);
    } else {
      controls.target.set(0, 0, 0);
      camera.position.copy(cameraPosForLon(HOME_LON));
    }
  } else {
    const w = state.region?.mesh.geometry.parameters.width ?? 1;
    controls.minDistance = w * 0.02;
    controls.maxDistance = w * 6;
    ui.hint.textContent = 'Faites tourner la région (glisser), zoomez (molette). Échap ou × pour revenir au globe.';
    if (saved) {
      camera.position.copy(saved.position);
      controls.target.copy(saved.target);
    } else {
      controls.target.set(0, 0, 0);
      camera.position.set(0, w * 0.9, w * 1.1);
    }
  }
  camera.near = mode === 'globe' ? 0.01 : 0.0005;
  camera.updateProjectionMatrix();
  controls.update();
}

// ---------------------------------------------------------------------------
// Uniformes / UI
// ---------------------------------------------------------------------------
const sunWorld = new THREE.Vector3();
const sunView = new THREE.Vector3();

function applyUniforms() {
  for (const m of materials()) {
    m.uniforms.uExag.value = state.exag;
    m.uniforms.uColorMode.value = state.colorMode;
  }
}

function updateSun() {
  // Azimut mesuré depuis le nord vers l'est, hauteur au-dessus de l'horizon.
  // Repère monde : nord = +y (globe) ; on prend une direction fixe par rapport à la caméra
  // pour que l'ombrage reste lisible quelle que soit l'orientation.
  const az = state.sunAz * DEG;
  const el = state.sunEl * DEG;
  sunWorld.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  // Direction exprimée dans le repère caméra (x droite, y haut, z vers l'observateur).
  sunView.set(sunWorld.x, sunWorld.y, sunWorld.z);
  for (const m of materials()) m.uniforms.uSunView.value.copy(sunView);
}

function bindUI() {
  const exag = $('exag');
  exag.addEventListener('input', () => {
    state.exag = Number(exag.value);
    $('exag-out').textContent = `${state.exag}×`;
    applyUniforms();
  });
  $('color-mode').addEventListener('change', (e) => {
    state.colorMode = Number(e.target.value);
    applyUniforms();
  });
  const sunAz = $('sun-az');
  sunAz.addEventListener('input', () => {
    state.sunAz = Number(sunAz.value);
    $('sun-az-out').textContent = `${state.sunAz}°`;
  });
  const sunEl = $('sun-el');
  sunEl.addEventListener('input', () => {
    state.sunEl = Number(sunEl.value);
    $('sun-el-out').textContent = `${state.sunEl}°`;
  });
  // Noms et recherche
  $('show-names').addEventListener('change', (e) => { state.showNames = e.target.checked; });
  const datalist = $('names-list');
  for (const f of state.names) {
    const opt = document.createElement('option');
    opt.value = f.name;
    opt.label = `${TYPE_FR[f.type] ?? f.type}${f.km ? ` · ${f.km} km` : ''}`;
    datalist.appendChild(opt);
  }
  const search = $('search');
  const runSearch = (exactOnly) => {
    const q = search.value.trim().toLowerCase();
    if (!q) return;
    const f = state.names.find((n) => n.name.toLowerCase() === q)
      ?? (exactOnly ? null : state.names.find((n) => n.name.toLowerCase().startsWith(q)));
    if (!f) return;
    search.value = f.name;
    search.blur();
    flyTo(f);
  };
  // Sélection dans la liste (input), validation par Entrée (keydown) ou perte de focus (change).
  search.addEventListener('input', () => runSearch(true));
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(false); } });
  search.addEventListener('change', () => runSearch(false));

  const closeRegion = () => { if (state.mode === 'region') setMode('globe'); };
  ui.btnGlobe.addEventListener('click', () => setMode('globe'));
  ui.btnClose.addEventListener('click', closeRegion);
  $('btn-panel').addEventListener('click', () => setPanelOpen(!document.body.classList.contains('panel-open')));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeRegion();
  });
  ui.btnRegion.addEventListener('click', () => {
    if (state.region) setMode('region');
  });

  // Zooms disponibles pour les régions
  const zooms = (state.meta.zooms ?? []).filter((z) => z >= 3);
  for (const z of zooms) {
    const opt = document.createElement('option');
    const mPerPx = (180 / (1 << z) / 256) * DEG * 6051000;
    opt.value = z;
    opt.textContent = `${z} — ${mPerPx.toFixed(0)} m/px`;
    ui.regionZoom.appendChild(opt);
  }
  ui.regionZoom.value = String(zooms[zooms.length - 1] ?? '');

  // Changer le zoom ou la taille recharge la région courante au même endroit.
  const reloadRegion = () => {
    if (state.regionCenter) loadRegionAt(state.regionCenter.lon, state.regionCenter.lat);
  };
  ui.regionZoom.addEventListener('change', reloadRegion);
  ui.regionSize.addEventListener('change', reloadRegion);

  // Survol et clic
  let downPos = null;
  canvas.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; setPanelOpen(false); });
  canvas.addEventListener('pointerup', (e) => {
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
    downPos = null;
    if (moved > 4 || state.mode !== 'globe' || !state.hovered) return;
    loadRegionAt(state.hovered.lon, state.hovered.lat);
  });
  canvas.addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  });
  canvas.addEventListener('pointerleave', () => { state.hovered = null; updateReadout(); });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
  });
}

/** Oriente le globe vers une entité nommée (distance adaptée à sa taille). */
function flyTo(f) {
  if (state.mode !== 'globe') setMode('globe');
  const dist = Math.max(R_UNITS + 0.4, Math.min(homeDistance(), R_UNITS + (f.km || 500) / 400));
  camera.position.copy(lonLatToDir(f.lon, f.lat)).multiplyScalar(dist);
  controls.target.set(0, 0, 0);
  controls.update();
  state.hovered = { lon: f.lon, lat: f.lat, alt: state.globe?.field.sampleUV((f.lon + 180) / 360, (f.lat + 90) / 180) };
  updateReadout();
}

function fmtDeg(v, pos, neg) {
  return `${Math.abs(v).toFixed(2)}° ${v >= 0 ? pos : neg}`;
}

function updateReadout() {
  const h = state.hovered;
  ui.roLat.textContent = h ? fmtDeg(h.lat, 'N', 'S') : '—';
  ui.roLon.textContent = h ? fmtDeg(h.lon, 'E', 'O') : '—';
  ui.roAlt.textContent = h ? (h.alt == null ? 'sans donnée' : `${h.alt.toFixed(0)} m`) : '—';
}

function pick() {
  // Sur le globe, le patch haute résolution a priorité sur la carte globale.
  const candidates = state.mode === 'globe'
    ? [state.lod.patch, state.globe]
    : [state.region];
  const targets = candidates.filter(Boolean);
  if (!targets.length) return;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(targets.map((t) => t.mesh), false)[0];
  const current = hit && targets.find((t) => t.mesh === hit.object);
  if (!hit?.uv || !current) {
    if (state.hovered) { state.hovered = null; updateReadout(); }
    return;
  }
  const { lon, lat } = current.field.uvToLonLat(hit.uv.x, hit.uv.y);
  const alt = current.field.sampleUV(hit.uv.x, hit.uv.y);
  state.hovered = { lon, lat, alt };
  updateReadout();
}

// ---------------------------------------------------------------------------
// Boucle
// ---------------------------------------------------------------------------
let frame = 0;
function animate(now = 0) {
  requestAnimationFrame(animate);
  if (state.mode === 'globe') {
    // Rotation plus lente quand on est près de la surface.
    controls.rotateSpeed = Math.max(0.03, Math.min(1, (camera.position.length() - R_UNITS) / 8));
  } else {
    controls.rotateSpeed = 1;
  }
  controls.update();
  updateSun();
  updateLod(now);
  if (frame++ % 3 === 0) {
    pick();
    state.globeLabels?.update(camera, state.showNames && state.mode === 'globe');
    state.regionLabels?.update(state.exag, state.showNames && state.mode === 'region');
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

async function init() {
  drawLegend();
  try {
    state.meta = await loadMeta();
    state.names = await loadNames().catch((err) => { console.warn(err); return []; });
    bindUI();
    await buildGlobe(state.meta);
    applyUniforms();
    setMode('globe');
    animate();
  } catch (err) {
    console.error(err);
    setStatus(`Impossible de démarrer : ${err.message}`, true);
  }
}

init();
