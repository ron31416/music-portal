do $$begin raise exception 'do not run this file'; end$$;


--drop function public.user_list(text, text);
create or replace function public.user_list(
  p_sort_column     text default 'user_name',
  p_sort_direction  text default 'asc'
)
returns table (
  user_id           int,
  user_name         text,
  user_email        text,
  user_first_name   text,
  user_last_name    text,
  user_role_number  int,
  user_role_name    text,
  inserted_datetime timestamptz,
  updated_datetime  timestamptz
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
    when 'user_name' then
      order_clause := format('u.user_name %s', p_sort_direction);
    when 'user_email' then
      order_clause := format('u.user_email %s', p_sort_direction);
    when 'user_first_name' then
      order_clause := format('u.user_first_name %s, u.user_last_name asc, u.user_name asc', p_sort_direction);
    when 'user_last_name' then
      order_clause := format('u.user_last_name %s, u.user_first_name asc, u.user_name asc', p_sort_direction);
    when 'user_role_number' then
      order_clause := format('u.user_role_number %s, u.user_name asc', p_sort_direction);
    when 'updated_datetime' then
      order_clause := format('u.updated_datetime %s, u.user_name asc', p_sort_direction);
    when 'inserted_datetime' then
      order_clause := format('u.inserted_datetime %s, u.user_name asc', p_sort_direction);
    else
      order_clause := format('u.user_name %s', p_sort_direction);
  end case;
  return query execute format(
    'select
      u.user_id,
      u.user_name,
      u.user_email,
      u.user_first_name,
      u.user_last_name,
      u.user_role_number,
      ur.user_role_name,
      u.inserted_datetime,
      u.updated_datetime
     from  public.site_user as u
      join public.user_role as ur
        on ur.user_role_number = u.user_role_number
     order by %s', order_clause
  );
end
$$;

revoke all on function public.user_list(text, text) 
  from public, authenticated, anon;
grant execute on function public.user_list(text, text) 
  to service_role;

