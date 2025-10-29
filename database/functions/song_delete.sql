do $$begin raise exception 'do not run this file'; end$$;


--drop function public.song_delete(int)
create or replace function public.song_delete(
  p_song_id int
)
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  delete from public.song as s
    where s.song_id = p_song_id;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function public.song_delete(int)
  from public, authenticated, anon;
grant execute on function public.song_delete(int)
  to service_role;

