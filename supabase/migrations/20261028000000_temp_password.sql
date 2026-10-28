-- 관리자가 비밀번호를 임시(000000)로 초기화하면, 회원은 다음 로그인 때 새 비밀번호로 바꾸게 함
alter table public.profiles add column if not exists must_change_pw boolean not null default false;

create or replace function public.my_status()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'approved', p.approved, 'is_admin', p.is_admin, 'limit', p.daily_limit,
    'must_change_pw', p.must_change_pw,
    'used', coalesce((select u.count from public.usage u
                      where u.user_id = p.id and u.day = (now() at time zone 'Asia/Seoul')::date), 0))
  from public.profiles p where p.id = auth.uid();
$$;

-- 회원이 새 비밀번호로 바꾼 뒤 호출: 임시 비밀번호 표시를 지움 (본인 것만)
create or replace function public.clear_must_change()
returns void language sql security definer set search_path = public as $$
  update public.profiles set must_change_pw = false where id = auth.uid();
$$;

revoke execute on function public.clear_must_change() from public, anon;
grant  execute on function public.clear_must_change() to authenticated;
