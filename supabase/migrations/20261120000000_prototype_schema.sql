-- =====================================================================
-- Project Hamster: database structure for the PROTOTYPE Supabase project
-- ---------------------------------------------------------------------
-- How to use: open the NEW Supabase project -> SQL Editor -> New query,
-- paste this whole file, click Run.
--
-- This file was rebuilt by reading the app's code (src/services/*.ts),
-- because the original project has no migration files in the repo.
-- It creates every table, column, storage bucket and permission rule the
-- app uses. Column types and security rules are best guesses, so compare
-- with the real project's Table Editor -> "Definition" if something
-- behaves differently.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. PROFILES: one row per user (customer or veterinarian)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  email       text,
  role        text not null default 'customer'
              check (role in ('customer', 'veterinarian')),
  created_at  timestamptz not null default now()
);

-- When someone signs up, copy their name/role/email into profiles automatically.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    new.email,
    case
      when lower(coalesce(new.raw_user_meta_data ->> 'role', '')) = 'veterinarian'
        then 'veterinarian'
      else 'customer'
    end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Small helper used by the security rules below: "is the logged-in user a vet?"
create or replace function public.is_vet()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'veterinarian'
  );
$$;


-- ---------------------------------------------------------------------
-- 2. HAMSTERS: patient profiles, owned by a customer
-- ---------------------------------------------------------------------
create table if not exists public.hamsters (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  hamster_name   text not null,
  species_breed  text,
  weight_grams   numeric,
  age_months     integer,
  gender         text,
  image_url      text,
  created_at     timestamptz not null default now()
);
create index if not exists hamsters_owner_id_idx on public.hamsters (owner_id);


-- ---------------------------------------------------------------------
-- 3. VET_AVAILABILITY: time slots a vet opens for booking
-- ---------------------------------------------------------------------
create table if not exists public.vet_availability (
  id                uuid primary key default gen_random_uuid(),
  vet_id            uuid not null references auth.users (id) on delete cascade,
  slot_date         date not null,
  start_time        time not null,
  end_time          time not null,
  max_capacity      integer not null default 1,
  current_bookings  integer not null default 0,
  created_at        timestamptz not null default now()
);
create index if not exists vet_availability_vet_date_idx
  on public.vet_availability (vet_id, slot_date);


-- ---------------------------------------------------------------------
-- 4. APPOINTMENTS
-- ---------------------------------------------------------------------
create table if not exists public.appointments (
  id                  uuid primary key default gen_random_uuid(),
  hamster_id          uuid not null references public.hamsters (id) on delete cascade,
  owner_id            uuid not null references auth.users (id) on delete cascade,
  vet_id              uuid references auth.users (id) on delete set null,
  availability_id     uuid references public.vet_availability (id) on delete set null,
  appointment_date    timestamptz not null,
  appointment_end_at  timestamptz,
  reason_for_visit    text,
  status              text not null default 'scheduled',
  created_at          timestamptz not null default now()
);
create index if not exists appointments_owner_id_idx on public.appointments (owner_id);
create index if not exists appointments_vet_id_idx on public.appointments (vet_id);
create index if not exists appointments_hamster_id_idx on public.appointments (hamster_id);

-- Keep vet_availability.current_bookings up to date when appointments are booked.
create or replace function public.bump_current_bookings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.availability_id is not null then
    update public.vet_availability
      set current_bookings = current_bookings + 1
      where id = new.availability_id;
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_bump_bookings on public.appointments;
create trigger appointments_bump_bookings
  after insert on public.appointments
  for each row execute function public.bump_current_bookings();


-- ---------------------------------------------------------------------
-- 5. MEDICAL_RECORDS: the vet's exam for one appointment
-- ---------------------------------------------------------------------
create table if not exists public.medical_records (
  id                          uuid primary key default gen_random_uuid(),
  appointment_id              uuid unique references public.appointments (id) on delete cascade,
  hamster_id                  uuid references public.hamsters (id) on delete cascade,
  vet_id                      uuid references auth.users (id) on delete set null,
  weight                      numeric,
  temperature                 numeric,
  heart_rate                  numeric,
  physical_examination_notes  text,
  confirmed_symptoms          jsonb,
  confirmed_diagnosis         text,
  suggested_treatment         text,
  status                      text not null default 'pending_review',
  created_at                  timestamptz not null default now()
);
create index if not exists medical_records_hamster_id_idx on public.medical_records (hamster_id);


