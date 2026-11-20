// supabase/functions/live-token/index.ts
//
// Supabase Edge Function: hands a logged-in veterinarian a short-lived
// ("ephemeral") Gemini Live API token.
//
// Why this exists: the browser talks to Gemini directly for live dictation,
// but the real GEMINI_API_KEY must never be sent to the browser. This function
// keeps the real key on the server and gives out a token that works once and
// expires quickly.
//
// Setup (in the PROTOTYPE Supabase project):
//   1. Edge Functions -> Secrets -> add GEMINI_API_KEY
//   2. Edge Functions -> Deploy a new function -> Via Editor -> name it
//      "live-token" and paste this file
//   3. In the function's settings, turn OFF "Verify JWT with legacy secret".
//      (This file checks the user itself, below.)

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Google's docs and SDK disagree on which API version ephemeral tokens use,
// so the browser may ask for either one. Anything else is rejected.
const ALLOWED_API_VERSIONS = ["v1beta", "v1alpha"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  // Browsers send an OPTIONS "preflight" request first. Answer it.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Use POST." }, 405);
  }

  try {
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      return json(
        { error: "The GEMINI_API_KEY secret is not set for Edge Functions." },
        500,
      );
    }

    // ---- 1. Who is calling? Must be a logged-in veterinarian. ----
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) {
      return json({ error: "Sign in to use live dictation." }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey =
      req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseKey) {
      return json({ error: "Supabase is not configured for this function." }, 500);
    }

    // Queries made with this client run as the caller, so the normal
    // security rules (RLS) still apply.
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
    if (userError || !userData?.user) {
      return json({ error: "Your session has expired. Sign in again." }, 401);
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profileError) {
      return json({ error: `Could not read your profile: ${profileError.message}` }, 500);
    }
    if (String(profile?.role ?? "").trim().toLowerCase() !== "veterinarian") {
      return json({ error: "Only veterinarians can use live dictation." }, 403);
    }

    // ---- 2. Ask Gemini for a one-use, short-lived token. ----
    const body = await req.json().catch(() => ({}));
    const apiVersion = ALLOWED_API_VERSIONS.includes(body?.apiVersion)
      ? body.apiVersion
      : "v1beta";

    const now = Date.now();
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/${apiVersion}/auth_tokens`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": geminiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uses: 1, // one Live connection per token
          newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(), // must connect within 2 min
          expireTime: new Date(now + 30 * 60 * 1000).toISOString(), // usable for 30 min
        }),
      },
    );

    const geminiText = await geminiResponse.text();
    if (!geminiResponse.ok) {
      console.error("Gemini token request failed:", geminiResponse.status, geminiText);
      return json(
        {
          error: `Gemini refused to create a token (HTTP ${geminiResponse.status}). Check the GEMINI_API_KEY secret.`,
          details: geminiText.slice(0, 500),
        },
        502,
      );
    }

    const token = JSON.parse(geminiText)?.name;
    if (typeof token !== "string" || !token) {
      return json({ error: "Gemini returned an unexpected token response." }, 502);
    }

    // token looks like "auth_tokens/abc123...". The browser uses it like an API key.
    return json({ token, apiVersion });
  } catch (error) {
    console.error("live-token failed:", error);
    return json(
      { error: error instanceof Error ? error.message : "Unexpected error." },
      500,
    );
  }
});
