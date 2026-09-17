const express = require("express");
const multer = require("multer");

const app = express();
app.disable("x-powered-by");

const MAX_FILE_SIZE = 12 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

function buildPrompt(mode, strength) {
  const shared = [
    "Use the uploaded image as the sole visual reference.",
    "Create a genuinely new, fully rendered image rather than applying pixelation, a mosaic, an overlay, or a simple filter.",
    "Rebuild every visible element as polished three-dimensional voxel art made from clearly defined cubes and block geometry.",
    "Keep the original color relationships, lighting direction, main subjects, and visual storytelling recognizable.",
    "No text, captions, logos, watermarks, split screen, borders, UI, or before-and-after layout.",
    `Stylization intensity: ${strength} out of 100.`,
  ];

  if (mode === "diorama") {
    return [
      ...shared,
      "Reinterpret the entire scene as a charming isometric miniature floating block-world diorama.",
      "Preserve the main subject and narrative cues, but organize the environment into readable stepped terrain, cubic vegetation, water, architecture, and small block-built props where relevant.",
      "Use a clean three-quarter isometric camera, convincing ambient occlusion, soft studio lighting, crisp edges, vivid but balanced colors, and a premium game-art render finish.",
      "The final result should feel like a complete handcrafted voxel world, not a crop of the source photo.",
    ].join(" ");
  }

  return [
    ...shared,
    "Transform the full photograph into a cinematic voxel character scene inspired by premium block-building game artwork.",
    "Preserve the exact number of people, their positions, poses, gestures, expressions, relative scale, camera framing, clothing colors and patterns, hairstyle silhouettes, and the recognizable layout of the background.",
    "Convert faces, hair, skin, clothing, furniture, and architecture into cohesive block-built 3D forms while keeping each person identifiable from the source.",
    "Use warm cinematic lighting, realistic block-material shading, subtle ambient occlusion, crisp cubic edges, and detailed but readable voxel geometry.",
  ].join(" ");
}

function requireSharedToken(req, res, next) {
  const configured = process.env.BLOCKIFY_SHARED_TOKEN;
  const supplied = req.get("x-blockify-token");
  if (!configured || !supplied || supplied !== configured) {
    return res.status(401).json({ error: "Недействительный запрос к серверу генерации." });
  }
  return next();
}

app.get("/", (_req, res) => {
  res.json({ service: "blockify-backend", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.post("/stylize", requireSharedToken, upload.single("image"), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        error: "Генеративная модель ещё не подключена. Добавьте OPENAI_API_KEY в Render.",
      });
    }

    const image = req.file;
    if (!image) return res.status(400).json({ error: "Изображение не найдено в запросе." });
    if (!ACCEPTED_TYPES.has(image.mimetype)) {
      return res.status(415).json({ error: "Поддерживаются только JPG, PNG и WEBP." });
    }

    const mode = req.body.mode === "diorama" ? "diorama" : "portrait";
    const rawStrength = Number(req.body.strength);
    const strength = Number.isFinite(rawStrength)
      ? Math.min(100, Math.max(40, Math.round(rawStrength)))
      : 72;

    const body = new FormData();
    body.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst");
    body.append(
      "image[]",
      new Blob([image.buffer], { type: image.mimetype }),
      image.originalname || "source-image"
    );
    body.append("prompt", buildPrompt(mode, strength));
    body.append("quality", "high");
    body.append("size", "auto");

    const upstream = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body,
      signal: AbortSignal.timeout(240000),
    });

    const requestId = upstream.headers.get("x-request-id");
    const payload = await upstream.json();

    if (!upstream.ok) {
      const code = payload.error?.code;
      const message =
        upstream.status === 401
          ? "Ключ OpenAI недействителен. Обновите OPENAI_API_KEY в Render."
          : upstream.status === 429
            ? "Лимит OpenAI API исчерпан или запросов слишком много."
            : code === "content_policy_violation"
              ? "Модель не смогла обработать это изображение из-за ограничений безопасности."
              : payload.error?.message || "Сервис генерации временно недоступен.";
      return res.status(upstream.status >= 500 ? 502 : upstream.status).json({
        error: message,
        requestId,
      });
    }

    const base64 = payload.data?.[0]?.b64_json;
    if (!base64) {
      return res.status(502).json({
        error: "Модель не вернула изображение. Попробуйте ещё раз.",
        requestId,
      });
    }

    return res.json({ image: `data:image/png;base64,${base64}`, requestId });
  } catch (error) {
    console.error("stylize_failed", error);
    const timeout = error?.name === "TimeoutError";
    return res.status(timeout ? 504 : 500).json({
      error: timeout
        ? "Генерация заняла слишком много времени. Повторите попытку."
        : "Не удалось завершить генерацию. Повторите попытку.",
    });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Файл больше 12 МБ." });
  }
  console.error("request_failed", error);
  return res.status(500).json({ error: "Не удалось обработать запрос." });
});

const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", () => {
  console.log(`Blockify backend listening on port ${port}`);
});
