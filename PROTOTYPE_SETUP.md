# Prototype setup checklist

This sets up a separate copy of Project Hamster (its own database and its own
web address) and adds **live dictation** to the vet's Basic Examination page.

Do the steps in order. Each one ends with a quick check, so a problem shows up
at the step that caused it.

---

## Part A: The prototype Supabase project

### A1. Build the database
1. Open the **new** project, then **SQL Editor > New query**.
2. Paste the whole file `supabase/migrations/20261120000000_prototype_schema.sql`.
   The last line you paste should be `);`.
3. Click **Run**. Confirm the warning (it is expected).

**Check:** Table Editor shows 9 tables. Storage shows 3 buckets
(`hamster-images`, `audio`, `fecal_images`).

### A2. Turn off email confirmation
Supabase's built-in email only sends to people on your Supabase team, and only
about 2 emails an hour. Test accounts with other addresses would never get
their confirmation email.

1. **Authentication > Sign In / Providers > Email**.
2. Turn off **Confirm email**. Save.

**Check:** After signing up on the site you land on the home page, already logged in.

### A3. Tell Supabase where the site lives
1. **Authentication > URL Configuration**.
2. **Site URL:** your prototype address, for example `https://prototype.yourdomain.com`.
3. **Redirect URLs:** add that same address followed by `/**`, and also `http://localhost:5173/**`.

### A4. Add the Gemini key
1. Create an API key in Google AI Studio.
2. In Supabase: **Edge Functions > Secrets**. Add `GEMINI_API_KEY` with the key as its value.

The key lives only here. Do **not** put it in Vercel or in any `VITE_` variable,
because anything starting with `VITE_` is visible to every visitor.

### A5. Deploy the token function
1. **Edge Functions > Deploy a new function > Via Editor**.
2. Name it exactly `live-token`.
3. Replace the sample code with the contents of `supabase/functions/live-token/index.ts`.
4. Deploy.
5. Open the function's settings and turn **off** "Verify JWT with legacy secret".
   The function checks the logged-in user itself.

**Check:** The function appears in the list with the name `live-token`.

---

## Part B: The code

### B1. Add the files on a `prototype` branch
New files:

| File | What it is |
|---|---|
| `src/services/LiveIntakeService.ts` | Microphone + Gemini Live connection |
| `src/lib/liveIntakeFields.ts` | Rules for merging a spoken finding into the form |
| `src/components/LiveIntakeControl.tsx` | The "Live dictation" card |
| `supabase/functions/live-token/index.ts` | Token function (same code as step A5) |
| `supabase/migrations/20261120000000_prototype_schema.sql` | Database structure |
| `supabase/seed_prototype_slots.sql` | Starter appointment slots |
| `.env.example` | Template for local settings |

Changed files:

| File | Change |
|---|---|
| `src/pages/Veterinarian/MedicalRecord.tsx` | 1 import line + the `<LiveIntakeControl ... />` card |
| `supabase/config.toml` | 3 lines at the bottom for `live-token` |

No new packages are needed. `@google/genai` is already in `package.json`.

### B2. Run it on your computer (optional but recommended)
1. Copy `.env.example` to `.env.local` and fill in the two values from the
   prototype project (**Project Settings > API Keys**).
2. `npm install`, then `npm run dev`, then open `http://localhost:5173`.
3. `npm run build` should finish with no errors. Vercel runs this same command.

---

## Part C: Vercel

1. **Settings > Environment Variables**. For the **Preview** environment
   (you can limit it to the `prototype` branch) add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
2. **Redeploy** the `prototype` branch. These values are baked in when the site
   is built, so changing them does nothing until the next build.
3. **Settings > Domains**: add your address and connect it to the Preview
   environment and the `prototype` branch. Add the DNS record Vercel shows you.

**Check:** Open the prototype address. In the browser's Network tab, requests
go to the **new** project's `supabase.co` address, not the old one.

---

## Part D: Test accounts and starter data

A new database is empty, and the app has no screen for vets to open time
slots. Without this part, nobody can book and the exam page can't be reached.

1. Go to `/create-vet-account` and create a vet. (You land on the customer home
   page afterwards. That is normal.)
2. Log out. Go to `/signup` and create a customer.
3. In the SQL Editor, run `supabase/seed_prototype_slots.sql`.
   **Check:** it prints your vet with 140 slots.
4. As the **customer**: add a hamster, then book an appointment.
5. Log out, log in as the **vet**: open the appointment, then start the
   examination. You should see a **Live dictation** card above the form.

---

## Part E: Two-minute test of live dictation

Use Chrome or Edge.

1. Click **Start listening** and allow the microphone.
   **Expect:** status changes to "Listening. Speak your findings."
2. Say: "Weight is one hundred twenty eight grams." Pause for a second.
   **Expect:** Weight shows `128`, and "Heard:" shows your words.
3. Say: "Coat looks dull, small scab behind the left ear."
   **Expect:** text appears in Physical examination notes.
4. Say: "Actually the weight is one thirty."
   **Expect:** Weight changes to `130`.
5. Click **Stop listening**. The microphone light turns off.
6. Fix anything by hand and submit the form as usual.

Boxes fill a moment after you pause, not while you are mid-sentence. The model
waits for a short silence before it acts.

---

## If something goes wrong

| What you see | Cause | Fix |
|---|---|---|
| "The live-token Edge Function is not deployed..." | Function missing or named differently | Redo A5. The name must be `live-token`. |
| "Supabase rejected the request (401)..." | Legacy JWT check is still on | A5, step 5. |
| "The GEMINI_API_KEY secret is not set..." | Secret missing | A4. |
| "Gemini refused to create a token (HTTP 400/403)..." | Key is wrong, or has no access to the Live API | Make a new key in AI Studio and update the secret. |
| "Only veterinarians can use live dictation." | Logged in as a customer | Log in as the vet. In `profiles`, the `role` must be `veterinarian`. |
| "Could not connect to Gemini Live (model ...)" | Model name changed, or quota ran out | Check the current Live model name in Google's docs and update `LIVE_MODEL` at the top of `LiveIntakeService.ts`. The message also includes Gemini's own reason. |
| "Microphone access was blocked..." | Browser permission | Click the lock icon in the address bar and allow the microphone. |
| Status says Listening, but nothing fills | Model heard nothing it considers a finding | Check "Heard:". If it is empty, the microphone is the problem. If it has your words, state findings more directly. |
| Site still shows the real data | Vercel variables point at the old project, or no rebuild | Part C, steps 1 and 2. |
| Signup says "Email address not authorized" | Email confirmation is still on | A2. |
| Customer sees no time slots | No starter data | Part D, step 3. |

For anything else, open the browser console (F12). Messages from this feature
start with "Live intake:".

---

## Things to know

- **Not copied from the real project:** the `process-medical-audio` Edge
  Function used by the existing "AI assistant" upload button. Its code is not in
  this repo. Live dictation does not need it. To make the upload button work,
  copy that function's code from the real project's Edge Functions page.
- **Database structure was rebuilt from the app's code.** Column types and
  security rules are best guesses. If a screen behaves differently from the real
  site, compare that table's definition in the real project.
- **Anyone can create a vet account** at `/create-vet-account`. The real app
  works the same way. That is fine for a prototype with fake data, but not for
  real patient data.
- **Long exams:** Gemini ends a connection about every 10 minutes. The code
  reconnects on its own and tells the model what is already on the form.
  A second or two of speech can be missed during a reconnect.
- **Cost:** the Live model always replies with audio, which the app ignores.
  You are billed for the session while it is listening, so click Stop when done.
- **Always review before saving.** Speech recognition mishears numbers.
