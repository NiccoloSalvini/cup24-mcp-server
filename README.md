# cup24-mcp-server

Server [MCP](https://modelcontextprotocol.io) **non ufficiale** per [cup24.it](https://cup24.it) (ex Cup Solidale): chiedi al tuo assistente AI dove fare un esame o una visita privata in Italia, quando e a che prezzo.

> «Trovami l'ecografia addome completo più economica a Firenze questa settimana»
> «Chi ha posto domani mattina per una visita cardiologica a Milano?»
> «Emocromo e glicemia insieme, dove costa meno a Roma?»
> «Come mi preparo a una risonanza e quanto costa di solito a Bologna?»
> «Ecco la foto dell'impegnativa: dove faccio tutto a Firenze con meno uscite possibili, entro il 15?»

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
| `cup24_plan_visits` | Pianifica più prestazioni insieme, per esempio tutte le voci di un'impegnativa. Restituisce fino a tre piani: **meno uscite** (stessa struttura e stesso giorno per più voci possibili, con orari suggeriti a 15 minuti l'uno dall'altro), **più economico** e **prima possibile**, ciascuno con totale, uscite e link per prenotare. Le analisi si fanno con un unico prelievo a prezzo combinato. Filtra per data massima e distanza |

### Dalla ricetta alla prenotazione

Dai all'assistente la foto o il testo dell'impegnativa. Per ogni voce cerca la prestazione con `cup24_search` e ti mostra l'abbinamento da confermare. Poi chiama `cup24_plan_visits`, che:

1. cerca ogni voce in città, ordinata per data, prezzo e distanza, per sapere quali strutture la offrono;
2. legge giorno per giorno i calendari delle strutture che offrono più voci, per trovare uscite che ne coprono diverse nello stesso giorno;
3. costruisce i piani scegliendo ogni volta la struttura e il giorno che coprono più voci rimaste.

Le analisi stanno quasi sempre in sedi di laboratorio separate, quindi con le analisi «tutto in un'uscita» è raro. L'abbinamento ricetta → prestazione resta il punto delicato: l'assistente deve sempre fartelo confermare. Gli orari suggeriti presumono 15 minuti per appuntamento.

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

### La prenotazione e l'annullamento (non implementati)

Ricostruiti dal codice del sito con REA e provati una volta su un account reale (un emocromo con pagamento in sede, prenotato e annullato subito il 26/10/2026):

1. «Prenota» o «Scegli orario e Prenota» apre il riquadro degli orari (`/messages/options`); per le analisi apre invece un riepilogo (`/messages/lab-options`). Scegliere un orario non manda richieste.
2. «Conferma» svuota il carrello e manda `POST /cart/update` con `slotid` e `freeslotid` (per le analisi anche `whatid`), poi porta a `/cart/checkout`.
3. Il checkout tiene l'orario per **10 minuti**. Prende nome, cognome, codice fiscale ed email dall'account e chiede il cellulare, l'accettazione delle condizioni e il consenso al trattamento dei dati sanitari. Pagamento: carta, Google Pay e Apple Pay (Stripe) o in sede. Il prezzo delle analisi include il costo del prelievo (es. 5 € + 4 €).
4. «Conferma prenotazione» valida i dati (codice fiscale, maggiore età, email) e manda in `POST` all'`action` del modulo tutto `#formCheckout` (`client_data[bill_to][…]`, `client_data[patient][…]`). Se la risposta tarda, il sito interroga `/order/recent_status` ogni 5 secondi per 90 secondi, mentre la struttura conferma. La risposta può chiedere un OTP sul cellulare o rimandare a Stripe; altrimenti porta a `/order/review/{id}`. Il codice manda anche una copia del modulo a un endpoint di log (`kibanaeu.cup24.it:8080`).
5. L'annullamento parte da «Le tue prenotazioni» (`/orders`): la X apre `/order/{id}/remove?u_info=…&jwt=…`, si sceglie un motivo (`company_decision`, `reservation_update`, `book_elsewhere`, `other` con testo) e si conferma due volte (`/messages/rimborso`). L'ultima conferma manda `POST /lib/refund.php` con `orderid`, `reason`, `reason_other`; la prenotazione passa a «Rimborsato» e arriva una mail. Gli spostamenti usano `/lib/reschedule.php`.

Il server resta in sola lettura: prenotare richiede l'account dell'utente, il suo cellulare con OTP, consensi espliciti e il pagamento, e ogni prova occupa un orario reale e manda mail alla struttura.

### Analizzare il sito con REA

Sul bundle intero (`index.js`, 1,2 MB minificati) l'analisi semantica di REA esaurisce la memoria anche con 8 GB. Il motivo è che tiene in uso più di 8 GB per un unico file da circa 312.000 nodi di sintassi. `scripts/rea-split.mjs` divide il bundle nei moduli webpack e il blocco d'ingresso in pezzi da circa 25 KB, separando il codice di cup24 (`app/`) dalle librerie (`vendor/`):

```bash
node scripts/rea-split.mjs "$(curl -s https://cup24.it/ | grep -o 'https://cdn01[^"]*/js/index.js' | head -1)" /tmp/cup24-rea
npx -y rea-agents@6.4.0 analyze-javascript-application /tmp/cup24-rea/app --max-heap-mb 4096
```

Così l'analisi di `app/` finisce in pochi secondi. Se REA segnala che un file «exceeds the parent's remaining result budget», analizza quel file da solo: il budget vale per l'intera esecuzione. Carrello, annullamento e checkout stanno in `entry-07.js` (le funzioni `Pi.*`) ed `entry-09.js` (i gestori dei click).

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
