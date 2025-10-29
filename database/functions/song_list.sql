do $$begin raise exception 'do not run this file'; end$$;


--drop function public.song_list(text, text);
create or replace function public.song_list(
  p_sort_column     text default 'composer_last_name',
  p_sort_direction  text default 'asc'
)
returns table (
  song_id               int,
  song_title            text,
  composer_first_name   text,
  composer_last_name    text,
  skill_level_number    int,
  skill_level_name      text,
  file_name             text,
  inserted_datetime     timestamptz,
  updated_datetime      timestamptz
)
language plpgsql
stable
as $$
declare
  order_clause text;
begin
  if p_sort_direction not in ('asc', 'desc') then
    raise exception 'Invalid sort_direction: %, must be "asc" or "desc"', p_sort_direction
      using errcode = '22023'; -- invalid_parameter_value
  end if;
  case p_sort_column
    when 'composer_last_name' then
      order_clause := format('s.composer_last_name %s, s.composer_first_name ASC, s.song_title ASC, s.skill_level_number ASC', p_sort_direction);
    when 'composer_first_name' then
      order_clause := format('s.composer_first_name %s, s.composer_last_name ASC, s.song_title ASC, s.skill_level_number ASC', p_sort_direction);
    when 'song_title' then
      order_clause := format('s.song_title %s, s.composer_last_name ASC, s.composer_first_name ASC, s.skill_level_number ASC', p_sort_direction);
    when 'skill_level_name', 'skill_level_number' then
      order_clause := format('s.skill_level_number %s, s.composer_last_name ASC, s.composer_first_name ASC, s.song_title ASC', p_sort_direction);
    when 'updated_datetime' then
      order_clause := format('s.updated_datetime %s, s.composer_last_name ASC, s.composer_first_name ASC, s.song_title ASC, s.skill_level_number ASC', p_sort_direction);
    when 'inserted_datetime' then
      order_clause := format('s.inserted_datetime %s, s.composer_last_name ASC, s.composer_first_name ASC, s.song_title ASC, s.skill_level_number ASC', p_sort_direction);
    when 'file_name' then
      order_clause := format('s.file_name %s', p_sort_direction);
    else
      order_clause := format('s.composer_last_name %s, s.composer_first_name ASC, s.song_title ASC, s.skill_level_number ASC'), p_sort_direction;
  end case;
  return query execute format(
    'select
       s.song_id,
       s.song_title,
       s.composer_first_name,
       s.composer_last_name,
       s.skill_level_number,
       sl.skill_level_name,
       s.file_name,
       s.inserted_datetime,
       s.updated_datetime
     from  public.song as s
      join public.skill_level as sl
        on sl.skill_level_number = s.skill_level_number
     order by %s', order_clause
  );
end
$$;

revoke all on function public.song_list(text, text)
  from public, authenticated, anon;
grant execute on function public.song_list(text, text)
  to service_role;

