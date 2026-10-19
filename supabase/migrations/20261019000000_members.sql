-- 회원(승인 여부·하루 한도)과 하루 사용 횟수
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  approved    boolean not null default false,
  is_admin    boolean not null default false,
  daily_limit int not null default 5 check (daily_limit >= 0),
  created_at  timestamptz not null default now()
);

create table public.usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);

alter table public.profiles enable row level security;
alter table public.usage    enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- 본인 것은 읽기, 관리자는 전부 읽기·수정. 일반 회원은 아무것도 수정할 수 없음
create policy "profiles_read"   on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "profiles_admin"  on public.profiles for update using (public.is_admin()) with check (public.is_admin());
create policy "usage_read"      on public.usage    for select using (user_id = auth.uid() or public.is_admin());

-- 가입하면 승인 대기 상태로 프로필 생성
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 관리자 이메일이 이메일 인증을 마치면 관리자 + 승인 처리
create or replace function public.grant_owner_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null and lower(new.email) = 'aquarius9184@gmail.com' then
    update public.profiles set is_admin = true, approved = true where id = new.id;
  end if;
  return new;
end $$;

create trigger on_auth_user_confirmed
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.grant_owner_admin();

-- 오늘(한국 시간) 사용 횟수 1 차감. 승인 안 됐거나 한도를 넘으면 실패
create or replace function public.consume_quota(uid uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  appr boolean; lim int; used int;
  today date := (now() at time zone 'Asia/Seoul')::date;
begin
  select approved, daily_limit into appr, lim from public.profiles where id = uid;
  if not found or not appr then
    return json_build_object('ok', false, 'reason', 'not_approved');
  end if;
  if lim <= 0 then
    return json_build_object('ok', false, 'reason', 'limit', 'limit', lim);
  end if;
  insert into public.usage (user_id, day, count) values (uid, today, 1)
  on conflict (user_id, day) do update set count = public.usage.count + 1
    where public.usage.count < lim
  returning count into used;
  if used is null then
    return json_build_object('ok', false, 'reason', 'limit', 'limit', lim);
  end if;
  return json_build_object('ok', true, 'used', used, 'limit', lim);
end $$;

-- 생성이 실패했을 때 차감한 1회를 돌려줌
create or replace function public.refund_quota(uid uuid)
returns void language sql security definer set search_path = public as $$
  update public.usage set count = greatest(count - 1, 0)
  where user_id = uid and day = (now() at time zone 'Asia/Seoul')::date;
$$;

-- 로그인한 사람이 자기 상태(승인, 오늘 사용량, 한도)를 확인
create or replace function public.my_status()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'approved', p.approved, 'is_admin', p.is_admin, 'limit', p.daily_limit,
    'used', coalesce((select u.count from public.usage u
                      where u.user_id = p.id and u.day = (now() at time zone 'Asia/Seoul')::date), 0))
  from public.profiles p where p.id = auth.uid();
$$;

revoke execute on function public.consume_quota(uuid) from public, anon, authenticated;
revoke execute on function public.refund_quota(uuid)  from public, anon, authenticated;
grant  execute on function public.consume_quota(uuid) to service_role;
grant  execute on function public.refund_quota(uuid)  to service_role;
revoke execute on function public.my_status() from public, anon;
grant  execute on function public.my_status() to authenticated;
