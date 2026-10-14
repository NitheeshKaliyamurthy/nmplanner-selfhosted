# Calendar import with Power Automate

NM Planner no longer accepts calendar data through a Supabase Edge Function.

The supported workflow is:

1. Use Power Automate to export a compact weekly calendar JSON file to OneDrive.
2. Open NM Planner.
3. Go to **Settings → Work / Personal / Other Calendars**.
4. Upload the generated `calendar.json`.
5. Review conflicts and classify imported commitments.

## Recommended Power Automate flow

Create a scheduled cloud flow that runs once each week.

A typical configuration is:

- Recurrence: Sunday morning
- Window: Monday 00:00 through the following Monday 00:00
- Outlook action: **Get calendar view of events (V3)**
- Save the result as a JSON file in OneDrive

Map each event to only these fields:

```json
{
  "external_event_id": "provider-event-id",
  "series_id": null,
  "title": "Example meeting",
  "starts_at": "2026-10-07T10:05:00+00:00",
  "ends_at": "2026-10-07T10:30:00+00:00",
  "is_all_day": false,
  "source_modified_at": "2026-10-05T13:35:15.0863188+00:00"
}
```

Do not include:

- email or meeting bodies
- attendee lists
- Teams meeting secrets or passcodes
- attachments
- access tokens
- refresh tokens
- Microsoft credentials

The browser importer limits uploads to a compact planning dataset and reconciles
the selected calendar range against existing imported events.

The imported provider identifier stored internally is
`microsoft_power_automate`. Reusable classification rules are stored separately
and remain user-owned through Supabase Row Level Security.