-- ---------------------------------------------------------------------
-- 6. MEDICAL_RECORD_MEDIA: uploaded audio (and other media) per record
-- ---------------------------------------------------------------------
create table if not exists public.medical_record_media (
  id                 uuid primary key default gen_random_uuid(),
  medical_record_id  uuid not null references public.medical_records (id) on delete cascade,
  media_type         text not null,
  file_url           text not null,
  description        text,
  uploaded_by        uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists medical_record_media_record_idx
  on public.medical_record_media (medical_record_id);


-- ---------------------------------------------------------------------
-- 7. TRANSCRIPTIONS: speech-to-text of an audio file
-- ---------------------------------------------------------------------
create table if not exists public.transcriptions (
  id                    uuid primary key default gen_random_uuid(),
  media_id              uuid not null references public.medical_record_media (id) on delete cascade,
  raw_transcript        text,
  corrected_transcript  text,
  transcription_model   text,
  language              text,
  status                text not null default 'pending'
                        check (status in ('pending', 'processing', 'completed', 'failed')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists transcriptions_media_id_idx on public.transcriptions (media_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists transcriptions_set_updated_at on public.transcriptions;
create trigger transcriptions_set_updated_at
  before update on public.transcriptions
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------
-- 8. AI_ANALYSIS: what the AI pulled out of a transcript
-- ---------------------------------------------------------------------
create table if not exists public.ai_analysis (
  id                          uuid primary key default gen_random_uuid(),
  transcription_id            uuid references public.transcriptions (id) on delete cascade,
  medical_record_id           uuid references public.medical_records (id) on delete cascade,
  extracted_symptoms          jsonb,
  extracted_observations      jsonb,
  predicted_diagnosis         jsonb,
  suggested_diagnostic_tests  jsonb,
  suggested_treatment         jsonb,
  additional_notes            text,
  llm_provider                text,
  llm_model                   text,
  prompt_version              text,
  status                      text not null default 'pending'
                              check (status in ('pending', 'processing', 'completed', 'failed')),
  reviewed_by                 uuid references auth.users (id) on delete set null,
  reviewed_at                 timestamptz,
  created_at                  timestamptz not null default now()
);
create index if not exists ai_analysis_transcription_idx on public.ai_analysis (transcription_id);
create index if not exists ai_analysis_record_idx on public.ai_analysis (medical_record_id);


-- ---------------------------------------------------------------------
-- 9. FECAL_EXAMINATIONS
-- (the app stores the medical record's id in medical_record_test_id)
-- ---------------------------------------------------------------------
create table if not exists public.fecal_examinations (
  id                       uuid primary key default gen_random_uuid(),
  medical_record_test_id   uuid not null references public.medical_records (id) on delete cascade,
  sample_collected_at      timestamptz,
  sample_condition         text,
  stool_color              text,
  stool_consistency        text,
  stool_shape              text,
  stool_size               text,
  mucus_present            boolean,
  blood_present            boolean,
  undigested_food_present  boolean,
  examination_method       text,
  microscopic_findings     text,
  parasite_detected        boolean,
  parasite_name            text,
  parasite_quantity        text,
  overall_result           text,
  veterinarian_notes       text,
  reviewed_by              uuid references auth.users (id) on delete set null,
  completed_at             timestamptz,
  fecal_images             text[] not null default '{}',
  created_at               timestamptz not null default now()
);
create index if not exists fecal_examinations_record_idx
  on public.fecal_examinations (medical_record_test_id);


-- =====================================================================
-- SECURITY RULES (Row Level Security)
-- Customers see/edit their own hamsters and appointments.
-- Vets can see patients and write medical records.
-- =====================================================================
alter table public.profiles             enable row level security;
alter table public.hamsters             enable row level security;
alter table public.vet_availability     enable row level security;
alter table public.appointments         enable row level security;
alter table public.medical_records      enable row level security;
alter table public.medical_record_media enable row level security;
alter table public.transcriptions       enable row level security;
alter table public.ai_analysis          enable row level security;
alter table public.fecal_examinations   enable row level security;

-- Helper: "does the logged-in user own the hamster on this medical record?"
create or replace function public.owns_medical_record(record_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.medical_records mr
    join public.hamsters h on h.id = mr.hamster_id
    where mr.id = record_id and h.owner_id = auth.uid()
  );
$$;

-- PROFILES: any logged-in user can read names (customers see vet names and
-- vice versa); you can only edit your own.
drop policy if exists "profiles: logged-in users can read" on public.profiles;
create policy "profiles: logged-in users can read" on public.profiles
  for select to authenticated using (true);
drop policy if exists "profiles: users update their own" on public.profiles;
create policy "profiles: users update their own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- HAMSTERS: owners manage their own; vets can read all.
drop policy if exists "hamsters: owners manage their own" on public.hamsters;
create policy "hamsters: owners manage their own" on public.hamsters
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "hamsters: vets can read" on public.hamsters;
create policy "hamsters: vets can read" on public.hamsters
  for select to authenticated using (public.is_vet());

-- VET_AVAILABILITY: everyone logged in can see slots; vets manage their own.
drop policy if exists "availability: logged-in users can read" on public.vet_availability;
create policy "availability: logged-in users can read" on public.vet_availability
  for select to authenticated using (true);
drop policy if exists "availability: vets manage their own" on public.vet_availability;
create policy "availability: vets manage their own" on public.vet_availability
  for all to authenticated using (vet_id = auth.uid() and public.is_vet())
  with check (vet_id = auth.uid() and public.is_vet());

-- APPOINTMENTS: owners book and see their own; the assigned vet can see and update.
drop policy if exists "appointments: owners read their own" on public.appointments;
create policy "appointments: owners read their own" on public.appointments
  for select to authenticated using (owner_id = auth.uid());
drop policy if exists "appointments: owners book for their hamsters" on public.appointments;
create policy "appointments: owners book for their hamsters" on public.appointments
  for insert to authenticated with check (
    owner_id = auth.uid()
    and exists (select 1 from public.hamsters h where h.id = hamster_id and h.owner_id = auth.uid())
  );
drop policy if exists "appointments: assigned vet reads" on public.appointments;
create policy "appointments: assigned vet reads" on public.appointments
  for select to authenticated using (vet_id = auth.uid());
drop policy if exists "appointments: assigned vet updates" on public.appointments;
create policy "appointments: assigned vet updates" on public.appointments
  for update to authenticated using (vet_id = auth.uid()) with check (vet_id = auth.uid());

-- MEDICAL RECORDS + related tables: vets do everything; owners can read
-- records for their own hamsters.
drop policy if exists "medical_records: vets full access" on public.medical_records;
create policy "medical_records: vets full access" on public.medical_records
  for all to authenticated using (public.is_vet()) with check (public.is_vet());
drop policy if exists "medical_records: owners read" on public.medical_records;
create policy "medical_records: owners read" on public.medical_records
  for select to authenticated using (public.owns_medical_record(id));

drop policy if exists "media: vets full access" on public.medical_record_media;
create policy "media: vets full access" on public.medical_record_media
  for all to authenticated using (public.is_vet()) with check (public.is_vet());

drop policy if exists "transcriptions: vets full access" on public.transcriptions;
create policy "transcriptions: vets full access" on public.transcriptions
  for all to authenticated using (public.is_vet()) with check (public.is_vet());

drop policy if exists "ai_analysis: vets full access" on public.ai_analysis;
create policy "ai_analysis: vets full access" on public.ai_analysis
  for all to authenticated using (public.is_vet()) with check (public.is_vet());

drop policy if exists "fecal: vets full access" on public.fecal_examinations;
create policy "fecal: vets full access" on public.fecal_examinations
  for all to authenticated using (public.is_vet()) with check (public.is_vet());
drop policy if exists "fecal: owners read" on public.fecal_examinations;
create policy "fecal: owners read" on public.fecal_examinations
  for select to authenticated using (public.owns_medical_record(medical_record_test_id));


-- =====================================================================
-- STORAGE BUCKETS (where uploaded files live)
-- =====================================================================
insert into storage.buckets (id, name, public)
values
  ('hamster-images', 'hamster-images', true),   -- hamster photos (public links)
  ('audio',          'audio',          false),  -- exam recordings (private)
  ('fecal_images',   'fecal_images',   false)   -- fecal exam photos (private)
on conflict (id) do nothing;

-- hamster-images: files go in a folder named after the owner's user id.
drop policy if exists "hamster-images: owners upload" on storage.objects;
create policy "hamster-images: owners upload" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'hamster-images' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "hamster-images: owners delete" on storage.objects;
create policy "hamster-images: owners delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'hamster-images' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- audio: only vets can upload and listen.
drop policy if exists "audio: vets read" on storage.objects;
create policy "audio: vets read" on storage.objects
  for select to authenticated using (bucket_id = 'audio' and public.is_vet());
drop policy if exists "audio: vets upload" on storage.objects;
create policy "audio: vets upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'audio' and public.is_vet());
drop policy if exists "audio: vets delete" on storage.objects;
create policy "audio: vets delete" on storage.objects
  for delete to authenticated using (bucket_id = 'audio' and public.is_vet());

-- fecal_images: vets manage; owners can view photos for their own hamster's record.
-- (files go in a folder named after the medical record id)
drop policy if exists "fecal_images: vets manage" on storage.objects;
create policy "fecal_images: vets manage" on storage.objects
  for all to authenticated
  using (bucket_id = 'fecal_images' and public.is_vet())
  with check (bucket_id = 'fecal_images' and public.is_vet());
drop policy if exists "fecal_images: owners read" on storage.objects;
create policy "fecal_images: owners read" on storage.objects
  for select to authenticated using (
    bucket_id = 'fecal_images'
    and exists (
      select 1
      from public.medical_records mr
      join public.hamsters h on h.id = mr.hamster_id
      where mr.id::text = (storage.foldername(name))[1]
        and h.owner_id = auth.uid()
    )
  );
