#!/usr/bin/env python3
"""
Convertit la nomenclature IAU de Vénus (Gazetteer of Planetary Nomenclature, USGS) en
public/names.json pour l'affichage des noms dans la visionneuse.

Source : https://planetarynames.wr.usgs.gov/Page/VENUS/target (KMZ des points centraux,
domaine public, USGS/IAU). Longitudes converties de 0..360 E en -180..180.

Usage :
  python tools/build_names.py                # télécharge le KMZ
  python tools/build_names.py chemin.kmz     # utilise un fichier local
"""
import io
import json
import os
import sys
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

KMZ_URL = "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/VENUS_nomenclature_center_pts.kmz"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "names.json")
NS = {"k": "http://www.opengis.net/kml/2.2"}


def main() -> None:
    if len(sys.argv) > 1:
        with open(sys.argv[1], "rb") as f:
            raw = f.read()
    else:
        print(f"téléchargement {KMZ_URL}")
        req = urllib.request.Request(KMZ_URL, headers={"User-Agent": "Mozilla/5.0"})
        raw = urllib.request.urlopen(req, timeout=60).read()

    z = zipfile.ZipFile(io.BytesIO(raw))
    kml_name = next(n for n in z.namelist() if n.endswith(".kml"))
    root = ET.fromstring(z.read(kml_name))

    features = []
    for pm in root.iter(f"{{{NS['k']}}}Placemark"):
        data = {sd.get("name"): (sd.text or "").strip()
                for sd in pm.iter(f"{{{NS['k']}}}SimpleData")}
        try:
            lon = float(data["center_lon"])
            lat = float(data["center_lat"])
            diameter = float(data.get("diameter") or 0)
        except (KeyError, ValueError):
            continue
        if data.get("approval", "").startswith("Dropped"):
            continue
        if lon > 180:
            lon -= 360
        features.append({
            "name": data.get("clean_name") or pm.findtext("k:name", default="", namespaces=NS),
            "type": data.get("type", "").split(",")[0],   # « Mons, montes » -> « Mons »
            "code": data.get("code", ""),
            "lat": round(lat, 2),
            "lon": round(lon, 2),
            "km": round(diameter, 1),
            "origin": data.get("origin", ""),
        })

    features.sort(key=lambda f: -f["km"])
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({
            "source": "Gazetteer of Planetary Nomenclature (IAU / USGS Astrogeology), public domain",
            "url": "https://planetarynames.wr.usgs.gov/Page/VENUS/target",
            "features": features,
        }, f, ensure_ascii=False, separators=(",", ":"))
    types = {}
    for ft in features:
        types[ft["type"]] = types.get(ft["type"], 0) + 1
    print(f"{len(features)} entités écrites dans {os.path.normpath(OUT)}")
    print(", ".join(f"{k} {v}" for k, v in sorted(types.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
