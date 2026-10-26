# cup24-mcp-server

Server [MCP](https://modelcontextprotocol.io) **non ufficiale** per [cup24.it](https://cup24.it) (ex Cup Solidale): chiedi al tuo assistente AI dove fare un esame o una visita privata in Italia, quando e a che prezzo.

> «Trovami l'ecografia addome completo più economica a Firenze questa settimana»
> «Chi ha posto domani mattina per una visita cardiologica a Milano?»
> «Emocromo e glicemia insieme, dove costa meno a Roma?»
> «Come mi preparo a una risonanza e quanto costa di solito a Bologna?»

Il server è **solo in lettura**: cerca e confronta disponibilità, orari e prezzi in tempo reale. La prenotazione resta sul sito, perché chiede dati personali e pagamento: ogni risultato ha un `booking_url` alla pagina della struttura.

*English: unofficial, read-only MCP server for cup24.it, the Italian private-healthcare booking site. It searches services, clinics and doctors and returns real-time availability, bookable times, prices and service information; booking stays on the website.*

## Strumenti

| Strumento | Cosa fa |
|---|---|
| `cup24_search` | Cerca per nome prestazioni (esami, visite, analisi, pacchetti check-up), strutture e medici, e ne restituisce gli id |
| `cup24_search_cities` | Cerca una città o una zona (es. `firenze`, `firenze-zona-campo-di-marte`) e ne restituisce lo slug |
| `cup24_get_availability` | Disponibilità e prezzi: di una prestazione in una città, di più analisi di laboratorio prenotate insieme, di una struttura o di un medico. Per ogni struttura e giorno: orari liberi, prezzo (anche scontato), voto e recensioni, indirizzo, coordinate, distanza, medico, `slot_id` e link per prenotare. Ordina per `date`, `price` o `distance`, filtra per `oggi`, `domani`, `settimana`, `prossima-settimana`, `prossimo-mese`, e pagina in ordine cronologico |
| `cup24_get_slot_times` | Gli orari prenotabili di uno slot giorno per giorno, come nel riquadro «Scegli data e ora» del sito; per le analisi, la fascia oraria dei prelievi |
| `cup24_get_service_info` | La scheda di una prestazione: a cosa serve, preparazione, digiuno, durata e altre FAQ, prezzo minimo e massimo nelle principali città, e per i pacchetti l'elenco delle analisi incluse |

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
| `GET https://api2.cup24.it/v2/search/suggest?term=…` | Autocompletamento della ricerca: prestazioni (`type: "service"`), strutture (`sede`) e medici (`doctor`). I pacchetti check-up hanno id che iniziano con `P` |
| `GET https://api2.cup24.it/v2/search/suggestcity?term=…` | Autocompletamento di città e zone, con lo slug usato negli URL |
| `GET https://cup24.it/c/{città}/{id prestazione}/` | Risultati di una prestazione in una città, generati dal server in HTML |
| `GET https://cup24.it/search/{id},{id}/` con cookie `lat`, `lng` | Risultati di più analisi di laboratorio prenotate insieme («Componi il tuo esame») |
| `GET https://cup24.it/sede/{id}[/{id prestazione}]`, `GET https://cup24.it/medico/{id}` | Disponibilità di una struttura o di un medico, con le stesse card |
| `POST` su ognuna di queste URL, form `page`, `when`, `sort` (`sort:price`, `sort:where`) | Pulsante «Altre date», filtri per data e ordinamento |
| `POST https://cup24.it/messages/options` con `id` dello slot | Riquadro «Scegli data e ora»: risposta JSON con l'HTML degli orari del giorno |
| `POST` sulla stessa URL con `who`, `what`, `where`, `when`, `mode=next` | Pulsante «Successivo»: il giorno disponibile seguente della stessa agenda; `no_slot: true` quando non ce ne sono più |
| `GET https://cup24.it/prestazione/{id}/` | Scheda della prestazione: FAQ in JSON-LD e tabella dei prezzi minimi e massimi per città |
| `GET https://cup24.it/what/{id pacchetto}/package_list` | Analisi incluse in un pacchetto check-up, in JSON |

Nella pagina dei risultati ogni card è una struttura in un giorno: gli orari liberi sono nell'attributo `title="Orari: …"`, indirizzo, coordinate e data sono in un oggetto JSON passato a `window.slotAddressPoints.push(…)`, e l'id dello slot è nel `data-id` del pulsante «Scegli orario e Prenota». Il server legge questi dati; se il sito cambia struttura, il parser va aggiornato (`npm test` lo verifica su copie ridotte di risposte reali, `npm run smoke` sul sito vero).

### La prenotazione (non implementata)

Ricostruita dal codice del sito e osservata fino alla scelta dell'orario, senza confermare:

1. «Scegli orario e Prenota» apre il riquadro degli orari (`/messages/options`); scegliere un orario non manda richieste.
2. «Conferma» manda `POST /cart/update` con `slotid` e `freeslotid` (l'orario scelto) e porta a `/cart/checkout`. Per le analisi passa anche `whatids`.
3. Il checkout chiede nome, email, telefono e codice fiscale, controlla l'utente (`api2…/v2/check/user_behavior`) e la disponibilità presso la struttura (`/cart/check_availability`), poi il pagamento: carta, PayPal, Stripe (Google Pay, Apple Pay), Scalapay, pagamento in sede, coupon o credito welfare.
4. Dopo l'ordine il sito controlla lo stato (`/order/recent_status`); spostamenti e rimborsi passano da `/lib/reschedule.php` e `/lib/refund.php`.

Il server si ferma prima del passo 2: aggiungere al carrello occupa l'orario per altri pazienti, e i passi successivi richiedono dati personali e pagamento.

## Sviluppo

```bash
npm run build   # compila in dist/
npm test        # test dei parser, offline
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
