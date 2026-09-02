# Vénus en relief — visionneuse 3D du DEM VOLT (Magellan)

Application web (Vite + Three.js) pour explorer en 3D la topographie de Vénus issue du
jeu de données **Venus Opposite-Look Topography (VOLT)** : un modèle numérique d'élévation
à 300 m dérivé des images radar de la sonde Magellan.

- Données : Trussell, A. (2026). *Venus Opposite-Look Topography*. Zenodo.
  <https://doi.org/10.5281/zenodo.22164484> — CC BY 4.0, produit de recherche non relu par les pairs.
- Sources amont : mosaïques FMAP et altimétrie GTDR Magellan (USGS / NASA PDS),
  topographie stéréo de Herrick et al. (2012).

## Principe

Le GeoTIFF source (3,9 Go, 126 720 × 56 320 px, Int16) n'est pas servi au navigateur.
Un script Python le convertit une seule fois en une pyramide de tuiles PNG d'altitude
(encodage « Terrarium », 256 px) et en cartes globales, que l'application charge à la demande :

- **Globe** : sphère de 6051 km déformée par la carte globale (shader de déplacement),
  ombrage et couleurs hypsométriques calculés en GPU. En zoomant, un morceau de sphère haute
  résolution (jusqu'à 8 × 8 tuiles, zoom choisi pour qu'un texel ≈ un pixel écran) se charge
  automatiquement sous la zone regardée et remplace la carte globale à cet endroit.
- **Région** : clic sur le globe → chargement d'un carré de tuiles au zoom choisi,
  rendu en terrain plan haute résolution (jusqu'à ~300 m/px). Échap ou × pour revenir au globe
  (la vue précédente est conservée) ; changer le zoom ou la taille recharge la région au même endroit.
- **Image radar** : le rendu « Image radar Magellan » drape la mosaïque SAR gauche (cycle 1, 75 m)
  servie par le WMS de l'USGS (`planetarymaps.usgs.gov`) sur le relief — y compris dans les zones
  grises hors couverture VOLT (à plat). Nécessite une connexion réseau.
- **Noms** : nomenclature IAU (Gazetteer, USGS) affichée sur le globe (dégroupée selon la distance)
  et dans les régions ; champ « Aller à… » pour se rendre sur une entité nommée.

## Mise en route

```bash
npm install
pip install rasterio numpy pillow
```

1. Télécharger `VOLT_DEM_300m.tif` depuis Zenodo dans `data/` (ignoré par git).
2. Générer les tuiles (zooms 0 à 7 ≈ 45 000 tuiles, zoom 8 ≈ résolution native) :

```bash
python tools/build_tiles.py data/VOLT_DEM_300m.tif --zooms 0-7
```

   Le script est reprenable (les tuiles déjà présentes sont sautées) ; `--zooms 8` peut être
   lancé plus tard. Sorties dans `public/` : `tiles/{z}/{x}/{y}.png`, `global_*.png`, `meta.json`.

3. Générer la nomenclature (`public/names.json`, ~1 985 entités) :

```bash
python tools/build_names.py
```

4. Lancer l'application :

```bash
npm run dev
```

## Déploiement

L'application est 100 % statique : aucun PHP, aucune base de données. N'importe quel hébergement
web convient. `pwsh tools/package.ps1` construit le site et assemble dans `magellan-site.zip`
le contenu de `dist/` (build Vite), de `public/` (tuiles, cartes globales, `meta.json`,
`names.json`) et le `deploy/.htaccess` (cache long sur les tuiles, 404 minimal pour Apache) ;
il suffit de décompresser l'archive dans le dossier web du site. Les chemins sont relatifs, le
site fonctionne aussi dans un sous-dossier. Les images radar et la nomenclature sont chargées
depuis l'USGS, sans proxy.

Pour un envoi allégé (~540 Mo, 14 000 fichiers au lieu de ~1,6 Go et 56 000), générer les tuiles
avec `--zooms 0-7` : on perd seulement le niveau natif à 290 m/px.

`dist/` est versionné : chaque commit qui touche `src/` ou `index.html` embarque le bundle
correspondant (`npm run build` avant de commiter). Mettre l'application à jour sur le serveur
revient donc à y copier `dist/index.html` et `dist/assets/` depuis GitHub, sans Node ni npm
(`pwsh tools/package.ps1 -AppOnly` produit l'archive équivalente).

## Pourquoi seulement 35 % de la planète ?

Magellan a imagé 98 % de Vénus au radar, mais VOLT tire le relief fin de la **stéréo à visées
opposées** : il faut qu'un même point ait été vu en visée gauche (cycle 1) *et* en visée droite
(cycle 2), or le cycle 2 n'a couvert qu'une partie de la planète. Les zones grises ne sont donc pas
« non cartographiées » : l'image radar existe (couche USGS) et l'altimétrie Magellan (GTDR, ~5 km)
aussi, mais pas le relief à 300 m.

## Schéma de tuiles

Plate carrée plein globe : au zoom *z*, 2^(z+1) colonnes × 2^z lignes de tuiles de 256 px
couvrant lon −180…180 et lat 90…−90. Encodage : `h = R·256 + G + B/256 − 32768` m ;
nodata = RGB(0,0,0). Les tuiles vides ne sont pas écrites.
