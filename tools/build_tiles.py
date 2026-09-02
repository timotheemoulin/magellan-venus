#!/usr/bin/env python3
"""
Génère une pyramide de tuiles d'altitude (PNG encodées « Terrarium ») et des cartes de
hauteur globales à partir de VOLT_DEM_300m.tif (Venus Opposite-Look Topography,
https://doi.org/10.5281/zenodo.22164484, CC BY 4.0, A. Trussell 2026).

Schéma de tuiles : plate carrée plein globe (lon -180..180, lat 90..-90).
  zoom z -> 2^(z+1) colonnes x 2^z lignes de tuiles de 256 px.
  tuile (z, x, y) : lon_ouest = -180 + x * 180/2^z ; lat_nord = 90 - y * 180/2^z.
  zoom 8 ~ résolution native (352 px/deg source vs 364 px/deg tuiles).

Encodage Terrarium : h = (R*256 + G + B/256) - 32768 mètres.
  Nodata -> RGB(0,0,0), soit h = -32768 (le client traite h < -20000 comme nodata).
  Les tuiles entièrement vides ne sont pas écrites (404 côté client = nodata).

Sorties (dans --out, public/ par défaut) :
  tiles/{z}/{x}/{y}.png
  global_{largeur}.png   (une image plein globe par zoom listé dans --globals)
  meta.json              (schéma, zooms disponibles, min/max d'altitude, crédits)

Exemples :
  python tools/build_tiles.py data/VOLT_DEM_300m.tif --zooms 0-7
  python tools/build_tiles.py "/vsicurl/https://zenodo.org/records/22164484/files/VOLT_DEM_300m.tif?download=1" --zooms 0-1 --globals 1
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

# À définir avant l'import de rasterio (lecture distante efficace, gros cache de blocs).
os.environ.setdefault("GDAL_CACHEMAX", "2048")
os.environ.setdefault("CPL_VSIL_CURL_CHUNK_SIZE", str(10 * 1024 * 1024))
os.environ.setdefault("CPL_VSIL_CURL_CACHE_SIZE", str(512 * 1024 * 1024))
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import Window

TILE = 256
NODATA = -32768
PPD = 352           # pixels par degré dans la source (1/352°)
LAT_TOP = 80.0      # latitude de la première ligne source (couverture 80N..80S)
RADIUS_M = 6051000

CREDITS = {
    "dataset": "Venus Opposite-Look Topography (VOLT): a 300-m digital elevation model of Venus "
               "from Magellan opposite-look radar stereo",
    "author": "Allyson Trussell (Arizona State University; Anthropic STEM Fellows Program)",
    "doi": "10.5281/zenodo.22164484",
    "url": "https://doi.org/10.5281/zenodo.22164484",
    "license": "CC BY 4.0",
    "inputs": "USGS Magellan FMAP mosaics 75 m; USGS Magellan GTDR altimetry; Herrick et al. (2012) stereo DEM (PDS)",
}


def parse_zooms(spec: str) -> list[int]:
    zooms: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-")
            zooms.update(range(int(a), int(b) + 1))
        else:
            zooms.add(int(part))
    bad = [z for z in zooms if z < 0 or z > 8]
    if bad:
        sys.exit(f"zooms hors plage (0..8) : {bad}")
    return sorted(zooms)


def encode_terrarium(h: np.ndarray) -> np.ndarray:
    v = np.clip(h.astype(np.int32) + 32768, 0, 65535).astype(np.uint16)
    rgb = np.empty(h.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = v >> 8
    rgb[..., 1] = v & 0xFF
    rgb[..., 2] = 0
    return rgb


def save_png(path: str, h: np.ndarray) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(encode_terrarium(h), "RGB").save(path, compress_level=6)


def read_strip(src, z: int, ty0: int, n_rows: int):
    """Lit n_rows lignes de tuiles à partir de la ligne ty0, au zoom z, sur toute la largeur.

    Retourne un int16 (n_rows*256, 512*2^z) ou None si la bande est entièrement hors données.
    """
    deg_per_tile = 180.0 / (1 << z)
    lat_top = 90.0 - ty0 * deg_per_tile
    lat_bot = lat_top - n_rows * deg_per_tile
    if lat_top <= -LAT_TOP or lat_bot >= LAT_TOP:
        return None

    row0 = (LAT_TOP - lat_top) * PPD          # négatif au-dessus de 80N
    n_src_rows = n_rows * deg_per_tile * PPD
    assert abs(row0 - round(row0)) < 1e-6 and abs(n_src_rows - round(n_src_rows)) < 1e-6, \
        f"fenêtre non entière au zoom {z} (ty0={ty0}, n_rows={n_rows})"
    row0, n_src_rows = int(round(row0)), int(round(n_src_rows))

    out_shape = (n_rows * TILE, TILE * (2 << z))
    resampling = Resampling.average if n_src_rows > out_shape[0] else Resampling.bilinear
    window = Window(0, row0, src.width, n_src_rows)
    inside = row0 >= 0 and row0 + n_src_rows <= src.height
    if inside:
        return src.read(1, window=window, out_shape=out_shape, resampling=resampling)
    return src.read(1, window=window, out_shape=out_shape, resampling=resampling,
                    boundless=True, fill_value=NODATA)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="chemin du GeoTIFF (ou /vsicurl/https://...)")
    ap.add_argument("--out", default="public", help="dossier de sortie (défaut : public)")
    ap.add_argument("--zooms", default="0-6", help="zooms à générer, ex. 0-6 ou 0,1,2,5 (défaut : 0-6)")
    ap.add_argument("--globals", default="2,3", help="zooms exportés aussi en image plein globe (défaut : 2,3)")
    ap.add_argument("--workers", type=int, default=max(2, (os.cpu_count() or 4)), help="threads d'encodage PNG")
    ap.add_argument("--force", action="store_true", help="réécrit les tuiles déjà présentes")
    args = ap.parse_args()

    zooms = parse_zooms(args.zooms)
    global_zooms = set(parse_zooms(args.globals)) if args.globals else set()
    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)

    meta_path = os.path.join(out_dir, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)

    t_start = time.time()
    with rasterio.open(args.source) as src, ThreadPoolExecutor(max_workers=args.workers) as pool:
        if (src.width, src.height) != (360 * PPD, 160 * PPD):
            sys.exit(f"dimensions inattendues {src.width}x{src.height} (attendu {360*PPD}x{160*PPD})")
        print(f"source {src.width}x{src.height}, overviews {src.overviews(1)}")

        elev_min, elev_max = meta.get("elevMin", 1e9), meta.get("elevMax", -1e9)
        tiles_per_zoom = dict(meta.get("tilesPerZoom", {}))
        globals_written = dict(meta.get("globals", {}))

        for z in zooms:
            ny, nx = 1 << z, 2 << z
            n_rows = 2 if z >= 8 else 1     # au zoom 8 une ligne de tuiles = 247,5 px source
            written = 0
            global_parts = [] if z in global_zooms else None
            t0 = time.time()

            for ty0 in range(0, ny, n_rows):
                strip = read_strip(src, z, ty0, n_rows)
                if global_parts is not None:
                    global_parts.append(strip if strip is not None
                                        else np.full((n_rows * TILE, nx * TILE), NODATA, np.int16))
                if strip is None:
                    continue

                valid = strip[strip != NODATA]
                if valid.size:
                    elev_min = min(elev_min, int(valid.min()))
                    elev_max = max(elev_max, int(valid.max()))

                futures = []
                for r in range(n_rows):
                    ty = ty0 + r
                    for tx in range(nx):
                        tile = strip[r * TILE:(r + 1) * TILE, tx * TILE:(tx + 1) * TILE]
                        if not (tile != NODATA).any():
                            continue
                        path = os.path.join(out_dir, "tiles", str(z), str(tx), f"{ty}.png")
                        if not args.force and os.path.exists(path):
                            written += 1
                            continue
                        futures.append(pool.submit(save_png, path, tile.copy()))
                for fut in futures:
                    fut.result()
                written += len(futures)
                done = ty0 + n_rows
                print(f"\r  zoom {z}: lignes {done}/{ny}  tuiles {written}  {time.time() - t0:5.0f}s", end="", flush=True)

            print(f"\r  zoom {z}: {written} tuiles écrites en {time.time() - t0:.0f}s" + " " * 20)
            tiles_per_zoom[str(z)] = written

            if global_parts is not None:
                img = np.concatenate(global_parts, axis=0)
                name = f"global_{img.shape[1]}.png"
                save_png(os.path.join(out_dir, name), img)
                globals_written[str(z)] = name
                print(f"  {name} ({img.shape[1]}x{img.shape[0]})")

    have_zooms = sorted(int(k) for k, v in tiles_per_zoom.items() if v)
    meta.update({
        "scheme": "plate-carree",
        "tileSize": TILE,
        "encoding": "terrarium",
        "nodata": NODATA,
        "minZoom": have_zooms[0] if have_zooms else None,
        "maxZoom": have_zooms[-1] if have_zooms else None,
        "zooms": have_zooms,
        "tilesPerZoom": tiles_per_zoom,
        "globals": globals_written,
        "latLimit": LAT_TOP,
        "radiusM": RADIUS_M,
        "sourcePixelDeg": 1 / PPD,
        "elevMin": elev_min,
        "elevMax": elev_max,
        "credits": CREDITS,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
    })
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    print(f"meta.json écrit ; altitude {elev_min}..{elev_max} m ; total {time.time() - t_start:.0f}s")


if __name__ == "__main__":
    main()
