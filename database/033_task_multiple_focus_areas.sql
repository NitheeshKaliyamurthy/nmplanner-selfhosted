-- Store optional proportional focus-area allocations for tasks that span
-- more than one area. The existing tasks.area column remains the primary
-- backwards-compatible area used by legacy capacity safeguards.

begin;

alter table public.tasks
  add column if not exists area_allocations jsonb;

alter table public.tasks
  drop constraint if exists tasks_area_allocations_check;

alter table public.tasks
  add constraint tasks_area_allocations_check
  check (
    area_allocations is null
    or jsonb_typeof(area_allocations) = 'object'
  );

commit;
