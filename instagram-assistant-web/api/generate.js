/**
 * Vercel Serverless: POST /api/generate
 * Body: { imageBase64, mimeType?, audience?, ngWords?, accessCode? }
 * Returns: { ok: true, data } or { error, ... }
 */

const VARIANTS = new Set(["empathy", "learning", "consultation"]);

function clip(text, max = 220) {
  if (!text || typeof text !== "string") return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildSlackMessage(result, meta) {
  const posts = Array.isArray(result.post_variants) ? result.post_variants : [];
  const byVariant = Object.fromEntries(posts.map((p) => [p.variant, p]));
  const ts = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const dateLabel = meta.clientDateLabel || ts;
  const empathy = byVariant.empathy || {};
  const learning = byVariant.learning || {};
  const consultation = byVariant.consultation || {};

  const lines = [
    `*今日の投稿案が生成されました* (${dateLabel})`,
    "",
    `*テーマ*`,
    `${result.interpretation?.theme || "-"}`,
    "",
    `*評価* 共感:${result.evaluation?.empathy ?? "-"} 保存:${result.evaluation?.save ?? "-"} コメント:${result.evaluation?.comment ?? "-"} 導線:${result.evaluation?.lead ?? "-"} 世界観:${result.evaluation?.brand_fit ?? "-"}`,
    "",
    `*投稿文（共感型）*`,
    clip(empathy.caption, 300),
    "",
    `*投稿文（学び型）*`,
    clip(learning.caption, 300),
    "",
    `*投稿文（相談導線型）*`,
    clip(consultation.caption, 300),
    "",
    `*ハッシュタグ* ${Array.isArray(result.hashtags) ? result.hashtags.join(" ") : "-"}`,
  ];
  return lines.join("\n");
}

async function sendSlack(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Slack webhook error: ${res.status} ${detail.slice(0, 400)}`);
  }
}

function validateOutput(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object") {
    return { ok: false, errors: ["root must be object"] };
  }

  const reqTop = [
    "selected_media",
    "alternative_media",
    "interpretation",
    "evaluation",
    "idea_cards",
    "post_variants",
    "hashtags",
    "stories_idea",
    "reel_idea",
    "self_check",
  ];
  for (const k of reqTop) {
    if (!(k in obj)) errors.push(`missing: ${k}`);
  }
  if (errors.length) return { ok: false, errors };

  const sm = obj.selected_media;
  if (!sm || typeof sm !== "object") errors.push("selected_media invalid");
  else {
    if (!["photo", "video"].includes(sm.kind)) errors.push("selected_media.kind");
    if (typeof sm.url !== "string") errors.push("selected_media.url");
    if (typeof sm.selection_summary !== "string") errors.push("selected_media.selection_summary");
  }

  if (!Array.isArray(obj.alternative_media) || obj.alternative_media.length > 3) {
    errors.push("alternative_media must be array max 3");
  } else {
    obj.alternative_media.forEach((a, i) => {
      if (!a || typeof a !== "object") errors.push(`alternative_media[${i}]`);
      else {
        if (!["photo", "video"].includes(a.kind)) errors.push(`alternative_media[${i}].kind`);
        if (typeof a.url !== "string") errors.push(`alternative_media[${i}].url`);
        if (typeof a.label !== "string") errors.push(`alternative_media[${i}].label`);
      }
    });
  }

  const interp = obj.interpretation;
  if (!interp || typeof interp !== "object") errors.push("interpretation");
  else {
    ["theme", "direction", "reason"].forEach((f) => {
      if (typeof interp[f] !== "string") errors.push(`interpretation.${f}`);
    });
  }

  const ev = obj.evaluation;
  if (!ev || typeof ev !== "object") errors.push("evaluation");
  else {
    ["empathy", "save", "comment", "lead", "brand_fit"].forEach((f) => {
      const n = ev[f];
      if (typeof n !== "number" || n < 1 || n > 5) errors.push(`evaluation.${f}`);
    });
    if (ev.scale_max !== 5) errors.push("evaluation.scale_max must be 5");
    if (typeof ev.note !== "string") errors.push("evaluation.note");
  }

  if (!Array.isArray(obj.idea_cards) || obj.idea_cards.length < 3 || obj.idea_cards.length > 4) {
    errors.push("idea_cards must have 3-4 items");
  } else {
    obj.idea_cards.forEach((c, i) => {
      if (!c || typeof c.text !== "string") errors.push(`idea_cards[${i}].text`);
    });
  }

  if (!Array.isArray(obj.post_variants) || obj.post_variants.length !== 3) {
    errors.push("post_variants must have exactly 3 items");
  } else {
    const seen = new Set();
    obj.post_variants.forEach((p, i) => {
      if (!p || typeof p !== "object") {
        errors.push(`post_variants[${i}]`);
        return;
      }
      if (!VARIANTS.has(p.variant)) errors.push(`post_variants[${i}].variant`);
      else seen.add(p.variant);
      ["goal", "hook", "caption"].forEach((f) => {
        if (typeof p[f] !== "string") errors.push(`post_variants[${i}].${f}`);
      });
    });
    if (seen.size !== 3) errors.push("post_variants must include empathy, learning, consultation once each");
  }

  if (!Array.isArray(obj.hashtags)) errors.push("hashtags");
  else obj.hashtags.forEach((h, i) => {
    if (typeof h !== "string") errors.push(`hashtags[${i}]`);
  });

  if (typeof obj.stories_idea !== "string") errors.push("stories_idea");
  if (typeof obj.reel_idea !== "string") errors.push("reel_idea");
  if ("image_summary" in obj && typeof obj.image_summary !== "string") {
    errors.push("image_summary must be string when present");
  }

  const sc = obj.self_check;
  if (!sc || typeof sc !== "object" || !Array.isArray(sc.items)) {
    errors.push("self_check.items");
  } else {
    sc.items.forEach((it, i) => {
      if (!it || typeof it.label !== "string" || typeof it.passed !== "boolean") {
        errors.push(`self_check.items[${i}]`);
      }
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

function buildSystemPrompt() {
  return [
    "You output a single JSON object only (no markdown, no code fences).",
    "Language: Japanese for all user-facing strings.",
    "Tone: warm, trustworthy, not pushy, avoid strong claims.",
    "Goals: empathy, saves, trust, DMs — not viral tricks.",
    "",
    "Rules:",
    "- selected_media.kind is photo or video. For user-uploaded still images use kind: photo.",
    "- selected_media.url: use the literal string \"user-upload\" for the analyzed upload.",
    "- alternative_media: max 3 items. If only one image exists, use [] or up to 3 placeholder entries with kind photo, url \"placeholder\", label describing a different crop/angle conceptually.",
    "- evaluation: integers 1-5 for empathy, save, comment, lead, brand_fit. scale_max is always 5. note explains trust-first scoring.",
    "- idea_cards: 3 or 4 items, each { title?: string, text: string }.",
    "- post_variants: exactly 3 objects with variant empathy, learning, consultation (each once). caption may use \\n for line breaks.",
    "- hashtags: array of strings, may include #.",
    "- self_check.items: array of { label: string, passed: boolean } for quality checks.",
    "- image_summary: concise Japanese summary (2-4 sentences) of the media context for cheap text-only regeneration.",
  ].join("\n");
}

function buildImageSummaryFallback(parsed) {
  const theme = parsed?.interpretation?.theme || "";
  const reason = parsed?.interpretation?.reason || "";
  const selection = parsed?.selected_media?.selection_summary || "";
  const lines = [theme, reason, selection].filter(Boolean);
  if (!lines.length) {
    return "日常の雰囲気とテーマを短く整理した要約。再生成時はこの要約を前提に文案だけ更新する。";
  }
  return lines.join(" ").slice(0, 500);
}

function buildDummyOutput({ mode, imageSummary, audience, variationHint }) {
  const isRegenerate = mode === "regenerate";
  const summary =
    (isRegenerate && imageSummary) ||
    "朝のデスクでコーヒーを置いた静かな日常シーン。整え直す・深呼吸・小さく始める文脈が合う。";
  const audienceText = audience ? `（対象: ${audience}）` : "";
  const variationText = variationHint ? ` 再生成ヒント: ${variationHint}` : "";

  return {
    selected_media: {
      kind: "photo",
      url: "user-upload",
      alt_text: "朝のデスクとコーヒー",
      selection_summary: `ダミーモードのため固定サンプルを返しています${audienceText}。`,
    },
    alternative_media: [
      { kind: "photo", url: "placeholder", label: "手元アップ" },
      { kind: "photo", url: "placeholder", label: "机全体の引き" },
      { kind: "photo", url: "placeholder", label: "光のある窓際" },
    ],
    interpretation: {
      theme: "忙しい朝でも自分のペースを取り戻す",
      direction: "共感→気づき→やさしい締め",
      reason: `落ち着いた日常感が信頼導線に向く。${variationText}`.trim(),
    },
    evaluation: {
      empathy: 4,
      save: 4,
      comment: 3,
      lead: 4,
      brand_fit: 5,
      scale_max: 5,
      note: "ダミーモードの仮評価（信頼重視）",
    },
    idea_cards: [
      { text: "完璧より継続。1分で始める行動は保存されやすい。" },
      { text: "キャプション1行目は共感、2行目で気づきを入れる。" },
      { text: "相談導線は『一緒に整理』の言い回しが安心される。" },
    ],
    post_variants: [
      {
        variant: "empathy",
        goal: "保存",
        hook: "朝が重い日があっても大丈夫",
        caption:
          "今日はうまく始められない朝だった。\n\nそれでも、コーヒーを一口飲んで深呼吸したら少し戻れた。\n\n完璧じゃなくても、始めた自分を認めたい。",
      },
      {
        variant: "learning",
        goal: "フォロー",
        hook: "意志力より環境の工夫",
        caption:
          "集中が切れる日は、意志ではなく視界の情報量を減らす。\n\n机には『今やる1枚』だけ置く。\n\nこれだけで、迷いが減って進みやすくなる。",
      },
      {
        variant: "consultation",
        goal: "DM",
        hook: "忙しいのに進んでいない感覚",
        caption:
          "タスクは多いのに進まないとき、優先順位が言葉になっていないことが多いです。\n\nよければDMで、いま一番詰まっていることを1つだけ教えてください。\n一緒に3つまで整理します。",
      },
    ],
    hashtags: ["#仕事と暮らし", "#朝の習慣", "#自分のペース", "#相談歓迎"],
    stories_idea: "朝の1分ルーティンを質問スタンプ付きで共有。",
    reel_idea: "0-3秒で共感テロップ、4-12秒で小さな行動、最後にやさしい導線。",
    self_check: {
      items: [
        { label: "売り込みが強すぎない", passed: true },
        { label: "断定しすぎていない", passed: true },
        { label: "共感→気づき→やさしい締め", passed: true },
      ],
    },
    image_summary: summary,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Access-Code");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const expected = process.env.ACCESS_CODE;
  if (expected) {
    const sent = req.headers["x-access-code"];
    if (sent !== expected) {
      return res.status(401).json({ error: "Invalid or missing access code" });
    }
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }

  const {
    imageBase64,
    mimeType = "image/jpeg",
    audience = "",
    ngWords = "",
    mode = "analyze",
    imageSummary = "",
    variationHint = "",
    notifySlack = false,
    clientDateLabel = "",
  } = body || {};

  const dummyEnabledByEnv = ["1", "true", "yes", "on"].includes(
    String(process.env.DUMMY_MODE || "").toLowerCase()
  );
  const useDummy = dummyEnabledByEnv || body?.useDummy === true;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && !useDummy) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not configured on the server (or enable DUMMY_MODE=true for UI testing)",
    });
  }
  const isRegenerate = mode === "regenerate";
  const isAnalyze = mode === "analyze";
  if (!isAnalyze && !isRegenerate) {
    return res.status(400).json({ error: "mode must be analyze or regenerate" });
  }
  if (isAnalyze && (!imageBase64 || typeof imageBase64 !== "string")) {
    return res.status(400).json({ error: "imageBase64 (base64 string, no data: prefix) is required in analyze mode" });
  }
  if (isRegenerate && (!imageSummary || typeof imageSummary !== "string")) {
    return res.status(400).json({ error: "imageSummary is required in regenerate mode" });
  }

  const dataUrl = isAnalyze ? `data:${mimeType};base64,${imageBase64}` : "";

  const systemPrompt = buildSystemPrompt();
  const userText = [
    isAnalyze
      ? "Analyze this image for Instagram post ideas."
      : "Regenerate Instagram post ideas from the given image_summary only (do not assume new visuals).",
    audience ? `Target / brand context: ${audience}` : "",
    ngWords ? `Avoid or be careful with: ${ngWords}` : "",
    isRegenerate ? `image_summary: ${imageSummary}` : "",
    variationHint ? `Variation request: ${variationHint}` : "",
    "Fill every required field in the JSON schema described in system instructions.",
  ]
    .filter(Boolean)
    .join("\n");

  let parsed;
  if (useDummy) {
    parsed = buildDummyOutput({ mode, imageSummary, audience, variationHint });
  } else {
    let openaiRes;
    try {
      openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.55,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: isAnalyze
                ? [
                    { type: "text", text: userText },
                    { type: "image_url", image_url: { url: dataUrl } },
                  ]
                : [{ type: "text", text: userText }],
            },
          ],
        }),
      });
    } catch (e) {
      return res.status(502).json({ error: "Failed to reach OpenAI", detail: String(e) });
    }

    const rawText = await openaiRes.text();
    if (!openaiRes.ok) {
      return res.status(502).json({ error: "OpenAI API error", detail: rawText });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: "Invalid response from OpenAI" });
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      return res.status(502).json({ error: "Empty model output", detail: data });
    }

    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(502).json({ error: "Model returned non-JSON text", raw: content.slice(0, 2000) });
    }
  }

  const check = validateOutput(parsed);
  if (!check.ok) {
    return res.status(422).json({
      error: "Model output failed validation",
      details: check.errors,
      partial: parsed,
    });
  }
  if (!parsed.image_summary || typeof parsed.image_summary !== "string") {
    parsed.image_summary = isRegenerate && imageSummary ? imageSummary : buildImageSummaryFallback(parsed);
  }

  const slackStatus = {
    requested: Boolean(notifySlack),
    sent: false,
    skippedReason: "",
  };

  if (notifySlack) {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      slackStatus.skippedReason = "SLACK_WEBHOOK_URL is not configured";
    } else {
      try {
        const msg = buildSlackMessage(parsed, { clientDateLabel });
        await sendSlack(webhookUrl, msg);
        slackStatus.sent = true;
      } catch (err) {
        slackStatus.skippedReason = String(err);
      }
    }
  }

  return res.status(200).json({
    ok: true,
    data: parsed,
    slack: slackStatus,
    meta: {
      mode,
      image_summary: parsed.image_summary,
      source: useDummy ? "dummy" : "openai",
    },
  });
};
