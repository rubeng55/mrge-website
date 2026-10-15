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
function dayLabel(d: Date) {
  return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

// Today's calendar date in Pacific time, as a UTC-midnight Date (date math only).
function todayPacific(): Date {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(p + "T00:00:00Z");
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const WD = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Understands: today, tomorrow, day after tomorrow, Wednesday, this Wednesday, next Wednesday,
// next week, in 3 days, October 21, Oct 21st, 10/21, 2026-10-21. Returns a Pacific calendar date.
function parseDay(raw: string): Date | null {
  const t = todayPacific();
  const s = String(raw || "").toLowerCase().replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (/\btoday\b|\btonight\b/.test(s)) return t;
  if (/day after tomorrow/.test(s)) return addDays(t, 2);
  if (/\btomorrow\b/.test(s)) return addDays(t, 1);
  m = s.match(/\bin (\d+) days?\b/);
  if (m) return addDays(t, +m[1]);
  m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    let y = m[3] ? +m[3] : t.getUTCFullYear(); if (y < 100) y += 2000;
    let d = new Date(Date.UTC(y, +m[1] - 1, +m[2]));
    if (!m[3] && d < t) d = new Date(Date.UTC(y + 1, +m[1] - 1, +m[2]));
    return d;
  }
  for (let i = 0; i < 12; i++) {
    const re = new RegExp("\\b" + MON[i] + "[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b");
    const mm = s.match(re);
    if (mm) {
      let d = new Date(Date.UTC(t.getUTCFullYear(), i, +mm[1]));
      if (d < t) d = new Date(Date.UTC(t.getUTCFullYear() + 1, i, +mm[1]));
      return d;
    }
  }
  const wi = WD.findIndex((w) => new RegExp("\\b" + w.slice(0, 3) + "[a-z]*\\b").test(s));
  if (wi >= 0) {
    const today = t.getUTCDay();
    let diff = (wi - today + 7) % 7; // 0..6, the coming occurrence (today counts as 0)
    if (/\bnext\b/.test(s)) {
      // "next Wednesday" = the Wednesday of next week (Monday-based weeks), never today
      const mondayThisWeek = addDays(t, -((today + 6) % 7));
      const target = addDays(mondayThisWeek, 7 + ((wi + 6) % 7));
      return target;
    }
    return addDays(t, diff);
  }
  if (/\bnext week\b/.test(s)) return addDays(t, 7 - ((t.getUTCDay() + 6) % 7)); // next Monday
  if (/\bthis week(end)?\b/.test(s)) return t;
  return null;
}

async function checkAvailability(args: any) {
  const et = await getEventType();
  const now = Date.now();
  const t = todayPacific();
  const asked = args?.day || args?.date || "";
  const day = asked ? parseDay(asked) : null;
  const todayText = dayLabel(t);
  if (asked && !day) return { today: todayText, message: `I could not tell which day "${asked}" means. Ask the caller for the day or date again.` };
  // Pacific midnight of the target day (handles PDT/PST by probing the offset)
  const pacMidnight = (d: Date) => {
    const probe = new Date(d.getTime() + 12 * 3600_000);
    const off = new Date(probe.toLocaleString("en-US", { timeZone: TZ })).getTime() - new Date(probe.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    return d.getTime() - off;
  };
  let start = day ? pacMidnight(day) : now + 60_000;
  if (start < now + 60_000) start = now + 60_000;
  const days = day ? 1 : Math.min(Math.max(Number(args?.days) || 4, 1), 7);
  let end = (day ? pacMidnight(day) : start) + days * 86_400_000;
  if (end <= start) return { today: todayText, requested_day: day ? dayLabel(day) : undefined, slots: [], message: "That day has already passed. Offer to check another day." };
  const fetchSlots = async (a: number, b: number) => {
    const res = await cal(`/event_type_available_times?event_type=${encodeURIComponent(et)}&start_time=${new Date(a).toISOString()}&end_time=${new Date(b).toISOString()}`);
    return (res.collection || []).filter((x: any) => x.status === "available").map((x: any) => x.start_time as string);
  };
  let slots = await fetchSlots(start, end);
  const out: any = { today: todayText, timezone: "Pacific Time" };
  if (day) out.requested_day = dayLabel(day);
  if (day && !slots.length) {
    // nothing that day: look at the next 3 days after it
    const s2 = Math.max(end, now + 60_000), e2 = s2 + 3 * 86_400_000;
    slots = await fetchSlots(s2, e2);
    out.message = `No open times on ${dayLabel(day)}. These are the next open times instead.`;
  }
  if (!slots.length) return { ...out, slots: [], message: "No open times in that range. Offer to check other days." };
  const perDay: Record<string, number> = {};
  const cap = day && !out.message ? 8 : 3;
  const picked = slots.filter((x: string) => {
    const d = new Date(x).toLocaleDateString("en-US", { timeZone: TZ });
    perDay[d] = (perDay[d] || 0) + 1;
    return perDay[d] <= cap;
  }).slice(0, 12);
  out.slots = picked.map((x: string) => ({ start_time: x, spoken: label(x) }));
  out.message = (out.message ? out.message + " " : "") + "Confirm the date with the caller, offer two or three of these, and when they pick one call book_call with that exact start_time.";
  return out;
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
