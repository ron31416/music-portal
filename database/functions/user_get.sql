do $$begin raise exception 'do not run this file'; end$$;


--drop function if exists public.user_get(int, text);
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
