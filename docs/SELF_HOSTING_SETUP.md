# NM Planner — Self-hosting setup

This guide assumes you are starting from scratch and have no existing NM Planner installation.

You will create four things:

1. your own GitHub copy of NM Planner;
2. your own Supabase database/authentication project;
3. a Google OAuth application for sign-in;
4. your own Cloudflare Pages deployment.

No database, password or account is shared with the original NM Planner installation.

---

## 1. Create your GitHub copy

On the public NM Planner repository, use **Fork** or **Use this template** if the template option is enabled.

Choose your own GitHub account as the owner.

You can keep your copy public or private. If it is public, never commit a `.env` file, private backup, database password, Supabase secret/service-role key or Google client secret.

The included `.gitignore` is intended to keep common local secrets/build output out of source control, but you are still responsible for checking commits before pushing.

---

## 2. Create a Supabase project

1. Create/sign in to a Supabase account.
2. Create a **new project**.
3. Choose a strong database password and store it in a password manager. NM Planner does not need this password in the browser.
4. Wait until the project is ready.

In Supabase, find the project's API information and copy:

- **Project URL**
- **Publishable key** (older projects may label the client key as an anon key)

The publishable key is intended for frontend use when RLS is correctly configured.

**Never use the secret/service-role key in NM Planner's frontend or Cloudflare public build variables.** A service-role/secret key bypasses RLS.

---

## 3. Install the NM Planner database

Open:

**Supabase → SQL Editor → New query**

Open `database/install.sql` from this repository, copy the complete contents into the SQL Editor, and run it once.

The installer contains the numbered schema migrations through the release's current schema level.

If you prefer to apply migrations individually, run only the numbered files in ascending order:

`001_...`, `002_...`, ... through `035_...`.

Do not run the `audit_*.sql` files as migrations. They are diagnostic tools.

### What the database install creates

It creates the planner's user-owned tables, policies, indexes, task lifecycle logic, settings, analytics history, calendar-import storage and wellbeing data.

Tables exposed through Supabase's Data API use RLS and explicit grants appropriate to the app. This is important because current Supabase projects may require explicit role grants in addition to RLS.

### Verify the install

In Supabase's Table Editor you should see planner tables such as:

- `tasks`
- `task_events`
- `task_reviews`
- `planner_settings`
- `wellbeing_daily`
- `walking_logs`
- `sleep_intervals`
- `external_calendar_events`
- `calendar_classification_rules`
- `calendar_sync_state`
- `monthly_summaries`

You should **not** need a `calendar_ingest_credentials` table. That belonged to a retired server-ingest design.

---

## 4. Configure Google sign-in

NM Planner currently uses Supabase Auth with Google OAuth.

### 4A. Create Google OAuth credentials

In Google Cloud Console:

1. create or select a Google Cloud project;
2. configure the OAuth consent screen if Google asks you to;
3. create an **OAuth Client ID** of type **Web application**;
4. add this Supabase callback as an authorised redirect URI:

```text
https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback
```

Replace `YOUR-PROJECT-REF` with your Supabase project reference.

Copy the Google **Client ID** and **Client Secret**. The Client Secret goes only into Supabase's provider configuration, never into the NM Planner repository or Cloudflare frontend variables.

### 4B. Enable Google in Supabase

Open:

**Supabase → Authentication → Providers → Google**

Enable Google and enter the Google Client ID and Client Secret.

Save the provider.

### 4C. Configure Auth URLs

You need the final Cloudflare URL for the finished production configuration. You can come back to this step after the first deployment.

In Supabase Authentication URL configuration, set:

- **Site URL**: your final NM Planner URL, e.g. `https://your-planner.pages.dev`
- add the same URL to permitted redirect URLs

For local testing, add the local origin you actually use.

---

## 5. Deploy with Cloudflare Pages

Create/sign in to a Cloudflare account.

Create a Pages project and connect your GitHub copy of NM Planner.

Use:

