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
  return {
    "access-control-allow-origin": process.env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "vary": "Origin",
  };
}

async function apiGet(path, apiKey) {
  const response = await fetch(`${UPSTREAM}${path}`, {
    method: "GET",
    headers: {
      "X-API-Key": apiKey,
      "accept": "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });

  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { message: raw.slice(0, 1000) }; }

  if (!response.ok) {
    const error = new Error(data.detail || data.error || data.message || `Upstream request failed (${response.status}).`);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "GET") {
    return json(405, { success: false, error: "Method not allowed. Use GET." }, {
      allow: "GET, OPTIONS",
    });
  }

  const apiKey = process.env.ONLINE_MEDIA_PLAYER_API_KEY;
  if (!apiKey) {
    console.error("Missing ONLINE_MEDIA_PLAYER_API_KEY environment variable.");
    return json(500, { success: false, error: "Server is not configured." });
  }

  const taskId = event.queryStringParameters?.task_id;
  if (!taskId || !/^\d+$/.test(taskId)) {
    return json(400, { success: false, error: "Provide a numeric task_id query parameter." });
  }

  try {
    const taskResponse = await apiGet(`/tasks/${encodeURIComponent(taskId)}`, apiKey);
    const task = taskResponse.task || taskResponse;

    if (taskResponse.success === false || task.error) {
      return json(502, {
        success: false,
        state: task.state || "error",
        error: task.error_detail || task.error || "The media task failed.",
      });
    }

    const state = String(task.state || "").toLowerCase();
    if (state && !["finished", "completed", "complete", "success"].includes(state)) {
      if (["error", "failed", "cancelled", "canceled"].includes(state)) {
        return json(502, {
          success: false,
          state,
          error: task.error_detail || task.error || "The media task failed.",
        });
      }
      return json(202, {
        success: true,
        ready: false,
        task_id: task.id ?? Number(taskId),
        state: task.state || "processing",
        progress: task.progress ?? null,
      });
    }

    const folderId = task.folder_id;
    if (!folderId || !/^\d+$/.test(String(folderId))) {
      return json(202, {
        success: true,
        ready: false,
        task_id: task.id ?? Number(taskId),
        state: task.state || "processing",
        progress: task.progress ?? 100,
        message: "Task is finished but the folder is not available yet.",
      });
    }

    const folder = await apiGet(`/folders/${encodeURIComponent(folderId)}`, apiKey);
    const files = Array.isArray(folder.files) ? folder.files : [];
    if (!files.length) {
      return json(202, {
        success: true,
        ready: false,
        task_id: task.id ?? Number(taskId),
        folder_id: folderId,
        state: "waiting_for_files",
        message: "Folder exists but no files are listed yet.",
      });
    }

    // If the caller supplied file_name at task creation, the API may not retain it
    // in this status call. By default, return every file found in the task folder.
    const downloads = [];
    for (const file of files) {
      if (file?.id == null) continue;
      const download = await apiGet(`/download/${encodeURIComponent(String(file.id))}`, apiKey);
      if (!download.url) continue;
      downloads.push({
        file_id: file.id,
        folder_id: file.folder_id ?? folderId,
        name: download.name || file.name || "media",
        url: download.url,
      });
    }

    if (!downloads.length) {
      return json(502, {
        success: false,
        error: "No downloadable file URLs were returned for this task.",
      });
    }

    return json(200, {
      success: true,
      ready: true,
      task_id: task.id ?? Number(taskId),
      folder_id: folderId,
      files: downloads,
      // Convenience fields for a task containing one file:
      ...(downloads.length === 1 ? {
        file_id: downloads[0].file_id,
        name: downloads[0].name,
        url: downloads[0].url,
      } : {}),
    });
  } catch (error) {
    console.error("Task status request failed:", error?.message || error);
    return json(error.statusCode || 502, {
      success: false,
      error: error.statusCode
        ? error.message
        : "Could not retrieve media task status from the media API.",
    });
  }
}
