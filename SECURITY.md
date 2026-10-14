# Security policy

## Supported release

Security fixes are targeted at the latest published NM Planner self-hosted release.

## Report a vulnerability

Please do not open a public issue containing credentials, private planner data or a working exploit.

For a future public release, configure GitHub **Private vulnerability reporting** for the repository. Use that channel for security reports. Until it is enabled, contact the repository owner privately through a channel published on the GitHub profile.

Include:

- affected version/commit;
- affected component;
- reproduction steps;
- realistic impact;
- whether any real user data was accessed.

Do not include unrelated personal data.

## Secrets

NM Planner's frontend may contain:

- Supabase Project URL
- Supabase publishable/anon key

Those are client configuration values and must still be protected by correctly configured RLS and database grants.

Never expose:

- Supabase secret/service-role key
- database password/connection string
- Google OAuth client secret
- GitHub access tokens
- payment-provider secret keys
- private backup files

If a secret is accidentally committed, deleting the line in a later commit is not sufficient. Rotate/revoke the secret and remove it from history where appropriate.

## Data isolation

Self-hosted installations should keep RLS enabled.

For a shared/multi-user deployment, verify with at least two test accounts that user A cannot select, update or delete user B's rows.

Do not weaken RLS to fix a frontend permission error.

## Dependency/runtime policy

Keep externally loaded browser libraries pinned to explicit versions. Do not silently replace pinned production dependencies with floating `latest` URLs.

Run:

```bash
npm run check
npm run build
```

before release.

## Backups

Planner backups can contain sensitive task titles, schedules and wellbeing information. Store them privately and delete obsolete copies according to your own retention policy.
