"""Definizione di un'area di interesse e organizzazione dei dati su disco.

Un'AOI e' l'unita' di lavoro della pipeline: un riquadro geografico per cui
vengono costruiti superficie, grafo e ombre. Il sistema e' pensato per
funzionare su qualsiasi area italiana, quindi la proiezione metrica viene
scelta automaticamente dal fuso UTM del centroide.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass, asdict
from pathlib import Path

import requests

DATA_ROOT = Path(__file__).resolve().parent.parent / "data"
CACHE_DIR = DATA_ROOT / "cache"
AOI_DIR = DATA_ROOT / "aoi"

NOMINATIM = "https://nominatim.openstreetmap.org"
USER_AGENT = "Meriggio/1.0 (percorsi all'ombra)"


def slugify(text: str) -> str:
    """Trasforma un nome di luogo in un identificatore utilizzabile su disco."""
    norm = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", norm.lower()).strip("-")


@dataclass
class AOI:
    """Area di interesse con tutti i parametri di elaborazione."""

    slug: str
    name: str
    bounds: tuple[float, float, float, float]  # lon_min, lat_min, lon_max, lat_max
    timezone: str = "Europe/Rome"
    resolution: float = 2.0  # metri per pixel della superficie
    segment_length: float = 25.0  # lunghezza dei tratti in cui spezzare gli archi
    step_minutes: int = 15  # ogni quanti minuti si ricalcola la posizione del sole
    buffer_m: float = 600.0  # margine di superficie oltre il bordo dell'area

    # ---- geometria ----

    @property
    def center(self) -> tuple[float, float]:
        """Centro dell'area come (lon, lat)."""
        return (
            (self.bounds[0] + self.bounds[2]) / 2,
            (self.bounds[1] + self.bounds[3]) / 2,
        )

    @property
    def utm_epsg(self) -> int:
        """Codice EPSG del fuso UTM WGS84 che contiene il centroide."""
        lon, lat = self.center
        zone = int((lon + 180) / 6) + 1
        return (32600 if lat >= 0 else 32700) + zone

    def bounds_in(self, epsg: int) -> tuple[float, float, float, float]:
        """Riproietta il riquadro in un altro sistema di riferimento."""
        from pyproj import Transformer

        tr = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
        xs, ys = [], []
        # Campioniamo i lati, non solo i vertici: le proiezioni curvano i bordi
        for i in range(11):
            f = i / 10
            lon = self.bounds[0] + f * (self.bounds[2] - self.bounds[0])
            lat = self.bounds[1] + f * (self.bounds[3] - self.bounds[1])
            for pair in ((lon, self.bounds[1]), (lon, self.bounds[3]),
                         (self.bounds[0], lat), (self.bounds[2], lat)):
                x, y = tr.transform(*pair)
                xs.append(x)
                ys.append(y)
        return (min(xs), min(ys), max(xs), max(ys))

    @property
    def size_km(self) -> tuple[float, float]:
        """Dimensioni approssimative dell'area in chilometri."""
        x0, y0, x1, y1 = self.bounds_in(self.utm_epsg)
        return ((x1 - x0) / 1000, (y1 - y0) / 1000)

    @property
    def buffered_bounds(self) -> tuple[float, float, float, float]:
        """Riquadro allargato del margine di superficie, in gradi.

        La superficie va costruita piu' larga dell'area percorribile: un
        palazzo o un versante appena fuori dal bordo proietta comunque la
        sua ombra dentro, e tagliando sul bordo la si perderebbe proprio
        nelle ore in cui e' piu' lunga.
        """
        lon_min, lat_min, lon_max, lat_max = self.bounds
        dlat = self.buffer_m / 110574.0
        dlon = self.buffer_m / (111320.0 * math.cos(math.radians(self.center[1])))
        return (lon_min - dlon, lat_min - dlat, lon_max + dlon, lat_max + dlat)

    def buffered_bounds_in(self, epsg: int) -> tuple[float, float, float, float]:
        """Riquadro allargato riproiettato in un altro sistema di riferimento."""
        saved = self.bounds
        try:
            object.__setattr__(self, "bounds", self.buffered_bounds)
            return self.bounds_in(epsg)
        finally:
            object.__setattr__(self, "bounds", saved)

    # ---- percorsi su disco ----

    @property
    def dir(self) -> Path:
        return AOI_DIR / self.slug

    @property
    def dsm_path(self) -> Path:
        """Superficie opaca: terreno piu' edifici."""
        return self.dir / "dsm.tif"

    @property
    def cdsm_path(self) -> Path:
        """Superficie della vegetazione: terreno piu' chiome."""
        return self.dir / "cdsm.tif"

    @property
    def dtm_path(self) -> Path:
        """Solo terreno, serve per le pendenze."""
        return self.dir / "dtm.tif"

    @property
    def tcd_path(self) -> Path:
        """Densita' di copertura arborea 0-100."""
        return self.dir / "tcd.tif"

    @property
    def graph_path(self) -> Path:
        return self.dir / "graph.npz"

    @property
    def buildings_path(self) -> Path:
        return self.dir / "buildings.geojson"

    @property
    def traffic_stats_path(self) -> Path:
        """Riepilogo della calibrazione traffico (`traffico.calibra`), se l'area la supporta."""
        return self.dir / "traffico.json"

    # ---- persistenza ----

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        payload = asdict(self)
        payload["bounds"] = list(self.bounds)
        payload["utm_epsg"] = self.utm_epsg
        payload["center"] = list(self.center)
        payload["size_km"] = list(self.size_km)
        (self.dir / "aoi.json").write_text(json.dumps(payload, indent=2))

    @classmethod
    def load(cls, slug: str) -> "AOI":
        path = AOI_DIR / slug / "aoi.json"
        if not path.exists():
            raise FileNotFoundError(f"area '{slug}' non preparata: {path} assente")
        raw = json.loads(path.read_text())
        known = {f for f in cls.__dataclass_fields__}
        data = {k: v for k, v in raw.items() if k in known}
        data["bounds"] = tuple(data["bounds"])
        return cls(**data)

    @classmethod
    def list_available(cls) -> list["AOI"]:
        if not AOI_DIR.exists():
            return []
        out = []
        for d in sorted(AOI_DIR.iterdir()):
            if (d / "aoi.json").exists():
                try:
                    out.append(cls.load(d.name))
                except Exception:
                    continue
        return out

    def is_ready(self) -> bool:
        """Vero se l'area ha superficie e grafo pronti per il calcolo percorsi."""
        return self.dsm_path.exists() and self.graph_path.exists()


