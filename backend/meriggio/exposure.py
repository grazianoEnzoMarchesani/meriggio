"""Esposizione solare dei tratti nel tempo, interrogabile a qualsiasi orario.

Il router deve poter chiedere "quanto sole prende questo tratto alle 15:37?"
migliaia di volte per ogni richiesta di percorso. La risposta viene quindi
campionata a istanti discreti e interpolata fra i due piu' vicini: costa un
accesso a un array, e il sole si muove con continuita' invece che a scatti.

I valori arrivano da `live.route_exposure`, che li calcola sul corridoio del
tragitto. Il precalcolo di giornate intere non c'e' piu': serviva quando le
ombre erano un lavoro da minuti, ed e' caduto insieme al server.
"""

from __future__ import annotations

import numpy as np


class Exposure:
    """Matrice [istanti x tratti] della frazione di tratto illuminata.

    I valori sono uint8 per compattezza: 0 e' ombra piena, 255 pieno sole.

    Gli orari sono minuti dalla mezzanotte del giorno di partenza e possono
    superare 1440, cosi' un tragitto che scavalca la mezzanotte resta una
    sequenza crescente e l'interpolazione non torna indietro nel tempo.
    """

    def __init__(self, exposure, minutes, elevation, azimuth, day):
        self.exposure = exposure
        self.minutes = minutes
        self.elevation = elevation
        self.azimuth = azimuth
        self.day = day

    @property
    def start_minute(self) -> float:
        return float(self.minutes[0])

    @property
    def end_minute(self) -> float:
        return float(self.minutes[-1])

    def index_at(self, minute_of_day: float) -> int:
        """Indice dell'istante calcolato piu' vicino a un orario."""
        return int(
            np.clip(np.searchsorted(self.minutes, minute_of_day), 0, len(self.minutes) - 1)
        )

    def row(self, minute_of_day: float) -> np.ndarray:
        """Esposizione di tutti i tratti a un dato orario, in [0, 1].

        Interpola linearmente fra i due istanti adiacenti: il sole si muove
        con continuita' e un passo di 15 minuti darebbe altrimenti scalini
        visibili nei costi.
        """
        m = float(np.clip(minute_of_day, self.minutes[0], self.minutes[-1]))
        j = int(np.clip(np.searchsorted(self.minutes, m), 1, len(self.minutes) - 1))
        m0, m1 = self.minutes[j - 1], self.minutes[j]
        w = 0.0 if m1 == m0 else (m - m0) / (m1 - m0)
        lo = self.exposure[j - 1].astype(np.float32)
        hi = self.exposure[j].astype(np.float32)
        return (lo + w * (hi - lo)) / 255.0

    def sun_at(self, minute_of_day: float) -> tuple[float, float]:
        """Elevazione e azimut del sole a un dato orario."""
        i = self.index_at(minute_of_day)
        return float(self.elevation[i]), float(self.azimuth[i])
