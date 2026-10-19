-- 메일 인증 없이 가입 → 관리자 승인만으로 사용하도록 변경.
-- 관리자 권한은 이미 부여됐으므로, 이메일만 보고 관리자를 주던 트리거는 제거
-- (인증을 끄면 같은 이메일로 누구나 '인증된' 상태가 될 수 있어서 위험)
drop trigger if exists on_auth_user_confirmed on auth.users;
drop function if exists public.grant_owner_admin();

-- 인증 메일을 기다리던 기존 가입자는 인증된 것으로 처리 (승인은 여전히 관리자가)
update auth.users set email_confirmed_at = now() where email_confirmed_at is null;
