/**
 * La strada che i dati percorrono davvero: rete, non disco.
 *
 * Gli altri test leggono i file dell'area dal disco, il che va benissimo per
 * verificare i conti ma salta il pezzo che in produzione puo' rompersi da solo:
 * un server che consegna i blocchi gia' scompattati invece che compressi, o al
 * contrario. `rete.ts` decide guardando i primi due byte e non l'estensione,
 * proprio per non dipendere da come e' configurato l'host, e qui si controlla
 * che quella decisione regga in tutt'e due i casi.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { extname, normalize } from 'node:path'

import { Area } from '../src/meriggio/area.ts'
import { sorgenteRete } from '../src/meriggio/rete.ts'
import { DATI, esportata } from './area.ts'

/**
 * Un server statico minimo. Con `scompatta` acceso consegna i file `.gz` gia'
 * decompressi, come fa un host che li tratta come contenuto codificato.
 */
function servi(scompatta: boolean): Promise<{ base: string; chiudi: () => void }> {
  const server = createServer(async (req, res) => {
    try {
      const percorso = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]))
      if (percorso.includes('..')) throw new Error('fuori radice')
      let dati = await readFile(DATI + percorso.replace(/^\//, ''))
      if (scompatta && extname(percorso) === '.gz') dati = gunzipSync(dati)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(dati)
    } catch {
      res.writeHead(404).end()
    }
  })
  return new Promise((risolvi) => {
    server.listen(0, '127.0.0.1', () => {
      const porta = (server.address() as { port: number }).port
      risolvi({
        base: `http://127.0.0.1:${porta}/ascoli-piceno/`,
        chiudi: () => server.close(),
      })
    })
  })
}

const disponibile = esportata('ascoli-piceno')

for (const scompattati of [false, true]) {
  test(
    `un percorso completo scaricando i dati ${scompattati ? 'gia scompattati' : 'compressi'}`,
    { skip: !disponibile && 'area non esportata' },
    async () => {
      const { base, chiudi } = await servi(scompattati)
      try {
        const area = await Area.apri(sorgenteRete(base))
        assert.equal(area.slug, 'ascoli-piceno')
        assert.equal(area.grafo.nTratti, area.manifesto.graph.edges)
        assert.equal(area.tasselliInMemoria.presenti, 0)

        const risultato = await area.percorso({
          partenza: { lon: 13.5744, lat: 42.8542 },
          arrivo: { lon: 13.5801, lat: 42.8556 },
          modalita: 'foot',
          quando: new Date('2026-07-30T13:40:00+02:00'),
          preferenzaOmbra: 0.6,
        })

        // Gli stessi numeri che i riferimenti del backend danno per questo
        // tragitto: seicento metri scarsi, circa metà in ombra a quell'ora.
        assert.ok(
          Math.abs(risultato.shaded.distance_m - 600) < 60,
          `distanza inattesa: ${risultato.shaded.distance_m} m`,
        )
        assert.ok(
          risultato.shaded.shade_pct > 30 && risultato.shaded.shade_pct < 80,
          `ombra inattesa: ${risultato.shaded.shade_pct}%`,
        )
        assert.ok(risultato.shaded.coordinates.length > 5)
        assert.ok(risultato.shaded.arrival_instant > risultato.departure_instant)
        assert.ok(risultato.shaded.sun_start.elevation > 0)

        // Un tragitto di seicento metri non deve tirarsi dietro tutta la citta'.
        const { presenti, totali } = area.tasselliInMemoria
        assert.ok(presenti >= 1 && presenti < totali, `${presenti} tasselli su ${totali}`)

        // E l'immagine delle ombre deve uscire dalla stessa area.
        const ombre = await area.ombre({
          bounds: area.manifesto.bounds,
          quando: new Date('2026-07-30T13:40:00+02:00'),
          latoMax: 400,
        })
        assert.ok(ombre, 'nessuna immagine delle ombre')
        assert.equal(ombre.pixel.length, ombre.larghezza * ombre.altezza * 4)
        const opachi = [...ombre.pixel.filter((_, i) => i % 4 === 3)].filter((a) => a > 0)
        assert.ok(
          opachi.length > ombre.larghezza * ombre.altezza * 0.05,
          'l\'immagine e\' quasi tutta trasparente',
        )
      } finally {
        chiudi()
      }
    },
  )
}
