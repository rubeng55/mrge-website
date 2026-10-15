// Calendly booking tools for the Vapi phone agent (Nexis - MRGE Solutions).
// Vapi calls this URL for two tools: check_availability and book_call.
// Secrets (set in Lovable Cloud, never in code):
//   CALENDLY_TOKEN       - Calendly personal access token
//   VAPI_ASSISTANT_ID    - optional; only calls from this assistant are accepted
//   VAPI_TOOL_SECRET     - optional; if set, Vapi must send it in the x-vapi-secret header
const CAL = "https://api.calendly.com";
const SLUG = "mrge-strategy-call";
const TZ = "America/Los_Angeles";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-vapi-secret",
};

let eventTypeUri: string | null = null;

async function cal(path: string, init: RequestInit = {}) {
  const r = await fetch(CAL + path, {
    ...init,
    headers: { Authorization: `Bearer ${Deno.env.get("CALENDLY_TOKEN")}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.message || `Calendly ${r.status}`), { status: r.status, body });
  return body;
}

async function getEventType() {
  if (eventTypeUri) return eventTypeUri;
  const me = await cal("/users/me");
  const list = await cal(`/event_types?user=${encodeURIComponent(me.resource.uri)}&active=true&count=100`);
  const et = list.collection.find((e: any) => e.slug === SLUG) || list.collection.find((e: any) => /mrge/i.test(e.name));
  if (!et) throw new Error("MRGE Strategy Call event type not found in Calendly");
  eventTypeUri = et.uri;
  return eventTypeUri!;
}

function label(iso: string) {
  return new Date(iso).toLocaleString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function checkAvailability(args: any) {
  const et = await getEventType();
  const now = Date.now();
  let start = args?.date ? new Date(`${args.date}T00:00:00-07:00`).getTime() : now + 60_000;
  if (start < now + 60_000) start = now + 60_000;
  const days = Math.min(Math.max(Number(args?.days) || 4, 1), 7);
  const end = start + days * 86_400_000;
  const res = await cal(`/event_type_available_times?event_type=${encodeURIComponent(et)}&start_time=${new Date(start).toISOString()}&end_time=${new Date(end).toISOString()}`);
  const slots = (res.collection || []).filter((s: any) => s.status === "available").map((s: any) => s.start_time);
  if (!slots.length) return { slots: [], message: "No open times in that range. Offer to check other days." };
  // keep the answer short for voice: up to 3 per day, max 12
  const perDay: Record<string, number> = {};
  const picked = slots.filter((t: string) => {
    const d = new Date(t).toLocaleDateString("en-US", { timeZone: TZ });
    perDay[d] = (perDay[d] || 0) + 1;
    return perDay[d] <= 3;
  }).slice(0, 12);
  return {
    timezone: "Pacific Time",
    slots: picked.map((t: string) => ({ start_time: t, spoken: label(t) })),
    message: "Offer two or three of these. When the caller picks one, call book_call with that exact start_time.",
  };
}

async function bookCall(args: any) {
  const et = await getEventType();
  if (!args?.start_time || !args?.name || !args?.email) return { booked: false, message: "Need start_time, name and email before booking." };
  const qa = [
    { question: "Anything we should know? What's eating most of your time right now?", answer: args.notes || "", position: 0 },
    { question: "Business name", answer: args.business_name || "", position: 1 },
    { question: "Phone number", answer: args.phone || "", position: 2 },
    { question: "What are you interested in?", answer: args.interested_in || "Booked by phone with Nexis", position: 3 },
  ].filter((q) => q.answer);
  try {
    const r = await cal("/invitees", {
      method: "POST",
      body: JSON.stringify({
        event_type: et,
        start_time: args.start_time,
        invitee: { name: args.name, email: String(args.email).trim().toLowerCase(), timezone: TZ, ...(args.phone ? { text_reminder_number: args.phone } : {}) },
        location: { kind: "google_conference" },
        questions_and_answers: qa,
      }),
    });
    return { booked: true, when: label(args.start_time) + " Pacific", message: "Booked. A calendar invite with the Google Meet link was emailed to the caller.", reschedule_url: r?.resource?.reschedule_url };
  } catch (e: any) {
    if (e.status === 400 || e.status === 404 || e.status === 409) return { booked: false, message: "That time is no longer open or a detail was invalid. Check availability again and confirm the email spelling." };
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const secret = Deno.env.get("VAPI_TOOL_SECRET");
    if (secret && req.headers.get("x-vapi-secret") !== secret) return json({ error: "unauthorized" }, 401);
    const body = await req.json();
    const msg = body?.message || {};
    const allowed = Deno.env.get("VAPI_ASSISTANT_ID");
    const asst = msg?.call?.assistantId || msg?.assistant?.id;
    if (allowed && asst && asst !== allowed) return json({ error: "unauthorized" }, 401);
    const calls = msg.toolCallList || msg.toolCalls || [];
    const results = [];
    for (const tc of calls) {
      const name = tc.function?.name || tc.name;
      let args = tc.function?.arguments ?? tc.arguments ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      let result;
      try {
        result = name === "check_availability" ? await checkAvailability(args)
          : name === "book_call" ? await bookCall(args)
          : { error: `unknown tool ${name}` };
      } catch (e: any) {
        console.error(name, e?.status, e?.body || e?.message);
        result = { error: "The calendar is unavailable right now. Take their details and tell them Ruben will text to confirm a time." };
      }
      results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
    }
    return json({ results });
  } catch (e) {
    console.error(e);
    return json({ error: "bad request" }, 400);
  }
});
