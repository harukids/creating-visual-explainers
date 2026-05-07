/**
 * Vercel Serverless: POST /api/generate
 * Body: { mode?, imageBase64?, mimeType?, audience?, workContext?, ngWords?, imageSummary?, variationHint?, notifySlack? }
 * Empty audience/workContext → optional env DEFAULT_AUDIENCE / DEFAULT_WORK_CONTEXT (Vercel).
 * Optional env GENERATE_SECRET → require Authorization: Bearer <same> (abuse / billing protection).
 * Returns: { ok: true, data } or { error, ... }
 */

const crypto = require("crypto");

const VARIANTS = new Set(["empathy", "learning", "consultation"]);
/** ~4MB binary in base64 ≈ 5.6M chars; keep margin vs client 4MB cap */
const MAX_IMAGE_BASE64_CHARS = 6 * 1024 * 1024;
const VARIANT_ORDER = ["empathy", "learning", "consultation"];

function logGenerate(tag, payload) {
  try {
    const s =
      typeof payload === "string"
        ? payload.slice(0, 1200)
        : JSON.stringify(payload ?? "").slice(0, 1200);
    console.error(`[generate] ${tag}`, s);
  } catch (_) {
    console.error(`[generate] ${tag}`);
  }
}

function bearerMatchesGenerateSecret(authorizationHeader, secret) {
  if (!secret) return true;
  const m = /^Bearer\s+(\S+)/i.exec(authorizationHeader || "");
  const token = m ? m[1] : "";
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(String(secret), "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function clip(text, max = 220) {
  if (!text || typeof text !== "string") return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildSlackMessage(result) {
  const posts = Array.isArray(result.post_variants) ? result.post_variants : [];
  const byVariant = Object.fromEntries(posts.map((p) => [p.variant, p]));
  const ts = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const empathy = byVariant.empathy || {};
  const learning = byVariant.learning || {};
  const consultation = byVariant.consultation || {};
  const themeLine = clip(String(result.interpretation?.theme || "-"), 240);
  const tagsLine = clip(
    Array.isArray(result.hashtags) ? result.hashtags.join(" ") : "-",
    400
  );

  const lines = [
    `*今日の投稿案が生成されました* (${ts})`,
    "",
    `*テーマ*`,
    themeLine,
    "",
    `*評価* 共感:${result.evaluation?.empathy ?? "-"} 保存:${result.evaluation?.save ?? "-"} コメント:${result.evaluation?.comment ?? "-"} 導線:${result.evaluation?.lead ?? "-"} 世界観:${result.evaluation?.brand_fit ?? "-"}`,
    "",
    `*投稿文（共感型）*`,
    clip(empathy.caption, 900),
    "",
    `*投稿文（学び型）*`,
    clip(learning.caption, 900),
    "",
    `*投稿文（相談導線型）*`,
    clip(consultation.caption, 900),
    "",
    `*ハッシュタグ* ${tagsLine}`,
  ];
  return clip(lines.join("\n"), 5000);
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

function resolvePostVariantKey(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (VARIANTS.has(s)) return s;
  const lower = s.toLowerCase();
  if (VARIANTS.has(lower)) return lower;
  const alias = {
    empathic: "empathy",
    sympathy: "empathy",
    emotional: "empathy",
    learn: "learning",
    educational: "learning",
    insight: "learning",
    consult: "consultation",
    consulting: "consultation",
    dm: "consultation",
    共感: "empathy",
    学び: "learning",
    相談: "consultation",
  };
  return alias[s] || alias[lower] || null;
}

/** Ensure exactly 3 items: empathy, learning, consultation with string goal/hook/caption. */
function normalizePostVariants(obj) {
  const theme =
    typeof obj.interpretation?.theme === "string" ? obj.interpretation.theme.trim() : "";
  const direction =
    typeof obj.interpretation?.direction === "string" ? obj.interpretation.direction.trim() : "";
  const baseCaption = theme || direction || "今日のひとことが伝わる投稿";

  const stubs = {
    empathy: {
      goal: "読者の気持ちに寄り添う",
      hook: "まず共感の一言",
      caption: `${baseCaption}について、いまの気持ちにそっと寄り添う一文から始めます。\n\n写真のような瞬間は、誰にでもあるけれど言葉にしにくいことが多いです。だからこそ、整え直すきっかけを、やさしく共有したいです。\n\n（※モデル出力が短かった場合の補完文案です。再生成で長めの案を出してください。）`,
    },
    learning: {
      goal: "小さな学び・視点を渡す",
      hook: "気づきを一言で",
      caption: `${baseCaption}をテーマに、今日ひとつだけ持ち帰れる視点を書きます。\n\n毎日を丁寧に積み重ねるほど、見えてくるコツや例外もあります。難しく語らず、日常に落とし込める形でまとめました。\n\n（※補完文案のため短い場合は再生成を試してください。）`,
    },
    consultation: {
      goal: "自然な相談・DM導線",
      hook: "続きは個別で、と自然に",
      caption: `${baseCaption}のまわりで、もやもやが続いている方へ。\n\nここでは断定せず、一緒に整理できる余地だけを残したいと思っています。もし一言だけ共有してよければ、DMでも大丈夫です。\n\n（※押し売りはしない前提の補完文案です。）`,
    },
  };

  function coerceStr(x, fallback) {
    if (typeof x === "string" && x.trim()) return x;
    if (x != null && typeof x !== "object") return String(x).trim() || fallback;
    return fallback;
  }

  const raw = Array.isArray(obj.post_variants) ? obj.post_variants : [];
  const byVariant = {};

  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const key = resolvePostVariantKey(p.variant);
    if (key) byVariant[key] = { ...p, variant: key };
  }

  const unmapped = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    if (!resolvePostVariantKey(p.variant)) unmapped.push(p);
  }

  for (let i = 0; i < VARIANT_ORDER.length; i++) {
    const k = VARIANT_ORDER[i];
    if (byVariant[k]) continue;
    const pick = unmapped.shift();
    if (pick) byVariant[k] = { ...pick, variant: k };
  }

  if (VARIANT_ORDER.some((k) => !byVariant[k]) && raw.length >= 3) {
    VARIANT_ORDER.forEach((k, i) => {
      if (!byVariant[k] && raw[i] && typeof raw[i] === "object") {
        byVariant[k] = { ...raw[i], variant: k };
      }
    });
  }

  obj.post_variants = VARIANT_ORDER.map((k) => {
    const p = byVariant[k] || {};
    const st = stubs[k];
    return {
      variant: k,
      goal: coerceStr(p.goal, st.goal),
      hook: coerceStr(p.hook, st.hook),
      caption: coerceStr(p.caption, st.caption),
    };
  });
}

/** Coerce common model slips before validateOutput (scale_max, selection_summary, note, score types). */
function normalizeInstagramPayload(obj) {
  if (!obj || typeof obj !== "object") return obj;

  if (!obj.selected_media || typeof obj.selected_media !== "object") {
    obj.selected_media = { kind: "photo", url: "user-upload", selection_summary: "" };
  }
  const sm = obj.selected_media;
  if (!["photo", "video"].includes(sm.kind)) sm.kind = "photo";
  if (typeof sm.url !== "string") sm.url = "user-upload";
  if (typeof sm.selection_summary !== "string" || !String(sm.selection_summary).trim()) {
    const theme = obj.interpretation?.theme;
    const dir = obj.interpretation?.direction;
    const base =
      typeof theme === "string" && theme.trim()
        ? theme.trim()
        : typeof dir === "string" && dir.trim()
          ? dir.trim()
          : "";
    sm.selection_summary =
      base.slice(0, 400) || "発信に適したメディアとして選定（ユーザー投稿）。";
  }

  if (!obj.evaluation || typeof obj.evaluation !== "object") {
    obj.evaluation = {};
  }
  const ev = obj.evaluation;
  ev.scale_max = 5;
  if (typeof ev.note !== "string" || !String(ev.note).trim()) {
    ev.note =
      "共感・保存・コメント・導線・ブランド整合を1〜5で評価。信頼重視の観点です。";
  }
  ["empathy", "save", "comment", "lead", "brand_fit"].forEach((k) => {
    let n = ev[k];
    if (typeof n === "string" && n.trim() !== "" && !Number.isNaN(Number(n))) {
      n = Number(n);
    }
    if (typeof n !== "number" || Number.isNaN(n)) {
      ev[k] = 3;
    } else {
      ev[k] = Math.max(1, Math.min(5, Math.round(n)));
    }
  });

  normalizePostVariants(obj);

  return obj;
}

/**
 * アカウントのブランド前提（Vercel の BRAND_GUIDELINES で全文置換可能）。
 * 未設定時はこの既定を使用する。
 */
const DEFAULT_BRAND_GUIDELINES = [
  "あなたはInstagramブランド設計のプロとして、このアカウント向けに次を前提に文案・構成・トーンを作ること。",
  "",
  "■ 世界観・テーマ",
  "美容・健康・AI活用・ライフデザイン。「自分らしく整って生きる」を軸に発信している。",
  "",
  "■ 発信者の横断的な強み（必要に応じて自然に織り込む）",
  "MC/司会業、美容健康分野の知識、予防医療視点、Nu Skinビジネス、AI活用。",
  "",
  "■ 目的（単なる情報発信で終わらせない）",
  "世界観への共感、信頼構築、「この人素敵」と感じてもらうこと、将来的な集客、価値観の合う仲間の形成。",
  "",
  "■ 禁止トーン・禁止構造",
  "煽り、説教、過度な不安訴求、情報商材っぽさ、強いMLM感、押し売り感、キラキラ起業女子感、安っぽいバズ狙い。",
  "",
  "■ 質感（優先）",
  "上品、知的、柔らかい、人間味、余韻、共感。「正論」より「気づき」を届ける投稿を優先する。",
  "",
  "■ 導線",
  "保存・共感されやすい、自然な感情の流れを設計する。",
].join("\n");

function appendBrandGuidelinesBlock() {
  const fromEnv = process.env.BRAND_GUIDELINES;
  const text =
    typeof fromEnv === "string" && fromEnv.trim()
      ? fromEnv.trim()
      : DEFAULT_BRAND_GUIDELINES;
  return `\n\n--- Instagram brand (always apply) ---\n${text}`;
}

function buildSystemPrompt() {
  return [
    "You output a single JSON object only (no markdown, no code fences).",
    "Language: Japanese for all user-facing strings.",
    "Tone: warm, trustworthy, not pushy, avoid strong claims.",
    "Goals: empathy, saves, trust, DMs — not viral tricks.",
    "",
    "Depth (when user gives business/work context):",
    "- Anchor hooks, captions, idea_cards, stories_idea, and reel_idea to that context: reader situation, your role/service, and one concrete takeaway they can use — avoid vague self-help filler unrelated to their work.",
    "- interpretation.reason should state briefly how this post supports their professional or business intent.",
    "",
    "CRITICAL — include ALL top-level keys (never omit):",
    "selected_media, alternative_media, interpretation, evaluation, idea_cards, post_variants, hashtags, stories_idea, reel_idea, self_check, image_summary",
    "",
    "- interpretation MUST be an object with exactly: theme (string), direction (string), reason (string). Never omit interpretation.",
    "- stories_idea MUST be a non-empty string (Instagram Stories ideas in Japanese).",
    "- reel_idea MUST be a non-empty string (short-form reel outline in Japanese).",
    "",
    "Rules:",
    "- selected_media.kind is photo or video. For user-uploaded still images use kind: photo.",
    "- selected_media.url: use the literal string \"user-upload\" for the analyzed upload.",
    "- selected_media.selection_summary: REQUIRED non-empty string (Japanese): why this photo/video fits the post.",
    "- alternative_media: max 3 items. If only one image exists, use [] or up to 3 placeholder entries with kind photo, url \"placeholder\", label describing a different crop/angle conceptually.",
    "- evaluation: integers 1-5 for empathy, save, comment, lead, brand_fit. MUST set scale_max to the number 5 (not 10). MUST include note as a string (trust-first scoring explanation).",
    "- idea_cards: 3 or 4 items, each { title?: string, text: string }.",
    "- post_variants: exactly 3 objects in order. variant MUST be the English strings exactly: \"empathy\", \"learning\", \"consultation\" (one each, no synonyms). Each object MUST have goal, hook, caption as strings (Japanese). caption may use \\n for line breaks.",
    "",
    "Post length — post_variants.caption (IMPORTANT):",
    "- Each caption must be a full Instagram-ready body, NOT a single short sentence. Aim for roughly 400–900 Japanese characters per caption (longer is OK when it adds concrete detail, mini-story, or layered nuance). Avoid ultra-short captions.",
    "- Structure with multiple paragraphs (typically 3–6 blocks); separate paragraphs with a blank line inside caption using newline characters (JSON string may contain \\n between paragraphs). Flow example: opening that lands emotionally → concrete scene or observation → gentle insight → soft landing (question or breathing-room close). Consultation variant may end with a low-pressure invitation.",
    "- hook should be punchy but the caption field must still carry the bulk of the story; do not offload everything into hook alone.",
    "- hashtags: array of strings, may include #.",
    "- self_check.items: array of { label: string, passed: boolean } for quality checks.",
    "- image_summary: concise Japanese summary (2-4 sentences) of the media context for cheap text-only regeneration.",
  ].join("\n") + appendBrandGuidelinesBlock();
}

async function openAiCompleteJson({
  apiKey,
  systemPrompt,
  isAnalyze,
  userText,
  dataUrl,
  temperature = 0.55,
}) {
  const userContent = isAnalyze
    ? [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: dataUrl } },
      ]
    : [{ type: "text", text: userText }];

  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: userContent,
        },
      ],
    }),
  });

  const rawText = await openaiRes.text();
  if (!openaiRes.ok) {
    return { ok: false, error: "openai_http", detail: rawText, status: openaiRes.status };
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    return { ok: false, error: "openai_parse_meta", detail: rawText };
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    return { ok: false, error: "empty_content", detail: data };
  }

  try {
    const parsed = JSON.parse(content);
    return { ok: true, parsed, rawContent: content };
  } catch {
    return { ok: false, error: "json_parse_content", raw: content.slice(0, 2000) };
  }
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

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const generateSecret = process.env.GENERATE_SECRET;
  if (generateSecret && !bearerMatchesGenerateSecret(req.headers.authorization, generateSecret)) {
    return res.status(401).json({ error: "Unauthorized" });
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
    audience: audienceRaw = "",
    workContext: workContextRaw = "",
    ngWords = "",
    mode = "analyze",
    imageSummary = "",
    variationHint = "",
    notifySlack = false,
  } = body || {};

  const audience = typeof audienceRaw === "string" ? audienceRaw : "";
  const workContext = typeof workContextRaw === "string" ? workContextRaw : "";

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not configured on the server",
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
  if (isAnalyze && imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
    return res.status(413).json({ error: "Image payload too large" });
  }
  if (isRegenerate && (!imageSummary || typeof imageSummary !== "string")) {
    return res.status(400).json({ error: "imageSummary is required in regenerate mode" });
  }

  const dataUrl = isAnalyze ? `data:${mimeType};base64,${imageBase64}` : "";

  const systemPrompt = buildSystemPrompt();
  const trimmedAudience = audience.trim();
  const trimmedWork = workContext.trim();
  const defaultAudience =
    typeof process.env.DEFAULT_AUDIENCE === "string"
      ? process.env.DEFAULT_AUDIENCE.trim()
      : "";
  const defaultWork =
    typeof process.env.DEFAULT_WORK_CONTEXT === "string"
      ? process.env.DEFAULT_WORK_CONTEXT.trim()
      : "";
  const audienceEffective = trimmedAudience || defaultAudience;
  const wc = trimmedWork || defaultWork;
  const userText = [
    isAnalyze
      ? "Analyze this image for Instagram post ideas."
      : "Regenerate Instagram post ideas from the given image_summary only (do not assume new visuals).",
    audienceEffective ? `Target / brand context: ${audienceEffective}` : "",
    wc
      ? `Business & intent (ALL copy must reflect this — be specific, not generic): ${wc}`
      : "",
    ngWords ? `Avoid or be careful with: ${ngWords}` : "",
    isRegenerate ? `image_summary: ${imageSummary}` : "",
    variationHint ? `Variation request: ${variationHint}` : "",
    "post_variants.caption: write full-length Japanese captions per system instructions (~400–900 characters each, multiple paragraphs with blank lines). Do not output one-line or token-short captions.",
    "Fill every required field in the JSON schema described in system instructions.",
  ]
    .filter(Boolean)
    .join("\n");

  let parsed;
  let first;
  try {
    first = await openAiCompleteJson({
      apiKey,
      systemPrompt,
      isAnalyze,
      userText,
      dataUrl,
      temperature: 0.55,
    });
  } catch (e) {
    logGenerate("openai_fetch_exception", String(e));
    return res.status(502).json({ error: "Failed to reach OpenAI" });
  }

  if (!first.ok) {
    if (first.error === "openai_http") {
      logGenerate("openai_http", first.detail);
      return res.status(502).json({ error: "OpenAI API request failed" });
    }
    logGenerate("openai_bad_response", first.detail || first.raw);
    return res.status(502).json({
      error:
        first.error === "json_parse_content" ? "Model returned non-JSON text" : "Invalid response from OpenAI",
    });
  }

  parsed = first.parsed;
  normalizeInstagramPayload(parsed);
  let v1 = validateOutput(parsed);

  if (!v1.ok) {
    const repairSystem = `${buildSystemPrompt()}\n\nREPAIR: Previous output was rejected. Output ONE complete JSON object. Do not omit interpretation, stories_idea, reel_idea, or any top-level key. post_variants must be exactly 3 objects with variant literally empathy, learning, consultation (English), each with goal, hook, caption strings. Each caption must stay substantive (~400+ Japanese characters, multiple paragraphs with blank lines) per system rules.`;
    const repairUser = `${userText}\n\nValidation errors: ${v1.errors.join("; ")}.\nReturn the full JSON again with every required field.`;

    let second;
    try {
      second = await openAiCompleteJson({
        apiKey,
        systemPrompt: repairSystem,
        isAnalyze,
        userText: repairUser,
        dataUrl,
        temperature: 0.35,
      });
    } catch (e) {
      logGenerate("openai_retry_exception", String(e));
      return res.status(502).json({ error: "Failed to reach OpenAI on retry" });
    }

    if (!second.ok) {
      logGenerate("openai_retry_failed", second.detail || second.raw);
      return res.status(422).json({
        error: "Model output failed validation",
        details: v1.errors,
        partial: parsed,
        retry_failed: true,
      });
    }

    parsed = second.parsed;
    normalizeInstagramPayload(parsed);
  }

  normalizeInstagramPayload(parsed);
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
        const msg = buildSlackMessage(parsed);
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
      source: "openai",
      context_defaults: {
        audience: trimmedAudience ? "form" : defaultAudience ? "env:DEFAULT_AUDIENCE" : "none",
        workContext: trimmedWork ? "form" : defaultWork ? "env:DEFAULT_WORK_CONTEXT" : "none",
      },
    },
  });
};
