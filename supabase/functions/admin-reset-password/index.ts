// 관리자만: 회원 비밀번호를 임시 비밀번호(000000)로 초기화하고, 다음 로그인 때 바꾸게 표시
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const TEMP_PASSWORD = "000000";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { code: "method" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json(401, { code: "session_expired" });

  const admin = createClient(url, service);
  const { data: me } = await admin.from("profiles").select("is_admin").eq("id", user.id).single();
  if (!me?.is_admin) return json(403, { code: "not_admin" });

  let target = "";
  try { target = String((await req.json()).user_id ?? ""); } catch { /* 빈 요청 */ }
  if (!/^[0-9a-f-]{36}$/i.test(target)) return json(400, { code: "invalid_request" });

  const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", target).single();
  if (!prof) return json(404, { code: "not_found" });
  if (prof.is_admin) return json(403, { code: "target_is_admin" }); // 관리자 계정은 여기서 초기화하지 않음

  const { error } = await admin.auth.admin.updateUserById(target, { password: TEMP_PASSWORD });
  if (error) { console.error("reset", error.message); return json(500, { code: "reset_failed" }); }
  await admin.from("profiles").update({ must_change_pw: true }).eq("id", target);

  return json(200, { ok: true });
});
