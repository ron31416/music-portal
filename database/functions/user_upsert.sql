do $$begin raise exception 'do not run this file'; end$$;


--drop function public.user_upsert(int, text, text, text, int);
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

