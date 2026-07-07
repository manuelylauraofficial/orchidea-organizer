# Orchidea Organizer

App React frontend-only per organizzare Orchidea con più utenti tramite Supabase.

## Funzioni incluse

- Login e registrazione con Supabase Auth
- Registrazione protetta da PIN privato Orchidea
- Creazione spazio condiviso Orchidea
- Invito utenti tramite codice
- Dashboard generale
- Attività in stile bacheca/kanban
- Agenda condivisa
- Liste operative
- Note divise per cartelle
- Documenti con Supabase Storage
- Budget/spese
- Comunicazioni importanti
- Notifiche interne persistenti
- Notifiche push vere su telefono tramite Web Push + Service Worker + Supabase Edge Function
- Chat privata tra utenti con richiesta da accettare/rifiutare
- Manifest PWA e icona app da `public/image/icon.png`

## PIN registrazione

Il PIN impostato è:

```txt
18062026
```

Il PIN viene richiesto nella schermata **Registrati**.
La protezione non è solo grafica: il file SQL crea un trigger su `auth.users`, quindi se qualcuno prova a registrarsi senza PIN o con PIN sbagliato, Supabase blocca la creazione dell'utente prima della conferma email.

## Avvio locale

```bash
npm install
cp .env.example .env
npm run dev
```

Nel file `.env` inserisci:

```env
VITE_SUPABASE_URL=https://TUO-PROGETTO.supabase.co
VITE_SUPABASE_ANON_KEY=LA_TUA_ANON_KEY
VITE_APP_URL=https://orchidea-organizer.vercel.app
VITE_VAPID_PUBLIC_KEY=LA_TUA_CHIAVE_PUBBLICA_VAPID
```

Attenzione: `VITE_SUPABASE_URL` non deve essere il link della dashboard Supabase. Deve finire con `.supabase.co`.

## Setup Supabase

Nel SQL Editor di Supabase esegui:

```sql
supabase/schema.sql
```

Poi esegui anche:

```sql
supabase/web_push_chat.sql
```

Questo secondo file crea:

- `push_subscriptions`
- `app_notifications`
- `contact_requests`
- `direct_chats`
- `direct_messages`
- funzioni RPC per richiesta/accettazione chat
- policy RLS
- realtime sulle notifiche/chat

Poi crea/verifica il bucket Storage chiamato:

```txt
orchidea-documents
```

Lo schema prova a crearlo automaticamente, ma se Supabase blocca la creazione dal SQL Editor puoi crearlo manualmente da Storage.

## Notifiche push vere su telefono

Questa versione usa Web Push. Per farla funzionare servono chiave pubblica e privata VAPID.

Genera le chiavi sul PC:

```bash
npx web-push generate-vapid-keys
```

Ti verranno mostrate due chiavi:

```txt
Public Key:  ...
Private Key: ...
```

### Vercel

In Vercel → Project → Settings → Environment Variables aggiungi:

```env
VITE_VAPID_PUBLIC_KEY=LA_PUBLIC_KEY
```

Poi fai Redeploy.

### Supabase Edge Function

Deploy della funzione:

```bash
supabase functions deploy send-push-notification
```

Poi imposta i secrets della funzione:

```bash
supabase secrets set VAPID_PUBLIC_KEY="LA_PUBLIC_KEY"
supabase secrets set VAPID_PRIVATE_KEY="LA_PRIVATE_KEY"
supabase secrets set VAPID_SUBJECT="mailto:tua-email@dominio.it"
```

La funzione usa già anche:

```txt
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

che Supabase rende disponibili nell'ambiente delle Edge Functions.

### Procedura su telefono

1. Apri l'app online.
2. Su iPhone/Android aggiungila alla schermata Home.
3. Aprila dall'icona installata.
4. Premi il pulsante `📲` in alto.
5. Accetta le notifiche.

Da quel momento le notifiche possono arrivare anche con webapp chiusa, se il sistema operativo/browser non le blocca.

## Chat utenti

Nella scheda **Chat** puoi:

- cercare un utente per nome/email;
- inviare una richiesta chat;
- accettare o rifiutare le richieste ricevute;
- chattare solo dopo l'accettazione;
- ricevere notifiche push sui nuovi messaggi.

Nota: gli utenti devono avere già creato l'account con PIN e confermato la mail.

## Redirect email Supabase dopo il deploy

Per evitare che la conferma email rimandi a `localhost`, imposta su Vercel:

```env
VITE_APP_URL=https://orchidea-organizer.vercel.app
```

Poi in Supabase vai in **Authentication → URL Configuration** e imposta:

- **Site URL**: `https://orchidea-organizer.vercel.app`
- **Redirect URLs**:
  - `http://localhost:5173/**`
  - `https://orchidea-organizer.vercel.app/**`
  - eventuale dominio personalizzato, ad esempio `https://app.orchidea.../**`

L'app passa `emailRedirectTo` durante la registrazione, così il link di conferma email usa l'URL pubblico e non quello locale.

## Fix errore 403 su creazione spazio

Se premendo **Crea Orchidea** vedi in console:

```txt
POST /rest/v1/spaces?select=* 403 Forbidden
```

oppure se hai già installato una versione precedente, esegui nel SQL Editor:

```sql
supabase/fix_403_create_space.sql
```

La versione aggiornata usa la funzione `create_space_with_owner`, che crea lo spazio e aggiunge subito l'utente come proprietario, evitando il blocco RLS.

## Build

```bash
npm run build
```

## Deploy aggiornamenti

Dopo aver sostituito i file nel progetto:

```bash
git add .
git commit -m "Aggiunte push vere e chat utenti"
git push
```

Vercel pubblicherà automaticamente.

Dopo aver aggiornato l'icona, su iPhone/Android può servire rimuovere e reinstallare l'app dalla schermata Home per vedere subito la nuova icona.

## Update v8 - form puliti e modifica attività

- I form di aggiunta ora sono chiusi di default in Attività, Agenda, Liste, Note, Documenti, Budget, Messaggi e Chat.
- Ogni sezione ha un pulsante `+ Nuovo ...` che apre il form solo quando serve.
- Dopo il salvataggio il form si richiude automaticamente.
- Le attività pubblicate ora possono essere modificate dal pulsante `✎` sulla card.
- La chat ha un pulsante `+ Nuova richiesta chat` per non tenere sempre visibile la ricerca utenti.

## Update v9 - modifica agenda e diagnostica push

- Gli eventi in agenda ora possono essere modificati con il pulsante `✎`.
- Il pulsante `📲` ora salva il dispositivo e invia anche una notifica di test allo stesso telefono.
- L'invio push usa sempre il token della sessione Supabase, così la Edge Function riconosce correttamente l'utente.
- Se una notifica non parte, l'app mostra un messaggio invece di nascondere l'errore solo in console.
- Il service worker è stato aggiornato con claim immediato, icone assolute e click sulla notifica verso l'app.
- È stato rimosso `package-lock.json` generato con registry interno e aggiunto `.npmrc` con registry ufficiale npm per evitare errori Vercel tipo `applied-caas` / `ETIMEDOUT`.

Dopo questo update devi fare anche il redeploy della Edge Function, perché è cambiato il file:

```bash
supabase functions deploy send-push-notification
```

Poi controlla i secrets:

```bash
supabase secrets list
```

Devono esserci:

```txt
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT
```

Su Vercel deve esserci:

```env
VITE_VAPID_PUBLIC_KEY=LA_PUBLIC_KEY
```

Dopo il deploy, apri l'app dal telefono e premi `📲`: se tutto è configurato bene deve arrivare una notifica di test.
