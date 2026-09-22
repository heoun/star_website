-- Ring 2: the new backend's own tables, in their own schema so nothing in
-- public/ is touched. Additive only; safe to re-run.
--
-- To apply (dev "Star dev" project):
--   1. Paste this file into the Supabase SQL Editor and run it.
--   2. Settings -> API -> "Exposed schemas": add  backend  to the list.
--      (PostgREST refuses to serve a schema it is not told about.)

create schema if not exists backend;

create table if not exists backend.rentables (
  id         text primary key,
  kind       text not null default 'whole_unit' check (kind in ('whole_unit', 'room')),
  unit_ref   text,
  created_at timestamptz not null default now()
);

create table if not exists backend.listings (
  id            text primary key,
  property_id   text,
  unit_label    text not null default '',
  rentable_id   text not null references backend.rentables(id),
  rent          numeric not null default 0,
  available_on  date,
  status        text not null default 'draft'
                check (status in ('draft', 'published', 'rented', 'archived')),
  agent_user_id text,
  created_at    timestamptz not null default now()
);

create table if not exists backend.cases (
  id             text primary key,
  rentable_id    text not null references backend.rentables(id),
  listing_id     text not null references backend.listings(id),
  status         text not null default 'open'
                 check (status in ('open', 'in_review', 'sent_to_landlord', 'approved',
                                   'declined', 'lease_sent', 'executed', 'closed')),
  move_in_date   text,
  decline_reason text,
  created_at     timestamptz not null default now()
);
create index if not exists cases_rentable_status on backend.cases (rentable_id, status);

create table if not exists backend.case_members (
  case_id        text not null references backend.cases(id) on delete cascade,
  person_id      text not null,
  role           text not null check (role in ('primary', 'co_tenant', 'guarantor', 'occupant')),
  application_id text,
  primary key (case_id, person_id)
);

create table if not exists backend.applications (
  id              text primary key,
  case_id         text not null references backend.cases(id) on delete cascade,
  applicant_id    text not null,
  applicant_name  text not null default '',
  applicant_email text not null default '',
  status          text not null default 'draft'
                  check (status in ('draft', 'submitted', 'needs_info', 'complete', 'withdrawn')),
  answers         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists applications_case on backend.applications (case_id);

create table if not exists backend.screenings (
  application_id text primary key references backend.applications(id) on delete cascade,
  screening_id   text not null,
  status         text not null check (status in ('pending', 'complete', 'failed')),
  credit_score   integer,
  report_ref     text,
  updated_at     timestamptz not null default now()
);

create table if not exists backend.decisions (
  case_id    text primary key references backend.cases(id) on delete cascade,
  approved   boolean not null,
  decided_at timestamptz not null,
  contact_id text not null,
  note       text
);

create table if not exists backend.lease_versions (
  id                text primary key,
  case_id           text not null references backend.cases(id) on delete cascade,
  status            text not null default 'draft'
                    check (status in ('draft', 'sent', 'partially_signed', 'executed', 'voided')),
  values            jsonb not null default '{}'::jsonb,
  envelope_ref      text,
  executed_file_key text,
  created_at        timestamptz not null default now()
);
create index if not exists lease_versions_envelope on backend.lease_versions (envelope_ref);
create index if not exists lease_versions_case on backend.lease_versions (case_id);

-- Nothing reads these tables anonymously; the Worker uses the service role.
alter table backend.rentables      enable row level security;
alter table backend.listings       enable row level security;
alter table backend.cases          enable row level security;
alter table backend.case_members   enable row level security;
alter table backend.applications   enable row level security;
alter table backend.screenings     enable row level security;
alter table backend.decisions      enable row level security;
alter table backend.lease_versions enable row level security;

-- The same dev seed the memory adapter carries, so the smoke flow has a
-- listing to start from in either world.
insert into backend.rentables (id, kind) values ('rentable-dev-1', 'whole_unit')
  on conflict (id) do nothing;
insert into backend.listings (id, unit_label, rentable_id, rent, status)
  values ('listing-dev-1', '3C', 'rentable-dev-1', 2450, 'published')
  on conflict (id) do nothing;

-- Supabase grants nothing automatically outside public: without these the
-- exposed schema still answers "permission denied" for the service role.
grant usage on schema backend to service_role;
grant all on all tables in schema backend to service_role;
grant all on all sequences in schema backend to service_role;
alter default privileges in schema backend grant all on tables to service_role;
alter default privileges in schema backend grant all on sequences to service_role;
