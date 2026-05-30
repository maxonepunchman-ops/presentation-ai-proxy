async function readBody(req) {
  if (req.body) {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSlideIndex(value, max) {
  const index = Math.round(Number(value));

  if (!Number.isFinite(index)) return 0;

  return Math.min(Math.max(index, 0), Math.max(0, max - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs = 55000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenAiWithRetry(url, options) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, 55000);

      if (![429, 500, 502, 503, 504].includes(response.status)) {
        return response;
      }

      lastError = new Error(`OpenAI returned ${response.status}`);

      if (attempt < 3) {
        await sleep(700 * attempt);
      }
    } catch (error) {
      lastError = error;

      if (attempt < 3) {
        await sleep(700 * attempt);
      }
    }
  }

  throw lastError || new Error("OpenAI request failed");
}

function normalizeAssistantActions(parsed, slides, safeCurrentSlideIndex) {
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];

  return actions
    .map((action) => {
      const type =
        action?.type === "update_image"
          ? "update_image"
          : action?.type === "create_slide"
            ? "create_slide"
            : "update_text";

      const slideIndex = normalizeSlideIndex(action?.slideIndex, slides.length);

      if (type === "create_slide") {
        const rawCreateIndex = Math.round(Number(action?.slideIndex));
        const createSlideIndex = Number.isFinite(rawCreateIndex)
          ? Math.min(Math.max(rawCreateIndex, 0), slides.length)
          : Math.min(safeCurrentSlideIndex + 1, slides.length);

        const rawContent = Array.isArray(action?.content)
          ? action.content.map((item) => cleanText(item)).filter(Boolean)
          : [];

        return {
          type,
          slideIndex: createSlideIndex,
          title: cleanText(action?.title) || "Новый слайд",
          description: cleanText(action?.description),
          content: rawContent.length
            ? rawContent.slice(0, 4)
            : [
                "Ключевой тезис",
                "Важный акцент",
                "Практический смысл",
                "Итоговый вывод",
              ],
          imageQuery: cleanText(action?.imageQuery),
          imageDescription: cleanText(action?.imageDescription),
          imageMode: action?.imageMode === "specific" ? "specific" : "similar",
        };
      }

      if (type === "update_image") {
        return {
          type,
          slideIndex,
          title: "",
          description: "",
          content: [],
          imageQuery: cleanText(action?.imageQuery),
          imageDescription: cleanText(action?.imageDescription),
          imageMode: action?.imageMode === "specific" ? "specific" : "similar",
        };
      }

      const sourceSlide = slides[slideIndex] || {};
      const sourceContent = Array.isArray(sourceSlide?.content)
        ? sourceSlide.content
        : [];

      let nextContent = Array.isArray(action?.content)
        ? action.content.map((item) => cleanText(item))
        : [];

      if (!nextContent.length) {
        nextContent = sourceContent.map((item) => String(item ?? ""));
      }

      while (nextContent.length < sourceContent.length) {
        nextContent.push(nextContent[nextContent.length - 1] || "");
      }

      return {
        type,
        slideIndex,
        title: cleanText(action?.title) || cleanText(sourceSlide?.title),
        description:
          typeof action?.description === "string"
            ? cleanText(action.description)
            : cleanText(sourceSlide?.description),
        content: nextContent.slice(0, sourceContent.length || nextContent.length),
        imageQuery: "",
        imageDescription: "",
        imageMode: "similar",
      };
    })
    .filter((action) => {
      if (action.type === "update_image") return Boolean(action.imageQuery);
      if (action.type === "create_slide") {
        return Boolean(action.title || action.description || action.content?.length);
      }
      if (action.type === "update_text") {
        return Boolean(action.title || action.description || action.content?.length);
      }

      return false;
    });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-ai-proxy-secret"
  );
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const openaiApiKey = process.env.OPENAI_API_KEY;
  const proxySecret = process.env.AI_PROXY_SECRET;

  if (!openaiApiKey) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not configured on Vercel proxy",
      requestId,
    });
  }

  if (!proxySecret) {
    return res.status(500).json({
      error: "AI_PROXY_SECRET is not configured on Vercel proxy",
      requestId,
    });
  }

  const incomingSecret = req.headers["x-ai-proxy-secret"];

  if (incomingSecret !== proxySecret) {
    return res.status(401).json({
      error: "Unauthorized",
      requestId,
    });
  }

  try {
    const body = await readBody(req);

    const prompt = cleanText(body?.prompt);
    const currentSlideIndex = Math.round(Number(body?.currentSlideIndex || 0));
    const presentation = body?.presentation || {};
    const slides = Array.isArray(presentation?.slides) ? presentation.slides : [];

    if (!prompt) {
      return res.status(400).json({
        error: "Не передан запрос пользователя",
        requestId,
      });
    }

    if (!slides.length) {
      return res.status(400).json({
        error: "Не переданы слайды презентации",
        requestId,
      });
    }

    const safeCurrentSlideIndex = normalizeSlideIndex(
      currentSlideIndex,
      slides.length
    );

    const payload = {
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.35,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "presentation_assistant_actions",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              reply: {
                type: "string",
                minLength: 1,
                maxLength: 700,
              },
              actions: {
                type: "array",
                minItems: 0,
                maxItems: 80,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    type: {
                      type: "string",
                      enum: ["update_text", "update_image", "create_slide"],
                    },
                    slideIndex: {
                      type: "integer",
                      minimum: 0,
                    },
                    title: {
                      type: "string",
                    },
                    description: {
                      type: "string",
                    },
                    content: {
                      type: "array",
                      items: {
                        type: "string",
                      },
                    },
                    imageQuery: {
                      type: "string",
                    },
                    imageDescription: {
                      type: "string",
                    },
                    imageMode: {
                      type: "string",
                      enum: ["specific", "similar"],
                    },
                  },
                  required: [
                    "type",
                    "slideIndex",
                    "title",
                    "description",
                    "content",
                    "imageQuery",
                    "imageDescription",
                    "imageMode",
                  ],
                },
              },
            },
            required: ["reply", "actions"],
          },
        },
      },
      messages: [
        {
          role: "system",
          content: `
Ты — ИИ-ассистент редактора презентаций. Ты должен возвращать действия для изменения презентации.

Действия:
- update_text — изменить текст слайда;
- update_image — заменить изображение слайда;
- create_slide — создать новый слайд.

ВАЖНО:
- Если пользователь просит конкретную буквальную замену, выполни её буквально.
- «Замени всё на слово диван» значит title = «диван», description = «диван», каждый пункт content = «диван».
- Если пользователь просит поменять заголовок — меняй только заголовок.
- Если просит поменять описание — меняй описание.
- Если просит изменить весь слайд — меняй title, description и content.
- Если просит картинку — верни update_image.
- imageQuery всегда на английском.
- Если пользователь говорит «текущий слайд», используй currentSlideIndex.
- Если пользователь говорит «на всех слайдах», создай действия для всех слайдов.
- Если просит добавить слайд, верни create_slide.
- Не пиши технические детали JSON в reply.
- Если запрос непонятен, верни reply с уточнением и пустой actions.

Для update_text:
- заполняй title, description, content.
- imageQuery и imageDescription пустые строки.
- imageMode = "similar".

Для update_image:
- заполняй imageQuery, imageDescription, imageMode.
- title и description пустые строки.
- content пустой массив.

Для create_slide:
- заполняй title, description, content.
- если нужна картинка, заполни imageQuery.
- если картинка не нужна, imageQuery пустая строка.
- imageMode = "specific" или "similar".

Верни только JSON по схеме.
          `.trim(),
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              userPrompt: prompt,
              currentSlideIndex: safeCurrentSlideIndex,
              presentationTitle: String(presentation?.title || ""),
              themeName: String(presentation?.themeName || ""),
              slides: slides.map((slide, index) => ({
                index,
                title: String(slide?.title || ""),
                description: String(slide?.description || ""),
                content: Array.isArray(slide?.content)
                  ? slide.content.map((item) => String(item ?? ""))
                  : [],
                imageQuery: String(slide?.imageQuery || ""),
                hasImage: Boolean(slide?.hasImage),
              })),
            },
            null,
            2
          ),
        },
      ],
    };

    const openaiResponse = await fetchOpenAiWithRetry(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const responseText = await openaiResponse.text();

    if (!openaiResponse.ok) {
      return res.status(openaiResponse.status).json({
        error: "OpenAI request failed",
        details: responseText,
        requestId,
      });
    }

    const openaiData = JSON.parse(responseText);
    const rawContent = openaiData?.choices?.[0]?.message?.content;

    if (!rawContent) {
      return res.status(500).json({
        error: "Empty response from OpenAI",
        details: openaiData,
        requestId,
      });
    }

    let parsed = null;

    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return res.status(500).json({
        error: "Failed to parse OpenAI JSON",
        raw: rawContent,
        requestId,
      });
    }

    const normalizedActions = normalizeAssistantActions(
      parsed,
      slides,
      safeCurrentSlideIndex
    );

    return res.status(200).json({
      reply:
        typeof parsed?.reply === "string" && parsed.reply.trim()
          ? parsed.reply.trim()
          : normalizedActions.length
            ? "Готово, применяю правки."
            : "Я понял запрос, но нужно чуть точнее указать, что изменить.",
      actions: normalizedActions,
      requestId,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Assistant proxy error",
      message: error instanceof Error ? error.message : String(error),
      requestId,
    });
  }
}
