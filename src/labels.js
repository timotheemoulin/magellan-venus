import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { R_UNITS, UNIT_M } from './terrain.js';

const DEG = Math.PI / 180;

/** Types affichés sur le globe, avec seuil de diamètre (km) selon la distance caméra. */
const GLOBE_TYPES = new Set(['Terra', 'Regio', 'Planitia', 'Planum', 'Mons', 'Chasma', 'Tessera',
  'Corona', 'Dorsum', 'Fossa', 'Vallis', 'Rupes', 'Fluctus', 'Labyrinthus', 'Crater', 'Patera']);
const MAJOR_TYPES = new Set(['Terra', 'Regio', 'Planitia']);

/** Libellés français des types IAU (au singulier). */
export const TYPE_FR = {
  Terra: 'terre (haut plateau)', Regio: 'région', Planitia: 'plaine', Planum: 'plateau',
  Mons: 'mont', Chasma: 'canyon', Tessera: 'tessera (terrain tuilé)', Corona: 'couronne',
  Dorsum: 'dorsale', Fossa: 'fossé', Vallis: 'vallée', Rupes: 'escarpement', Fluctus: 'coulée',
  Labyrinthus: 'labyrinthe', Crater: 'cratère', Patera: 'patera (caldeira)', Tholus: 'dôme',
  Farrum: 'farrum (dôme en galette)', Linea: 'linéament', Unda: 'dunes', Collis: 'collines',
  Astrum: 'astrum (structure radiale)',
};

export async function loadNames() {
  const r = await fetch('names.json');
  if (!r.ok) throw new Error('names.json introuvable : lancez tools/build_names.py');
  return (await r.json()).features;
}

export function makeLabelRenderer() {
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  Object.assign(labelRenderer.domElement.style, {
    position: 'fixed', top: '0', left: '0', pointerEvents: 'none', zIndex: '1',
  });
  document.body.appendChild(labelRenderer.domElement);
  return labelRenderer;
}

function makeLabelElement(f) {
  const el = document.createElement('div');
  el.className = `label type-${f.type.toLowerCase()}${MAJOR_TYPES.has(f.type) ? ' major' : ''}`;
  el.textContent = f.name;
  el.title = `${TYPE_FR[f.type] ?? f.type} · ${f.km ? `${f.km} km · ` : ''}${f.origin}`;
  return el;
}

/** Poids d'importance par type : les grandes provinces d'abord, les détails ensuite. */
const TYPE_WEIGHT = {
  Terra: 3, Regio: 2.2, Planitia: 1.6, Mons: 2, Planum: 1.5, Chasma: 0.8, Tessera: 0.6,
  Corona: 0.6, Dorsum: 0.35, Fossa: 0.3, Vallis: 0.5, Rupes: 0.4, Fluctus: 0.3,
  Labyrinthus: 0.5, Crater: 0.9, Patera: 0.4,
};

const _v = new THREE.Vector3();

/**
 * Étiquettes du globe : placées sur la sphère, masquées sur la face cachée,
 * les plus importantes d'abord, avec un dégroupage à l'écran.
 */
export class GlobeLabels {
  constructor(features) {
    this.group = new THREE.Group();
    this.items = [];
    for (const f of features) {
      if (!GLOBE_TYPES.has(f.type) || f.km < 100) continue;
      const obj = new CSS2DObject(makeLabelElement(f));
      const dir = lonLatToDir(f.lon, f.lat);
      obj.position.copy(dir).multiplyScalar(R_UNITS * 1.03);
      obj.visible = false;
      this.group.add(obj);
      this.items.push({ f, obj, dir, score: f.km * (TYPE_WEIGHT[f.type] ?? 0.5) });
    }
    this.items.sort((a, b) => b.score - a.score);
  }

  update(camera, enabled) {
    if (!enabled) {
      for (const it of this.items) it.obj.visible = false;
      return;
    }
    const camDir = camera.position.clone().normalize();
    const dist = camera.position.length() - R_UNITS;
    // Plus on s'approche, plus on affiche d'entités, et de plus petites.
    const maxShown = dist > 8 ? 28 : dist > 4 ? 45 : dist > 2 ? 65 : 90;
    const minScore = dist > 8 ? 1500 : dist > 4 ? 700 : dist > 2 ? 300 : 100;
    const minGapPx = dist > 4 ? 70 : 48;
    const halfW = window.innerWidth / 2;
    const halfH = window.innerHeight / 2;
    const placed = [];
    for (const it of this.items) {
      let ok = placed.length < maxShown && it.score >= minScore && it.dir.dot(camDir) > 0.2;
      if (ok) {
        _v.copy(it.obj.position).project(camera);
        const sx = _v.x * halfW;
        const sy = _v.y * halfH;
        ok = placed.every((p) => Math.abs(p[0] - sx) > minGapPx || Math.abs(p[1] - sy) > 16);
        if (ok) placed.push([sx, sy]);
      }
      it.obj.visible = ok;
    }
  }
}

/**
 * Étiquettes d'une région : entités dont le centre tombe dans l'emprise,
 * posées sur le relief (hauteur mise à jour avec l'exagération).
 */
export class RegionLabels {
  constructor(features, field, mesh) {
    this.group = new THREE.Group();
    this.items = [];
    const { width, height } = mesh.geometry.parameters;
    for (const f of features) {
      if (f.lon < field.lonWest || f.lon > field.lonEast || f.lat < field.latSouth || f.lat > field.latNorth) continue;
      const u = (f.lon - field.lonWest) / (field.lonEast - field.lonWest);
      const v = (f.lat - field.latSouth) / (field.latNorth - field.latSouth);
      const h = field.sampleUV(u, v) ?? 0;
      const obj = new CSS2DObject(makeLabelElement(f));
      // Le plan est tourné de -90° autour de X : (x, y, z)_plan -> (x, z, -y)_monde.
      this.items.push({ obj, x: (u - 0.5) * width, z: -(v - 0.5) * height, h });
      this.group.add(obj);
    }
  }

  update(exag, enabled) {
    for (const it of this.items) {
      it.obj.visible = enabled;
      it.obj.position.set(it.x, (it.h * exag) / UNIT_M, it.z);
    }
  }

  dispose() {
    for (const it of this.items) it.obj.element.remove();
    this.group.clear();
  }
}

/** Vecteur unitaire vers (lon, lat) dans la convention uv de SphereGeometry. */
export function lonLatToDir(lonDeg, latDeg) {
  const lon = ((lonDeg + 180) / 360) * Math.PI * 2;
  const lat = latDeg * DEG;
  return new THREE.Vector3(-Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat));
}
