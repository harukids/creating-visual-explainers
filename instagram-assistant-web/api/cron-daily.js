/**
 * Vercel Cron: GET /api/cron-daily
 * Secured with Authorization: Bearer CRON_SECRET (set in Vercel env + Cron settings).
 *
 * Triggers daily Instagram draft generation and Slack notification by calling /api/generate.
 * Configure ONE of:
 * - DAILY_IMAGE_URL  … public HTTPS URL to a photo (analyze mode, costs image tokens)
 * - DAILY_IMAGE_SUMMARY … text summary only (regenerate mode, cheaper)
 */

async function fetchImageAsBase64(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) {
    throw new Error(`Image fetch failed: ${r.status}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) {
    throw new Error("Image larger than 4MB");
  }
  let mime = "image/jpeg";
  const ct = r.headers.get("content-type");
  if (ct && ct.includes("image/")) {
    mime = ct.split(";")[0].trim();
  } else if (/\.png(\?|$)/i.test(url)) {
    mime = "image/png";
  } else if (/\.webp(\?|$)/i.test(url)) {
    mime = "image/webp";
  } else if (/\.gif(\?|$)/i.test(url)) {
    mime = "image/gif";
  }
  return { imageBase64: buf.toString("base64"), mimeType: mime };
}

async function notifySlackSimple(text) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const expected = secret ? `Bearer ${secret}` : "";
  if (!secret || auth !== expected) {
    return res.status(401).json({ error: "Unauthorized (set CRON_SECRET and use Bearer token)" });
  }

  const base =
    process.env.VERCEL_URL != null && process.env.VERCEL_URL !== ""
      ? `https://${process.env.VERCEL_URL}`
      : null;
  if (!base) {
    return res.status(500).json({ error: "VERCEL_URL is not set (run on Vercel)" });
  }

  const dailyUrl = (process.env.DAILY_IMAGE_URL || "").trim();
  const dailySummary = (process.env.DAILY_IMAGE_SUMMARY || "").trim();
  const audience = process.env.CRON_AUDIENCE || "";
  const ngWords = process.env.CRON_NG_WORDS || "";
  const variationHint = process.env.CRON_VARIATION_HINT || "";

  if (!dailyUrl && !dailySummary) {
    await notifySlackSimple(
      "[cron-daily] DAILY_IMAGE_URL または DAILY_IMAGE_SUMMARY が未設定です。Vercel の環境変数を確認してください。"
    );
    return res.status(200).json({
      ok: false,
      skipped: true,
      reason: "Neither DAILY_IMAGE_URL nor DAILY_IMAGE_SUMMARY is set",
    });
  }

  let payload;
  try {
    if (dailyUrl) {
      const img = await fetchImageAsBase64(dailyUrl);
      payload = {
        mode: "analyze",
        imageBase64: img.imageBase64,
        mimeType: img.mimeType,
        audience,
        ngWords,
        variationHint,
        notifySlack: true,
      };
    } else {
      payload = {
        mode: "regenerate",
        imageSummary: dailySummary,
        audience,
        ngWords,
        variationHint,
        notifySlack: true,
      };
    }
  } catch (e) {
    await notifySlackSimple(`[cron-daily] 準備で失敗: ${String(e)}`);
    return res.status(502).json({ error: String(e) });
  }

  const headers = {
    "Content-Type": "application/json",
  };

  let genRes;
  try {
    genRes = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (e) {
    await notifySlackSimple(`[cron-daily] generate 呼び出し失敗: ${String(e)}`);
    return res.status(502).json({ error: String(e) });
  }

  const text = await genRes.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    await notifySlackSimple(`[cron-daily] generate が JSON 以外を返しました (${genRes.status})`);
    return res.status(502).json({ error: "Invalid JSON from generate", status: genRes.status, raw: text.slice(0, 500) });
  }

  if (!genRes.ok) {
    await notifySlackSimple(
      `[cron-daily] generate エラー ${genRes.status}: ${json.error || text.slice(0, 200)}`
    );
    return res.status(genRes.status).json(json);
  }

  return res.status(200).json({
    ok: true,
    cron: true,
    mode: payload.mode,
    slack: json.slack,
    meta: json.meta,
  });
};
