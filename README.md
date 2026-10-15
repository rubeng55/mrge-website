# MRGE Solutions website

Source for **mrgesolutions.com**: the 3D scroll homepage, the MRGE Pipeline tool page, Terms and the newsletter unsubscribe page.

## Layout
- `site/index.html` — homepage (3D scroll film, find-my-fix guide, booking with Calendly)
- `site/pipeline.html` — Tools → MRGE Pipeline (3D scroll walkthrough)
- `site/f/` — film frames (WebP, two 1920×1080 frames per file)
- `site/terms/`, `site/unsubscribe/` — static pages (old React routes `/terms` and `/unsubscribe?token=` keep working)
- `supabase/functions/calendly-booking/` — tool endpoint for the Vapi phone agent (check_availability, book_call)
- `vapi/nexis-system-prompt.md` — system prompt for the "Nexis - MRGE Solutions" Vapi assistant

## Install into the Lovable project (MRGE Solutions)
1. Root `index.html` = `site/index.html` (no React entry).
2. Copy `site/pipeline.html`, `site/f/`, `site/terms/`, `site/unsubscribe/` into `public/`.
3. Remove the old React app in `src/` (homepage, quiz, login, admin and sales dashboards).
4. Add `supabase/functions/calendly-booking` with `verify_jwt = false` in `supabase/config.toml`.
5. Secrets: `CALENDLY_TOKEN` (Calendly personal access token), `VAPI_ASSISTANT_ID`.

## Calendly
Event: https://calendly.com/rg-gorbunov123/mrge-strategy-call — 30 min, Google Meet, Mon–Sat 1:30–10 PM Pacific.
Invitee questions (order matters for prefill a1–a4): notes, business name, phone, interested in.
