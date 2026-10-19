// 승인된 회원만 관리자 API 키로 Claude를 호출하는 중계 함수.
// 키는 Supabase secret(ANTHROPIC_API_KEY)에만 있고 브라우저로 나가지 않음.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const MODEL = "claude-sonnet-5-5";
const MAX_PROMPT = 20000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-quota-used, x-quota-limit",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { code: "method" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json(500, { code: "no_server_key" });

  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json(401, { code: "session_expired" });

  let prompt = "";
  try { prompt = String((await req.json()).prompt ?? ""); } catch { /* 빈 요청 */ }
  if (!prompt.trim()) return json(400, { code: "invalid_request" });
  if (prompt.length > MAX_PROMPT) return json(400, { code: "prompt_too_large" });

  const admin = createClient(url, service);
  const { data: q, error } = await admin.rpc("consume_quota", { uid: user.id });
  if (error) return json(500, { code: "upstream_error" });
  if (!q?.ok) return json(403, { code: q?.reason ?? "not_approved", limit: q?.limit });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: req.signal,
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, stream: true, messages: [{ role: "user", content: prompt }] }),
  }).catch(() => null);

  if (!r || !r.ok || !r.body) {
    await admin.rpc("refund_quota", { uid: user.id });
    const status = r?.status ?? 0;
    return json(502, { code: status === 429 || status === 529 ? "rate_limited" : "upstream_error" });
  }

  return new Response(r.body, {
    headers: {
      ...cors,
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-quota-used": String(q.used),
      "x-quota-limit": String(q.limit),
    },
  });
});
