"""Interfaccia a riga di comando della pipeline.

    python -m meriggio.cli prepara --luogo "Ascoli Piceno" --raggio 1.7
    python -m meriggio.cli esporta --area ascoli-piceno
    python -m meriggio.cli elenco
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .aoi import AOI, CACHE_DIR, aoi_from_place, bounds_around, slugify

# Dove finiscono i file statici che il browser scarica. Sta dentro `public`
# del frontend cosi' funziona identico in sviluppo e nel build: Vite serve
# quella cartella alla radice del sito e la ricopia nel `dist`.
DATI_ROOT = Path(__file__).resolve().parents[2] / "web" / "public" / "dati"

# I valori con cui i test del client verificano che il porting in TypeScript
# faccia ancora quello che fa il Python.
RIFERIMENTI_ROOT = Path(__file__).resolve().parents[2] / "web" / "test" / "riferimenti"


def _log(msg=""):
    print(msg, flush=True)


def prepara(args) -> int:
    """Scarica i dati e costruisce superficie e grafo di un'area."""
    from . import sources
    from .graph import build_graph
    from .surface import build_surface

    t0 = time.time()

    if args.centro:
        lon, lat = args.centro
        nome = args.luogo or args.area or "area"
        aoi = AOI(
            slug=slugify(args.area or nome),
            name=nome,
            bounds=bounds_around(lon, lat, args.raggio),
            resolution=args.risoluzione,
        )
    elif args.luogo:
        aoi = aoi_from_place(
            args.luogo,
            radius_km=args.raggio,
            slug=args.area,
            resolution=args.risoluzione,
            log=_log,
        )
    elif args.bbox:
        lon_min, lat_min, lon_max, lat_max = args.bbox
        nome = args.area or "area"
        aoi = AOI(
            slug=slugify(nome),
            name=nome,
            bounds=(lon_min, lat_min, lon_max, lat_max),
            resolution=args.risoluzione,
        )
    else:
        _log("serve --luogo oppure --bbox")
        return 2

    w, h = aoi.size_km
    _log(f"Area '{aoi.name}' [{aoi.slug}]  {w:.1f} x {h:.1f} km  EPSG:{aoi.utm_epsg}")
    _log(f"  riquadro {tuple(round(v, 4) for v in aoi.bounds)}")
    aoi.save()

    # Superficie e vegetazione si scaricano sul riquadro allargato, la rete
    # stradale solo sull'area utile.
    wide = aoi.buffered_bounds

    _log("\n[1/4] terreno TINITALY")
    dtm_tiles = sources.fetch_dtm(aoi.buffered_bounds_in(32632), CACHE_DIR, log=_log)

    _log("\n[2/4] edifici TUM LoD1")
    buildings = sources.fetch_buildings(wide, CACHE_DIR, log=_log)

    _log("\n[3/4] vegetazione")
    canopy = sources.fetch_canopy(wide, CACHE_DIR, log=_log)
    tcd = sources.fetch_tree_cover_density(wide, CACHE_DIR, log=_log)

    _log("\n[4/4] superficie e rete")
    surf_stats = build_surface(aoi, dtm_tiles, buildings, canopy, tcd, log=_log)

    osm = sources.fetch_osm(aoi.bounds, CACHE_DIR, log=_log)
    graph_stats = build_graph(aoi, osm, log=_log)

    from .traffico import calibra as calibra_traffico, disponibile as traffico_disponibile

    traffic_stats = None
    if traffico_disponibile(aoi):
        _log("\n[+] traffico (calibrazione PUMS, solo dove disponibile)")
        traffic_stats = calibra_traffico(aoi, osm, buildings, log=_log)
    else:
        _log("\n[+] traffico: nessun CSV PUMS per quest'area, passo saltato")

    _export_buildings(aoi, buildings, log=_log)

    stats = {"surface": surf_stats, "graph": graph_stats}
    if traffic_stats is not None:
        stats["traffic"] = traffic_stats
    (aoi.dir / "stats.json").write_text(json.dumps(stats, indent=2))

    if not args.senza_esporta:
        _log("\nesportazione dei file statici per il browser")
        _esporta(aoi, args.destinazione)

    _log(f"\nArea pronta in {time.time() - t0:.0f}s -> {aoi.dir}")
    return 0


