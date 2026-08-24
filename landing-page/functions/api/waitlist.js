const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid" }, 400);
  }
  if (body && body.company) return json({ ok: true }, 200);
  const email = String(body?.email || "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) return json({ error: "invalid" }, 400);
  if (!env.WAITLIST) return json({ error: "unconfigured" }, 503);
  await env.WAITLIST.put(`email:${email}`, JSON.stringify({
    email,
    at: new Date().toISOString(),
  }));
  return json({ ok: true }, 200);
}
