const API_BASE = "https://api.manychat.com/fb";

async function manychatPost(path, body) {
  const apiKey = process.env.MANYCHAT_API_KEY;
  if (!apiKey) return;
  try {
    await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(`ManyChat ${path} failed:`, err);
  }
}

async function manychatGet(path) {
  const apiKey = process.env.MANYCHAT_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || j.status !== "success") return null;
    return j.data ?? null;
  } catch (err) {
    console.error(`ManyChat GET ${path} failed:`, err);
    return null;
  }
}

export async function addTag(subscriberId, tagName) {
  if (!subscriberId || !tagName) return;
  await manychatPost("/subscriber/addTagByName", {
    subscriber_id: subscriberId,
    tag_name: tagName,
  });
}

export async function setEmail(subscriberId, email) {
  if (!subscriberId || !email) return;
  await manychatPost("/subscriber/setCustomFieldByName", {
    subscriber_id: subscriberId,
    field_name: "Email",
    field_value: email,
  });
}

// Look up the IG handle for a ManyChat subscriber. Returns null when the
// subscriber doesn't exist, isn't an IG-DM-sourced contact (so no
// ig_username), or the API call fails. Webhook callers swallow null.
export async function getSubscriberIgUsername(subscriberId) {
  if (!subscriberId) return null;
  const data = await manychatGet(
    `/subscriber/getInfo?subscriber_id=${encodeURIComponent(subscriberId)}`,
  );
  if (!data) return null;
  const ig = data.ig_username ?? data.username ?? null;
  return ig ? String(ig).replace(/^@+/, "").trim().toLowerCase() || null : null;
}
