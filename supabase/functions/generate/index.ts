// 승인된 회원만 관리자 API 키로 AI를 호출하는 중계 함수.
// 키는 Supabase secret(GEMINI_API_KEY 또는 ANTHROPIC_API_KEY)에만 있고 브라우저로 나가지 않음.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const MODEL = "claude-sonnet-5-5";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";
const MAX_PROMPT = 20000;

function geminiToAnthropicStream(src: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = "";
  const emit = (c: TransformStreamDefaultController<Uint8Array>, obj: unknown) =>
    c.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
  const handle = (c: TransformStreamDefaultController<Uint8Array>, line: string) => {
    if (!line.startsWith("data:")) return;
    let ev: any;
    try { ev = JSON.parse(line.slice(5)); } catch { return; }
    const cand = ev?.candidates?.[0];
    for (const p of cand?.content?.parts ?? []) {
      if (p?.text && !p.thought) emit(c, { type: "content_block_delta", delta: { type: "text_delta", text: p.text } });
    }
    if (cand?.finishReason) {
      emit(c, { type: "message_delta", delta: { stop_reason: cand.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn" } });
    }
  };
  return src.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) handle(c, l);
    },
    flush(c) { if (buf) handle(c, buf); },
  }));
}

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
  // Gemini 키가 있으면 Gemini, 없으면 Anthropic 키를 씀
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  const gemini = !!geminiKey;
  const apiKey = geminiKey ?? Deno.env.get("ANTHROPIC_API_KEY");
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

  const r = gemini
    ? await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`, {
        method: "POST",
        signal: req.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 16384 },
        }),
      }).catch(() => null)
    : await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: req.signal,
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 8000, stream: true, messages: [{ role: "user", content: prompt }] }),
      }).catch(() => null);

  if (!r || !r.ok || !r.body) {
    await admin.rpc("refund_quota", { uid: user.id });
    const status = r?.status ?? 0;
    let detail = "";
    try { detail = (await r?.text())?.slice(0, 300) ?? ""; } catch { /* 본문 없음 */ }
    console.error("upstream", status, detail);
    return json(502, { code: status === 429 || status === 529 ? "rate_limited" : "upstream_error" });
  }

  // 화면은 Anthropic 스트림 형식을 읽으므로, Gemini 응답은 같은 모양으로 바꿔서 보냄
  const body = gemini ? geminiToAnthropicStream(r.body) : r.body;

  return new Response(body, {
    headers: {
      ...cors,
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-quota-used": String(q.used),
      "x-quota-limit": String(q.limit),
    },
  });
});
