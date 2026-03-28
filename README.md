# OpenClaw Dashboard (Supabase)

This dashboard now uses Supabase for:
- Email/password authentication
- Persistent data for projects, tasks, issues, agents, tags, and calendar events

## 1) Configure environment

Fill in your Supabase credentials:

- `.env.local`
- `.env.example` (template)

Required keys:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

## 2) Create database schema

In your Supabase SQL editor, run:

- `supabase/schema.sql`

This creates all required tables and enables RLS policies scoped to each authenticated user.

If you already ran an older schema version, run the latest `supabase/schema.sql` again to apply the `resolved_at` columns used by resolved task/issue grouping.

## 3) Enable Auth

In Supabase Auth settings:
- Enable Email provider
- Enable Email + Password sign in
- Configure email confirmation behavior as desired

## 4) Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Notes

- The dashboard is no longer localStorage-backed mock data.
- Auth is active. You must sign in to access the dashboard.
- OpenClaw gateway integration is intentionally left for a later step.
