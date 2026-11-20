-- =====================================================================
-- Prototype starter data: appointment slots for every veterinarian
-- ---------------------------------------------------------------------
-- The app has no screen for vets to create time slots, so a brand-new
-- database has none and customers cannot book anything.
--
-- Run this in the PROTOTYPE project's SQL Editor AFTER you have created at
-- least one vet account. It adds 1-hour slots (9-12 and 1-5, Monday to
-- Friday) for the next 4 weeks. Safe to run again: it skips slots that
-- already exist, so run it again whenever you add a vet or run out of dates.
-- =====================================================================
insert into public.vet_availability (vet_id, slot_date, start_time, end_time, max_capacity)
select
  p.id,
  d.day::date,
  t.start_time,
  t.start_time + interval '1 hour',
  1
from public.profiles p
cross join generate_series(current_date, current_date + 27, interval '1 day') as d(day)
cross join (
  values (time '09:00'), (time '10:00'), (time '11:00'),
         (time '13:00'), (time '14:00'), (time '15:00'), (time '16:00')
) as t(start_time)
where p.role = 'veterinarian'
  and extract(isodow from d.day) between 1 and 5
  and not exists (
    select 1
    from public.vet_availability v
    where v.vet_id = p.id
      and v.slot_date = d.day::date
      and v.start_time = t.start_time
  );

-- Shows how many slots each vet now has.
select p.full_name as vet, count(v.id) as slots
from public.profiles p
left join public.vet_availability v on v.vet_id = p.id
where p.role = 'veterinarian'
group by p.full_name;
