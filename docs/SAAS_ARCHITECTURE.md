# NM Planner — Hosted subscription architecture

The self-hosted edition gives each person their own Supabase + Cloudflare deployment.

A future paid NM Planner service should use a different model: **one centrally managed application with many authenticated subscribers whose data is isolated by Row Level Security**.

## Recommended production shape

```text
Users
  ↓
NM Planner web/PWA (one production deployment)
  ↓
Supabase Auth
  ↓
Supabase Data API / PostgreSQL
  ├─ user-owned planner rows (RLS)
  ├─ profiles / onboarding
  └─ subscriptions / entitlements
  ↓
Server-side billing webhook
  ↓
Stripe or another payment provider
```

Do **not** create a separate Supabase account for every subscriber. That would make upgrades, support, billing, backups and security policy management unnecessarily difficult.

A dedicated project can still be offered later to enterprise customers who contractually require separate infrastructure.

## Tenant boundary

For the normal consumer subscription service, the authenticated Supabase user UUID should remain the ownership boundary.

Every user-owned row should have a `user_id` (or equivalent tenant/user ownership key) and RLS must restrict it to the authenticated user.

The current planner already follows this pattern in its core tables, but a hosted launch needs a deliberate multi-user security test across every table/RPC.

Never rely on a frontend email check for tenant isolation.

## Authentication

For hosted production:

- remove the one-person `VITE_ALLOWED_EMAIL` restriction;
- allow normal account creation/sign-in;
- use Supabase Auth providers you intend to support;
- configure production redirect URLs tightly;
- decide account deletion/recovery/MFA policies;
- validate all privileged server actions independently of browser state.

Do not use editable `user_metadata` as an authorization source. Store authoritative entitlements in the database or trusted app metadata.

## Billing and entitlements

A minimal hosted billing model normally needs tables conceptually similar to:

```text
profiles
  user_id
  display_name
  onboarding_state

billing_customers
  user_id
  provider_customer_id

subscriptions
  user_id
  provider_subscription_id
  plan_code
  status
  current_period_end
  cancel_at_period_end
  updated_at
```

Payment-provider secret keys must live only on a trusted backend such as a Supabase Edge Function or Cloudflare Worker.

Typical flow:

1. user signs up;
2. server creates/links a billing customer;
3. user completes hosted checkout;
4. payment provider sends a signed webhook;
5. backend verifies the webhook signature;
6. backend updates the trusted subscription/entitlement row;
7. application reads that entitlement to enable paid features.

The browser must never be able to make itself "paid" by editing a client-visible field.

## Plans and feature gates

Start with a small entitlement model, for example:

- Free / trial
- Individual
- Pro

Feature gates can later cover things such as:

- historical Insights depth
- calendar imports
- advanced exports
- AI-assisted planning
- long-term archive/retention
- team/shared planning, if added

Keep billing state separate from planner content.

## Generic data model before commercial launch

The self-hosted code retains historical canonical internal area IDs such as `BCU / Teaching` and `WorldSkills` for compatibility, while exposing configurable display names.

Before a broad SaaS launch, migrate this to a truly generic model:

```text
focus_areas
  id
  user_id
  name
  type
  weekly_target
  daily_target
  color
  sort_order
```

Tasks should reference a focus-area ID rather than institution-specific canonical strings. This is one of the most important productisation changes before a general audience launch.

## Environments

Use separate infrastructure:

- development Supabase + Cloudflare
- staging Supabase + Cloudflare
- production Supabase + Cloudflare

Never test destructive migrations against production first.

Use migration-controlled schema changes and automated smoke tests before promoting releases.

## Security and privacy before accepting subscriptions

A commercial hosted service needs more than working RLS:

- two-user/tenant isolation tests for every table and RPC
- least-privilege database grants
- review of SECURITY DEFINER functions
- server-side rate limiting/abuse controls where appropriate
- data export
- account/data deletion workflow
- privacy policy
- terms of service
- cookie/analytics disclosure if applicable
- retention policy
- incident-response process
- backup/restore testing
- monitoring and alerting
- secret rotation process
- support/contact route

For UK/EU users, design GDPR processes deliberately, including access/export, deletion, retention and processor/subprocessor documentation.

## Backups

A hosted service should not depend on users manually downloading backups.

Use provider backups plus tested application-level export/restore. Define recovery objectives before claiming data protection guarantees.

If users can import calendar data, retain only what NM Planner needs for planning and avoid storing message bodies, attendee details, meeting secrets or provider tokens unless a future feature genuinely requires them.

## Scaling

Do not prematurely split every user into a separate database. PostgreSQL + RLS is designed to support many users in one project when queries/indexes are appropriate.

Possible later tiers:

- standard: shared production project, RLS isolation
- enterprise: dedicated project/database/region if contractually required

## Open-source + paid hosting

The self-hosted edition can remain open source while you charge for convenience, managed hosting, support and premium features.

This repository uses AGPL-3.0-or-later. As copyright owner, you can operate a paid hosted service and can choose a dual-licensing strategy for code you own. If you begin accepting substantial external contributions, decide early whether you need a contributor agreement that preserves future relicensing flexibility.

This document is an engineering/product architecture guide, not legal or tax advice.
