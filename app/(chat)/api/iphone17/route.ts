import { NextRequest } from "next/server";

/**
 * Simple proxy to the Flask ai-test streaming endpoint.
 * It forwards the user's question and streams plain text back to the client.
 *
 * NOTE:
 * - This returns a plain text stream wrapped as an SSE data stream (single channel),
 *   which is suitable for manual consumers or debugging. The main chat UI still uses /api/chat.
 * - Set AI_TEST_BASE_URL to point to the Flask server (e.g. http://localhost:5000).
 */
export async function POST(request: NextRequest) {
  const baseUrl = "https://ai-qa-d3a2f217dca4.herokuapp.com";

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const res = await fetch(`${baseUrl}/api/iphone17`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    // Force streaming on Flask side
    body: JSON.stringify({
      ...(typeof body === "object" && body ? body : {}),
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    return Response.json(
      { error: "Upstream error", status: res.status, details: errText },
      { status: 502 }
    );
  }

  // Pass-through the upstream plain text stream
  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}


