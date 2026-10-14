# Contributing to NM Planner

Thanks for your interest in NM Planner.

## Before changing code

1. create a branch;
2. keep changes focused;
3. preserve Row Level Security and ownership checks;
4. do not add secret/service-role keys to frontend code;
5. do not add new high-frequency polling when an event/cached-state approach can be used.

Run:

```bash
npm run check
npm run build
```

before proposing a change.

## Database changes

Use a new numbered SQL migration for schema changes. Never rewrite an already-released migration for an existing installation.

For any new user-data table:

- enable and force RLS where appropriate;
- create ownership policies;
- grant only required privileges to `authenticated`;
- do not grant broad access merely to make a request work.

## Product compatibility

The current self-hosted edition retains historical canonical area IDs for compatibility. User-facing names should use configurable display labels rather than introducing another hard-coded employer/project name.

## Licensing of contributions

This project is distributed under AGPL-3.0-or-later.

The project owner may later offer a separately licensed hosted/commercial edition. Before accepting substantial third-party contributions, the project may introduce a Contributor Licence Agreement or another contribution policy to preserve clear licensing rights. Please do not assume that a pull request has been accepted until it is explicitly merged.