```text
Production branch: main
Build command: npm run build
Build output directory: dist
```

Use Node.js 22 or later if Cloudflare asks for a runtime version.

### Add Cloudflare environment variables

In the Pages project's build/deployment environment variables add:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
VITE_ALLOWED_EMAIL
```

Values:

```text
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your Supabase publishable key
VITE_ALLOWED_EMAIL=optional-person@example.com
```

For a private one-person installation, set `VITE_ALLOWED_EMAIL` to the Google email you will use.

For a multi-user installation, leave `VITE_ALLOWED_EMAIL` blank and rely on authentication + RLS for row isolation.

Trigger a new deployment after changing environment variables.

---

## 6. Finish the redirect configuration

After Cloudflare gives you the production URL:

1. put that URL into Supabase Auth's **Site URL**;
2. add it as an allowed redirect URL;
3. if your Google OAuth configuration needs an authorised JavaScript origin, add the same HTTPS origin there;
4. redeploy only if you changed NM Planner build variables.

Then open NM Planner and choose Google sign-in.

---

## 7. First-use checks

Before trusting the installation with important planning data:

1. sign in;
2. create a disposable task;
3. move it to a day and time;
4. complete it;
5. open Insights and verify the task appears;
6. add a sleep session and check the 24-hour map;
7. create a walking record;
8. test a reusable routine;
9. verify a normal Q1/Q2 capacity limit;
10. test Urgent / Overtime deliberately, then remove the test task;
11. sign out and back in;
12. create a backup from Settings.

If you intend to let more than one person use the same Supabase project, test with **two separate users** and confirm that neither account can see the other's tasks.

---

## 8. Install as an app (PWA)

NM Planner is a Progressive Web App.

In a supported Chromium browser, open the deployed site and use the browser's **Install app** / **Install NM Planner** option when offered.

On mobile, use the browser's add-to-home-screen/install flow.

The installed app still uses your Cloudflare deployment and your Supabase project; it is not a separate local database.

---

## 9. Optional: calendar import

NM Planner does not need Microsoft credentials in its frontend.

The supported pattern is:

**Outlook → Power Automate → OneDrive `calendar.json` → manual upload in NM Planner**

See `docs/POWER_AUTOMATE_CALENDAR_SYNC.md`.

If you do not use Outlook/Power Automate, simply ignore the calendar-import feature.

---

## 10. Updating later

Before updating:

1. export a backup;
2. note the highest database migration you have already applied.

Then:

1. update your GitHub copy;
2. apply only newer numbered database migrations;
3. redeploy Cloudflare;
4. verify login/tasks/Insights.

Never rerun destructive migrations merely because you are unsure. Check your migration history/notes first.

---

## Troubleshooting

| Problem | Check |
|---|---|
| App says configuration is missing | Cloudflare has `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, then redeploy |
| Google login returns a redirect error | Supabase callback URL in Google, plus correct Site URL/redirect URL in Supabase |
| Login succeeds but data queries fail | Confirm database installer completed, RLS policies and grants exist |
| Another account is blocked | Clear/omit `VITE_ALLOWED_EMAIL` for a multi-user deployment |
| Browser still shows an old build | Confirm latest Cloudflare deployment succeeded; close/reopen installed PWA |
| Calendar upload fails | Confirm JSON structure/size; use the compact fields in the calendar guide |
| A table says permission denied | Do not disable RLS; verify the relevant migration/grant was applied |
| You accidentally exposed a service-role/secret key | Rotate it immediately in Supabase, remove it from Git history/build variables, and redeploy |

---

## Security checklist

Before sharing your deployment:

- RLS remains enabled on user-data tables.
- Only a publishable/anon client key is in the browser.
- Google Client Secret exists only in Supabase's provider configuration.
- Database password is not committed.
- `.env` and backups are not committed.
- HTTPS is used in production.
- Supabase Auth redirect URLs are limited to URLs you control.
- Enable Supabase leaked-password protection if you later add password authentication.
