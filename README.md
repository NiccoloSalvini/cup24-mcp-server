# cup24-mcp-server

Server [MCP](https://modelcontextprotocol.io) **non ufficiale** per [cup24.it](https://cup24.it) (ex Cup Solidale): chiedi al tuo assistente AI dove fare un esame o una visita privata in Italia, quando e a che prezzo.

> «Trovami l'ecografia addome completo più economica a Firenze questa settimana»
> «Chi ha posto domani mattina per una visita cardiologica a Milano?»

Il server è **solo in lettura**: cerca e confronta disponibilità e prezzi in tempo reale. La prenotazione resta sul sito: ogni risultato ha un `booking_url` alla pagina della struttura.

*English: unofficial, read-only MCP server for cup24.it, the Italian private-healthcare booking site. It searches services and cities and returns real-time availability, prices and clinics; booking stays on the website.*

## Strumenti

| Strumento | Cosa fa |
|---|---|
| `cup24_search_services` | Cerca una prestazione per nome (es. `ecografia addome`) e ne restituisce l'id |
| `cup24_search_cities` | Cerca una città o una zona (es. `firenze`, `firenze-zona-campo-di-marte`) e ne restituisce lo slug |
| `cup24_get_availability` | Disponibilità e prezzi di una prestazione in una città: data, orari liberi, prezzo (anche scontato), struttura, indirizzo, coordinate, distanza dal centro, medico e link per prenotare. Ordina per `date`, `price` o `distance`, filtra per `oggi`, `domani`, `settimana`, `prossima-settimana`, `prossimo-mese`, e pagina in ordine cronologico |

## Installazione

Serve Node.js 20 o superiore.

```bash
git clone https://github.com/NiccoloSalvini/cup24-mcp-server.git
cd cup24-mcp-server
npm install
npm run build
```

### Claude Code

```bash
claude mcp add cup24 -- node /percorso/assoluto/cup24-mcp-server/dist/index.js
```

### Claude Desktop e altri client MCP

Aggiungi al file di configurazione dei server MCP (per Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cup24": {
      "command": "node",
      "args": ["/percorso/assoluto/cup24-mcp-server/dist/index.js"]
    }
  }
}
```

Senza clonare, direttamente da GitHub (npm compila il pacchetto al primo avvio):

```json
{
  "mcpServers": {
    "cup24": { "command": "npx", "args": ["-y", "github:NiccoloSalvini/cup24-mcp-server"] }
  }
}
```

## Come funziona cup24.it

cup24.it non ha un'API pubblica documentata. Il server usa gli stessi endpoint che usa il sito, ricostruiti con [REA](https://github.com/morluto/rea) (analisi del bundle JavaScript e cattura di uno scenario nel browser) e con l'osservazione del traffico in Chrome:

| Endpoint | Uso sul sito |
|---|---|
| `GET https://api2.cup24.it/v2/search/suggest?term=…` | Autocompletamento della ricerca: prestazioni (`type: "service"`), strutture e medici |
| `GET https://api2.cup24.it/v2/search/suggestcity?term=…` | Autocompletamento di città e zone, con lo slug usato negli URL |
| `GET https://cup24.it/c/{città}/{id prestazione}/` | Pagina dei risultati, generata dal server in HTML |
| `POST` sulla stessa URL, form `page`, `when`, `sort` (`sort:price`, `sort:where`) | Pulsante «Altre date», filtri per data e ordinamento |

Nella pagina dei risultati ogni card è una struttura in un giorno: gli orari liberi sono nell'attributo `title="Orari: …"`, mentre indirizzo, coordinate e data sono in un oggetto JSON passato a `window.slotAddressPoints.push(…)`. Il server legge questi dati; se il sito cambia struttura, il parser va aggiornato (`npm test` lo verifica su una copia ridotta di una pagina reale, `npm run smoke` sul sito vero).

## Sviluppo

```bash
npm run build   # compila in dist/
npm test        # test del parser, offline
npm run smoke   # avvia il server e chiama ogni strumento sul sito reale
```

Per esplorarlo a mano: `npx @modelcontextprotocol/inspector node dist/index.js`.

## Avvertenze

- Progetto indipendente, **non affiliato** a CupSolidale srl né a cup24.it. Marchi e dati appartengono ai rispettivi titolari.
- I dati vengono dal sito in tempo reale e possono cambiare in ogni momento: prezzo e orario valgono solo dopo la conferma sul sito.
- Usalo con moderazione: ogni chiamata è una richiesta a cup24.it. Il server si identifica con uno `User-Agent` che rimanda a questo repository.
- Non è un dispositivo medico e non dà consigli medici.

## Licenza

[MIT](LICENSE)
