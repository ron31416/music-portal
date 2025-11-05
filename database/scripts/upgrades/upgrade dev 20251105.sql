
begin;

do $$
declare
  v_system_environment_name text;
begin
  select system_environment_name
  into v_system_environment_name
  from public.system_environment
  limit 1;

  if v_system_environment_name is null then
    raise exception 'Guard failed: public.system_environment is empty or missing';
  end if;

  if v_system_environment_name <> 'music-portal-dev' then
    raise exception 'This script is only for the music-portal-dev database (found %)',
      v_system_environment_name;
  end if;
end
$$ language plpgsql;



alter table site_user drop column user_name;


drop function public.user_upsert(int, text, text, text, text, int);
create function public.user_upsert(
  p_user_id           int,
  p_user_email        text,
  p_user_first_name   text,
  p_user_last_name    text,
  p_user_role_number  int
) returns int
language plpgsql
as $$
declare
  v_user_id            int;
  v_user_email         text := lower(btrim(coalesce(p_user_email, '')));
  v_user_first_name    text := btrim(coalesce(p_user_first_name, ''));
  v_user_last_name     text := btrim(coalesce(p_user_last_name, ''));
begin
  if v_user_email = '' then
    raise exception 'User email is required' using errcode = '22000';
  end if;
  if v_user_first_name = '' then
    raise exception 'User first name is required' using errcode = '22000';
  end if;
  if p_user_role_number is null then
  raise exception 'User role number is required' using errcode = '22000';
  end if;
  if p_user_id is null then
    insert into public.site_user (
      user_email,
      user_first_name,
      user_last_name,
      user_role_number
    )
    values (
      v_user_email,
      v_user_first_name,
      v_user_last_name,
      p_user_role_number
    )
    returning user_id into v_user_id;
    return v_user_id;
  else
    update public.site_user
    set user_email       = v_user_email,
        user_first_name  = v_user_first_name,
        user_last_name   = v_user_last_name,
        user_role_number = p_user_role_number,
        updated_datetime = now()
    where user_id = p_user_id;

    if found then
      return p_user_id;
    else
      raise exception 'user_id % not found', p_user_id
        using errcode = 'p0002'; -- no_data_found
    end if;
  end if;
end
$$;

revoke all on function public.user_upsert(int, text, text, text, int) 
  from public, authenticated, anon;
grant execute on function public.user_upsert(int, text, text, text, int) 
  to service_role;


drop function public.user_list(text, text);
create function public.user_list(
  p_sort_column     text default 'user_email',
  p_sort_direction  text default 'asc'
)
returns table (
  user_id           int,
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
  v_sort_column    text := lower(coalesce(p_sort_column, 'user_email'));
  v_sort_direction text := lower(coalesce(p_sort_direction, 'asc'));
  order_clause     text;
begin
  if v_sort_direction not in ('asc', 'desc') then
    raise exception 'Invalid sort_direction: %, must be "asc" or "desc"', v_sort_direction
      using errcode = '22023';
  end if;
  case v_sort_column
    when 'user_email' then
      order_clause := format('u.user_email %s', v_sort_direction);
    when 'user_first_name' then
      order_clause := format('u.user_first_name %s, u.user_last_name asc, u.user_email asc', v_sort_direction);
    when 'user_last_name' then
      order_clause := format('u.user_last_name %s, u.user_first_name asc, u.user_email asc', v_sort_direction);
    when 'user_role_number' then
      order_clause := format('u.user_role_number %s, u.user_email asc', v_sort_direction);
    when 'updated_datetime' then
      order_clause := format('u.updated_datetime %s, u.user_email asc', v_sort_direction);
    when 'inserted_datetime' then
      order_clause := format('u.inserted_datetime %s, u.user_email asc', v_sort_direction);
    else
      order_clause := format('u.user_email %s', v_sort_direction);
  end case;

  return query execute format(
    'select
       u.user_id,
       u.user_email,
       u.user_first_name,
       u.user_last_name,
       u.user_role_number,
       ur.user_role_name,
       u.inserted_datetime,
       u.updated_datetime
     from public.site_user as u
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


create function public.user_get(
  p_user_id    int   default null,
  p_user_email text  default null
)
returns table (
  user_id           int,
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
  v_user_email text := 
    case
    when p_user_email is null then null
    else lower(btrim(p_user_email))
    end;
begin
  if (p_user_id is null and v_user_email is null) or 
     (p_user_id is not null and v_user_email is not null) then
    raise exception 'Provide exactly one of (user_id, user_email)'
      using errcode = '22023'; -- invalid_parameter_value
  end if;
  if p_user_id is not null then
    return query
    select
      u.user_id, 
      u.user_email, 
      u.user_first_name, 
      u.user_last_name,
      u.user_role_number, 
      ur.user_role_name,
      u.inserted_datetime, 
      u.updated_datetime
    from public.site_user as u
    join public.user_role as ur
      on ur.user_role_number = u.user_role_number
    where u.user_id = p_user_id
    limit 1;
    return;
  end if;
  if v_user_email = '' then
    raise exception 'User_email is required when user_id is null'
      using errcode = '22023';
  end if;
  return query
  select
    u.user_id, 
    u.user_email, 
    u.user_first_name, 
    u.user_last_name,
    u.user_role_number, 
    ur.user_role_name,
    u.inserted_datetime, 
    u.updated_datetime
  from public.site_user as u
  join public.user_role as ur
    on ur.user_role_number = u.user_role_number
  where u.user_email = v_user_email
  limit 1;
end
$$;

revoke all on function public.user_get(int, text)
  from public, authenticated, anon;
grant execute on function public.user_get(int, text)
  to service_role;


--rollback;
commit;
