const UPSTREAM = "https://flix-player-pi.vercel.app";

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "vary": "Origin",
  };
}


// FastAPI validation errors arrive as an array of { loc, msg, ... } objects.
function errorText(data, fallback) {
  const e = data?.detail ?? data?.error ?? data?.message;
  if (Array.isArray(e)) {
    return e.map(x => `${(x.loc || []).join(".")}: ${x.msg}`).join("; ") || fallback;
  }
  if (e && typeof e === "object") return JSON.stringify(e);
  return e || fallback;
}

// The upstream endpoint reads its inputs from the query string
// (e.g. ?url=...), so convert the frontend's JSON fields into query params.
function buildQuery(body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined || value === "") continue;
    params.append(key, String(value));
  }
  return params.toString();
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, { success: false, error: "Method not allowed. Use POST." }, {
      allow: "POST, OPTIONS",
    });
  }

  const apiKey = process.env.ONLINE_MEDIA_PLAYER_API_KEY;
  if (!apiKey) {
    console.error("Missing ONLINE_MEDIA_PLAYER_API_KEY environment variable.");
    return json(500, { success: false, error: "Server is not configured." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { success: false, error: "Request body must be valid JSON." });
  }

  // Forward the frontend's JSON body unchanged so it matches the contract
  // implemented by the Online Media Player API.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { success: false, error: "JSON body must be an object." });
  }

  try {
    const query = buildQuery(body);
    const upstream = await fetch(`${UPSTREAM}/tasks/url-downloads${query ? `?${query}` : ""}`, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "accept": "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });

    const raw = await upstream.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { data = { message: raw.slice(0, 1000) }; }

    if (!upstream.ok) {
      console.error("Upstream task creation failed:", upstream.status);
      return json(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502, {
        success: false,
        error: errorText(data, "Could not create media download task."),
      });
    }

    if (!data.task_id) {
      return json(502, {
        success: false,
        error: "The API response did not include task_id.",
        upstream: data,
      });
    }

    return json(200, { success: true, task_id: data.task_id });
  } catch (error) {
    console.error("Task creation request failed:", error?.message || error);
    return json(502, { success: false, error: "Could not reach the media API." });
  }
}