def bounds_around(lon: float, lat: float, radius_km: float):
    """Riquadro geografico centrato su un punto, con semilato in chilometri."""
    dlat = radius_km / 110.574
    dlon = radius_km / (111.320 * math.cos(math.radians(lat)))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def geocode(query: str, limit: int = 5, country: str | None = "it") -> list[dict]:
    """Cerca un luogo con Nominatim. Ritorna nome, coordinate e riquadro."""
    params = {"q": query, "format": "jsonv2", "limit": limit, "addressdetails": 1}
    if country:
        params["countrycodes"] = country
    resp = requests.get(
        f"{NOMINATIM}/search",
        params=params,
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    resp.raise_for_status()
    out = []
    for item in resp.json():
        south, north, west, east = (float(v) for v in item["boundingbox"])
        out.append(
            {
                "name": item.get("display_name", query),
                "short_name": item.get("name") or query,
                "lon": float(item["lon"]),
                "lat": float(item["lat"]),
                "bounds": (west, south, east, north),
                "type": item.get("type"),
            }
        )
    return out


def urban_center(name: str, bounds, log=print) -> tuple[float, float] | None:
    """Coordinate del nucleo abitato di nome `name` dentro un riquadro.

    Serve perche' Nominatim, cercando un comune, restituisce il confine
    amministrativo: il suo centroide cade dove capita, spesso in aperta
    campagna. Il nodo `place` di OpenStreetMap indica invece il centro
    dell'abitato, che e' quello che interessa a chi cerca un percorso.
    """
    # I centri risolti restano in cache: Overpass e' spesso sovraccarico e
    # non ha senso ripetere la stessa domanda a ogni preparazione.
    cache_file = CACHE_DIR / "centri_abitati.json"
    key = f"{name}|{','.join(f'{v:.3f}' for v in bounds)}"
    cached = {}
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text())
        except json.JSONDecodeError:
            cached = {}
    if key in cached:
        return tuple(cached[key])

    lon_min, lat_min, lon_max, lat_max = bounds
    query = f"""
    [out:json][timeout:60];
    node["place"~"^(city|town|village|borough)$"]["name"="{name}"]
        ({lat_min},{lon_min},{lat_max},{lon_max});
    out body 5;
    """

    elements = []
    for endpoint in (
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
    ):
        try:
            resp = requests.post(
                endpoint,
                data={"data": query},
                headers={"User-Agent": USER_AGENT},
                timeout=90,
            )
            resp.raise_for_status()
            elements = resp.json().get("elements", [])
            if elements:
                break
        except Exception as exc:
            log(f"  ricerca del centro abitato fallita su {endpoint}: {exc}")

    if not elements:
        return None

    rank = {"city": 0, "town": 1, "borough": 2, "village": 3}
    best = min(elements, key=lambda e: rank.get(e.get("tags", {}).get("place"), 9))
    center = (float(best["lon"]), float(best["lat"]))

    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cached[key] = list(center)
    cache_file.write_text(json.dumps(cached, indent=2))
    return center


def aoi_from_place(
    place: str, radius_km: float = 1.6, slug: str | None = None, log=print, **kwargs
) -> AOI:
    """Costruisce un'AOI quadrata attorno al centro abitato di un luogo."""
    results = geocode(place, limit=5)
    if not results:
        raise ValueError(f"luogo non trovato: {place}")

    # Preferiamo un risultato che sia gia' un abitato e non un confine
    settlement = next(
        (r for r in results if r["type"] in ("city", "town", "village", "hamlet")),
        None,
    )
    hit = settlement or results[0]
    lon, lat = hit["lon"], hit["lat"]

    if settlement is None:
        center = urban_center(hit["short_name"], hit["bounds"], log=log)
        if center:
            moved = (
                (center[0] - lon) ** 2 + (center[1] - lat) ** 2
            ) ** 0.5 * 111.0
            log(
                f"  centro abitato individuato a {center[1]:.4f}, {center[0]:.4f} "
                f"({moved:.1f} km dal centroide amministrativo)"
            )
            lon, lat = center
        else:
            log("  nessun nodo di abitato trovato, uso il centroide amministrativo")

    return AOI(
        slug=slug or slugify(hit["short_name"]),
        name=hit["short_name"],
        bounds=bounds_around(lon, lat, radius_km),
        **kwargs,
    )
