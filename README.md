# NM Planner

NM Planner is an installable weekly planning application built around the Eisenhower Matrix, protected capacity, reusable routines, calendar commitments and planning insights.

This repository is the **self-hosted edition**. Each person deploys their own copy and owns their own Supabase database and Cloudflare deployment. No NM Planner data is shared with the repository owner.

## What it includes

- Q1/Q2/Q3/Q4 planning and weekly scheduling
- optional start times and a 24-hour daily time map
- configurable Primary Work and Additional Work labels
- Research, Family/Home and Personal Time analysis
- multi-area tasks and split-across-week work
- capacity protection plus deliberate Urgent / Overtime
- end-of-day review, rescheduling reasons and follow-up history
- planned-vs-actual execution analytics
- sleep sessions, walking and workload balance
- reusable routines: Home → Work (90m), Work → Home (90m), School Run (30m), Personal Time (60m), Tea (30m), Breakfast (30m), Lunch (30m), Dinner (60m)
- compact calendar import from a Power Automate `calendar.json`
- printable weekly/matrix reports and JPG Insights exports
- Supabase authentication and Row Level Security
- Progressive Web App installation on supported desktop/mobile browsers

## Deployment model

For personal/self-hosted use, every user should have their own:

1. GitHub repository copied from this project
2. Supabase project
3. Google OAuth credentials
4. Cloudflare Pages project
5. environment variables

This gives each installation a separate database, authentication configuration and hosting account.

## Quick start

The full beginner-friendly guide is in **[docs/SELF_HOSTING_SETUP.md](docs/SELF_HOSTING_SETUP.md)**.

At a high level:

1. Create a Supabase project.
2. Run `database/install.sql` once in the Supabase SQL Editor.
3. Configure Google sign-in in Google Cloud and Supabase Auth.
4. Create a Cloudflare Pages project from your GitHub copy.
5. Add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
   - optionally `VITE_ALLOWED_EMAIL`
6. Build with `npm run build`; publish `dist/`.
7. Open the deployed URL and sign in.

> Never put a Supabase secret/service-role key, database password or Google client secret in frontend environment variables.

## Environment variables

Copy `.env.example` for local use:

```env
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
VITE_ALLOWED_EMAIL=
```

`VITE_ALLOWED_EMAIL` is optional. For a one-person deployment you can set it to your email address. Leave it blank for multiple authenticated users. It is only a UI gate; Supabase RLS is the real data-isolation boundary.

## Calendar import

The supported calendar path is intentionally simple and does not require Microsoft Graph credentials in NM Planner:

**Outlook → Power Automate → OneDrive JSON file → NM Planner browser upload**

See **[docs/POWER_AUTOMATE_CALENDAR_SYNC.md](docs/POWER_AUTOMATE_CALENDAR_SYNC.md)**.

The importer accepts only compact planning fields and does not need email bodies, attendee lists, Teams passcodes, attachments or Microsoft access tokens.

## Database

The source-of-truth migrations are the numbered files in `database/`.

For a brand-new installation, use:

```text
database/install.sql
```

For an existing installation, apply only newly added numbered migrations in order.

Current release schema level: **035**.

## Local verification

Requires Node.js 22 or later.

```bash
npm run check
npm run build
```

The deployable static site is created in `dist/`.

## Updating

Before an update, create an NM Planner backup. Then pull the new version, read the release notes, apply any new numbered database migrations, and redeploy.

The existing Full Backup v2 covers the core planner/task history, planner settings, legacy wellbeing records and walking records. Calendar data is designed to be re-imported from its source. Timed sleep-session backup coverage should be checked against the release notes before relying on a backup as a complete account export.

## Security

Read **[SECURITY.md](SECURITY.md)** before deployment. The most important rule is simple: frontend code may contain the Supabase **publishable** key, but never a secret/service-role key.

## Future hosted/subscription edition

A subscription service should not create one Supabase account for every subscriber. The appropriate model is a centrally operated application with authenticated users separated by RLS and billing entitlements.

See **[docs/SAAS_ARCHITECTURE.md](docs/SAAS_ARCHITECTURE.md)**.

## Project layout

```text
public/       static PWA application
database/     Supabase migrations and fresh-install script
scripts/      build and regression checks
docs/         setup, behaviour and architecture documentation
dist/         generated build output (not the source of truth)
```

## Licence

NM Planner self-hosted edition is released under **AGPL-3.0-or-later**. See [LICENSE](LICENSE).

Copyright © 2026 NitheeshKaliyamurthy.
