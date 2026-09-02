import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  R_UNITS, UNIT_M, RAMP_MIN, RAMP_MAX,
  loadMeta, loadGlobalField, loadRegionField,
  makeTerrainMaterial, makeRampTexture, rampColorAt, texelSizeM,
  loadSarTexture, setSarTexture,
} from './terrain.js';
import { loadNames, makeLabelRenderer, GlobeLabels, RegionLabels, lonLatToDir, TYPE_FR } from './labels.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

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

/** Position de caméra face à une longitude donnée (convention uv de SphereGeometry). */
function cameraPosForLon(lonDeg, dist = 18, height = 4) {
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
};

function setStatus(text, isError = false) {
  ui.status.hidden = !text;
  ui.status.textContent = text ?? '';
  ui.status.classList.toggle('error', isError);
}

function materials() {
  return [state.globe?.material, state.region?.material].filter(Boolean);
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
  const segments = Math.min(1024, field.width / 2);
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
    const seg = Math.min(768, field.width);
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
  if (state.region) state.region.mesh.visible = mode === 'region';
  ui.btnClose.hidden = mode !== 'region';

  const saved = opts.newRegion ? null : state.savedCam[mode];
  if (mode === 'globe') {
    controls.minDistance = R_UNITS + 0.3;
    controls.maxDistance = 60;
    ui.hint.textContent = 'Cliquez sur le globe pour charger une région en haute résolution.';
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
  canvas.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
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
  const dist = Math.max(R_UNITS + 0.4, Math.min(18, R_UNITS + (f.km || 500) / 400));
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
  const current = state.mode === 'globe' ? state.globe : state.region;
  if (!current) return;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(current.mesh, false)[0];
  if (!hit?.uv) {
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
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateSun();
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
