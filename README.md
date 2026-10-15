# AION 2 GS / CP Sync

Keeps the **Gear Score** and **Combat Power** columns of the legion Google Sheet up to date,
using NCSOFT's official character API. Runs on GitHub Actions every 15 minutes, free.

How it works:
1. Reads IGN + Server from each tab listed in `config.js`.
2. Finds each character's ID once (via Shugo.gg) and remembers it in a hidden tab `_id_cache`.
3. Gets live GS/CP from NCSOFT for every character.
4. Writes the numbers back. Only GS, CP and the Updated Time columns are touched.

Rules:
- Success: new numbers and timestamp.
- Character not found: keeps the last good numbers; shows `Invalid IGN` only if it never had any.
- Network problem: leaves the row unchanged (tries again next run).
- Names containing `TBC`: `Invalid IGN`. Missing server: blank.
- If someone sorts or inserts rows during a run, affected rows are left alone and fixed next run.
- If a tab's headers don't match `config.js` (Server / Gear Score / Combat Power), that tab is skipped, so moved columns never get overwritten.

---

## Setup (about 15 minutes, once)

### 1. Create a Google service account (the "robot" that edits the sheet)

1. Go to <https://console.cloud.google.com/> (sign in with any Google account).
2. Top bar → project dropdown → **New Project** → name it `aion2-sync` → **Create**, then select it.
3. Search **"Google Sheets API"** in the top search bar → open it → **Enable**.
4. Left menu → **IAM & Admin → Service Accounts** → **Create service account**.
   Name: `sheet-sync` → **Create and continue** → skip the role step → **Done**.
5. Click the new service account → **Keys** tab → **Add key → Create new key → JSON → Create**.
   A `.json` file downloads. Keep it private.
6. Copy the service account's email (looks like `sheet-sync@aion2-sync.iam.gserviceaccount.com`).

### 2. Share the sheet with it

Open the legion sheet → **Share** → paste that email → **Editor** → untick "Notify people" → **Share**.

### 3. Create the GitHub repo

1. <https://github.com/new> → name `aion2-gs-sync` → **Public** (unlimited free runs) → **Create repository**.
2. Click **uploading an existing file** and drag in everything from this folder
   **except** `node_modules` (if present). Make sure the `.github` folder is included.
   - If the `.github` folder doesn't upload (hidden folder), instead click **Add file → Create new file**,
     type `.github/workflows/sync.yml` as the name, and paste the contents of that file.
3. **Commit changes**.

### 4. Add the two secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `SHEET_ID` | The ID from the sheet URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit` |
| `GOOGLE_CREDENTIALS` | Open the downloaded `.json` key in Notepad, copy **everything**, paste |

Secrets are encrypted; they never show in the code or logs, even in a public repo.

### 5. First run

Repo → **Actions** tab → (if asked, enable workflows) → **Sync GS / CP** → **Run workflow**.

- Tick **Dry run** the first time to check everything without writing. Then run again normally.
- Click the run → **sync** to see the full log. The first run looks up every character's ID
  (slower); after that each run takes well under a minute.

### 6. Turn off the old Apps Script timer

Otherwise both will write to the sheet. In the sheet: **Extensions → Apps Script → Triggers**
(alarm-clock icon) → delete the `refreshAll` and `onEditRefresh` triggers.

---

## Changing things

- **Columns moved / tabs renamed:** edit `config.js` on GitHub (pencil icon) and commit.
- **How often:** edit the `cron` line in `.github/workflows/sync.yml`.
  `*/15 * * * *` = every 15 min, `*/5 * * * *` = every 5 min (GitHub's minimum).
  Private repos get 2,000 free minutes/month, which fits every 30 min (`*/30`) but not more often.
- **A character was deleted and recreated with the same name:** it's detected and re-looked-up
  automatically. To force a full refresh of IDs, delete the rows in the hidden `_id_cache` tab.

## Good to know

- GitHub pauses scheduled workflows in public repos with no commits for 60 days. You'll get an
  email; re-enable from the Actions tab (or make any small commit).
- Scheduled runs can start a few minutes late when GitHub is busy.
- If a run fails completely, GitHub emails the repo owner.

## Running locally (optional)

```bash
npm install
SHEET_ID=... GOOGLE_CREDENTIALS="$(cat key.json)" DRY_RUN=1 node src/index.js
npm test
```