def _esporta(aoi, destinazione) -> None:
    """Riscrive l'area in file statici e aggiorna l'indice delle aree."""
    from .export import export_area, write_index

    root = Path(destinazione) if destinazione else DATI_ROOT
    export_area(aoi, root, log=_log)
    write_index(root, log=_log)


def esporta(args) -> int:
    """Esporta un'area gia' preparata nei file statici che legge il client."""
    aoi = AOI.load(args.area)
    if not aoi.is_ready():
        _log(f"area '{args.area}' incompleta: manca la superficie o il grafo")
        return 1
    _log(f"Esportazione di {aoi.name}")
    _esporta(aoi, args.destinazione)
    return 0


def _export_buildings(aoi, buildings, log=_log):
    """Salva gli edifici dell'area in GeoJSON per l'estrusione 3D sulla mappa."""
    lon_min, lat_min, lon_max, lat_max = aoi.bounds
    inside = buildings.cx[lon_min:lon_max, lat_min:lat_max].copy()
    # Semplificare a ~0.2 m taglia il peso del file senza che si veda
    inside["geometry"] = inside.geometry.simplify(0.000002)
    inside[["height", "geometry"]].to_file(aoi.buildings_path, driver="GeoJSON")
    size_kb = aoi.buildings_path.stat().st_size / 1024
    log(f"  {len(inside)} edifici esportati per la mappa ({size_kb:.0f} kB)")


def riferimenti(args) -> int:
    """Rigenera i valori con cui i test del client verificano il porting."""
    from .riferimenti import scrivi

    aoi = None
    if args.area:
        aoi = AOI.load(args.area)
        if not aoi.is_ready():
            _log(f"area '{args.area}' incompleta")
            return 1
    dest = Path(args.destinazione) if args.destinazione else RIFERIMENTI_ROOT
    _log(f"Riferimenti in {dest}")
    scrivi(dest, aoi, percorsi=not args.senza_percorsi, log=_log)
    return 0


def elenco(args) -> int:
    """Elenca le aree preparate."""
    areas = AOI.list_available()
    if not areas:
        _log("nessuna area preparata")
        return 0
    for a in areas:
        w, h = a.size_km
        stato = "pronta" if a.is_ready() else "incompleta"
        esportata = (DATI_ROOT / a.slug / "manifest.json").exists()
        _log(
            f"{a.slug:24s} {a.name:22s} {w:.1f}x{h:.1f} km  {stato}  "
            f"{'esportata' if esportata else 'da esportare'}"
        )
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="meriggio", description="Pipeline dati per percorsi all'ombra")
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("prepara", help="scarica i dati e prepara un'area")
    pr.add_argument("--luogo", help="nome del luogo da cercare, es. 'Ascoli Piceno'")
    pr.add_argument("--bbox", nargs=4, type=float, metavar=("LON_MIN", "LAT_MIN", "LON_MAX", "LAT_MAX"))
    pr.add_argument("--centro", nargs=2, type=float, metavar=("LON", "LAT"),
                    help="centro esatto dell'area, scavalca la ricerca per nome")
    pr.add_argument("--area", help="identificatore dell'area su disco")
    pr.add_argument("--raggio", type=float, default=1.7, help="semilato in km attorno al luogo")
    pr.add_argument("--risoluzione", type=float, default=2.0, help="metri per pixel della superficie")
    pr.add_argument("--destinazione", help=f"cartella dei file statici (default: {DATI_ROOT})")
    pr.add_argument("--senza-esporta", action="store_true", dest="senza_esporta",
                    help="non esportare i file statici per il browser")
    pr.set_defaults(func=prepara)

    ex = sub.add_parser("esporta", help="riscrive un'area nei file statici per il browser")
    ex.add_argument("--area", required=True)
    ex.add_argument("--destinazione", help=f"cartella di destinazione (default: {DATI_ROOT})")
    ex.set_defaults(func=esporta)

    ri = sub.add_parser("riferimenti", help="rigenera i valori di collaudo del client")
    ri.add_argument("--area", default="ascoli-piceno",
                    help="area da cui prendere i casi reali; vuoto per i soli sintetici")
    ri.add_argument("--destinazione", help=f"cartella di destinazione (default: {RIFERIMENTI_ROOT})")
    ri.add_argument("--senza-percorsi", action="store_true", dest="senza_percorsi",
                    help="salta i percorsi, che sono i piu' lenti da calcolare")
    ri.set_defaults(func=riferimenti)

    el = sub.add_parser("elenco", help="elenca le aree preparate")
    el.set_defaults(func=elenco)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
