do $$begin raise exception 'do not run this file'; end$$;


--drop function public.skill_level_list(int, text);
create or replace function public.skill_level_list()
returns table (
    skill_level_number  int,
    skill_level_name    text
)
as $$
    select
      skill_level_number, 
      skill_level_name
    from  public.skill_level
    order by
      skill_level_number;
$$ language sql stable;

revoke all on function public.skill_level_list()
  from public, authenticated, anon;
grant execute on function public.skill_level_list()
  to service_role;

