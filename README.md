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
  ombrage et couleurs hypsométriques calculés en GPU.
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

## Déploiement sur un hébergement mutualisé (Infomaniak)

L'application est 100 % statique : aucun PHP, aucune base de données. Il suffit de déposer dans
le dossier web du site le contenu de `dist/` (build Vite), de `public/` (tuiles, cartes globales,
`meta.json`, `names.json`) et le `deploy/.htaccess` (cache long sur les tuiles, 404 minimal).
Les images radar et la nomenclature sont chargées depuis l'USGS, sans proxy.

1. Empaqueter (build + archive unique, ~1,6 Go, ~56 000 fichiers) :

```bash
pwsh tools/package.ps1
```

2. Activer SSH dans le Manager Infomaniak (Hébergement → SSH/FTP → utilisateur avec accès SSH),
   puis envoyer l'archive et la décompresser sur place (bien plus rapide que 56 000 transferts FTP) :

```bash
scp magellan-site.zip UTILISATEUR@HOTE.ftp.infomaniak.com:~/sites/MON-DOMAINE/
```

```bash
ssh UTILISATEUR@HOTE.ftp.infomaniak.com "cd ~/sites/MON-DOMAINE && unzip -oq magellan-site.zip && rm magellan-site.zip"
```

   `HOTE` et `UTILISATEUR` sont ceux de l'accès FTP/SSH ; le dossier web est
   `~/sites/<domaine>/` (ou `~/web/` pour l'ancien schéma). Le site fonctionne aussi dans un
   sous-dossier (chemins relatifs).

3. Mises à jour de l'application seule : `npm run build` puis renvoyer `dist/index.html` et
   `dist/assets/` (les tuiles ne changent pas).

Sans SSH, WinSCP/FileZilla fonctionnent mais l'envoi des 56 000 tuiles prend plusieurs heures ;
on peut alors limiter le zoom 8 (`--zooms 0-7` → ~540 Mo, 14 000 fichiers).

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
