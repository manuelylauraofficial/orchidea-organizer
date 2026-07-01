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
- Impostazioni spazio e membri

## PIN registrazione

Il PIN impostato è:

```txt
18062026
```

Il PIN viene richiesto nella schermata **Registrati**.
La protezione non è solo grafica: il file SQL crea un trigger su `auth.users`, quindi se qualcuno prova a registrarsi senza PIN o con PIN sbagliato, Supabase blocca la creazione dell'utente prima della conferma email.

Per aggiungerlo a un progetto Supabase già configurato, esegui nel SQL Editor:

```sql
supabase/signup_pin_18062026.sql
```

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
```

Attenzione: `VITE_SUPABASE_URL` non deve essere il link della dashboard Supabase. Deve finire con `.supabase.co`.

## Setup Supabase

Nel SQL Editor di Supabase esegui:

```sql
supabase/schema.sql
```

Poi crea/verifica il bucket Storage chiamato:

```txt
orchidea-documents
```

Lo schema prova a crearlo automaticamente, ma se Supabase blocca la creazione dal SQL Editor puoi crearlo manualmente da Storage.

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


## Redirect email Supabase dopo il deploy

Per evitare che la conferma email rimandi a `localhost`, imposta su Vercel anche:

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
