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

function normalizeSlideCount(value) {
  const count = Math.round(Number(value));

  if (!Number.isFinite(count)) {
    return 6;
  }

  return Math.min(35, Math.max(4, count));
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,:;!?])/g, "$1")
    .replace(/([([{«])\s+/g, "$1")
    .replace(/\s+([)\]}»])/g, "$1")
    .trim();
}

function normalizeLanguage(value) {
  const lang = typeof value === "string" ? value : "ru";

  if (["ru", "en", "de", "fr", "es"].includes(lang)) {
    return lang;
  }

  return "ru";
}

const LANGUAGE_PROMPTS = {
  ru: {
    label: "Русский",
    instruction:
      "Весь текст презентации должен быть только на русском языке. Не смешивай языки.",
  },
  en: {
    label: "English",
    instruction:
      "All presentation text must be only in English. Do not mix languages.",
  },
  de: {
    label: "Deutsch",
    instruction:
      "Der gesamte Präsentationstext muss nur auf Deutsch sein. Keine Sprachmischung.",
  },
  fr: {
    label: "Français",
    instruction:
      "Tout le texte de la présentation doit être uniquement en français. Ne mélange pas les langues.",
  },
  es: {
    label: "Español",
    instruction:
      "Todo el texto de la presentación debe estar solo en español. No mezcles idiomas.",
  },
};

function cleanModelResponse(input) {
  const slides = Array.isArray(input?.slides) ? input.slides : [];

  return {
    slides: slides.map((slide) => ({
      title: cleanText(slide?.title),
      description: cleanText(slide?.description),
      content: Array.isArray(slide?.content)
        ? slide.content.map((item) => cleanText(item)).slice(0, 4)
        : [],
      imageQuery: cleanText(slide?.imageQuery),
    })),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-ai-proxy-secret"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  const proxySecret = process.env.AI_PROXY_SECRET;

  if (!openaiApiKey) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not configured on Vercel proxy",
    });
  }

  if (!proxySecret) {
    return res.status(500).json({
      error: "AI_PROXY_SECRET is not configured on Vercel proxy",
    });
  }

  const incomingSecret = req.headers["x-ai-proxy-secret"];

  if (incomingSecret !== proxySecret) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  try {
    const body = await readBody(req);

    const topic = cleanText(body?.topic);
    const language = normalizeLanguage(body?.language);
    const slideCount = normalizeSlideCount(body?.slideCount);

    if (!topic) {
      return res.status(400).json({
        error: "Topic is required",
      });
    }

    const selectedLanguage =
      LANGUAGE_PROMPTS[language] || LANGUAGE_PROMPTS.ru;

    const openaiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.62,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "presentation_slides",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  slides: {
                    type: "array",
                    minItems: slideCount,
                    maxItems: slideCount,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        title: {
                          type: "string",
                          minLength: 8,
                          maxLength: 90,
                        },
                        description: {
                          type: "string",
                          minLength: 90,
                          maxLength: 320,
                        },
                        content: {
                          type: "array",
                          minItems: 4,
                          maxItems: 4,
                          items: {
                            type: "string",
                            minLength: 45,
                            maxLength: 170,
                          },
                        },
                        imageQuery: {
                          type: "string",
                          minLength: 3,
                          maxLength: 90,
                        },
                      },
                      required: [
                        "title",
                        "description",
                        "content",
                        "imageQuery",
                      ],
                    },
                  },
                },
                required: ["slides"],
              },
            },
          },
          messages: [
            {
              role: "system",
              content: `
Ты создаёшь содержательные планы презентаций и короткие поисковые запросы для изображений.

${selectedLanguage.instruction}

НУЖНО:
- создать ровно ${slideCount} слайдов;
- каждый слайд должен раскрывать отдельную мысль;
- текст должен быть конкретным, полезным и без воды;
- не используй фразы вроде "слайд рассказывает", "слайд раскрывает", "на этом слайде";
- пиши так, будто текст сразу пойдёт в презентацию;
- не добавляй лишних полей;
- верни только JSON по схеме.

СТРУКТУРА СЛАЙДА:
1. title — короткий сильный заголовок.
2. description — 1–2 содержательные фразы.
3. content — ровно 4 пункта для слайда.
4. imageQuery — короткий запрос для картинки, только на английском.

ПРАВИЛА ДЛЯ ТЕКСТА:
- избегай канцелярита;
- не повторяй одну мысль разными словами;
- делай заголовки живыми, но не кликбейтными;
- пункты должны быть понятными без дополнительного объяснения;
- не вставляй технические слова JSON, imageQuery, schema, prompt;
- не ставь лишние пробелы перед знаками препинания;
- не пиши общими фразами без смысла;
- не используй шаблонные фразы вроде "данный аспект является важным";
- не описывай функцию слайда, а сразу давай готовый смысловой текст.

ПРАВИЛА ДЛЯ imageQuery:
- только английский язык;
- 2–7 слов;
- конкретная сцена, объект, интерьер, профессия, документ, процесс или место;
- не используй абстрактные слова: success, future, idea, concept, presentation, important, result;
- запросы на разных слайдах должны отличаться;
- если тема деловая, используй сцены вроде business meeting, analytics dashboard, customer research;
- если тема историческая, используй сцены вроде old manuscript, antique map, museum artifact, imperial palace;
- если тема архитектурная, используй сцены вроде architectural model, modern facade, construction drawings;
- если тема технологическая, используй сцены вроде software code screen, artificial intelligence interface, data center servers.
              `.trim(),
            },
            {
              role: "user",
              content:
                `Язык презентации: ${selectedLanguage.label}\n` +
                `Тема презентации: ${topic}\n` +
                `Количество слайдов: ${slideCount}\n` +
                `Сделай готовый текст для презентации. Не пиши служебные описания слайдов.`,
            },
          ],
        }),
      }
    );

    const responseText = await openaiResponse.text();

    if (!openaiResponse.ok) {
      return res.status(openaiResponse.status).json({
        error: "OpenAI request failed",
        details: responseText,
      });
    }

    const openaiData = JSON.parse(responseText);
    const rawContent = openaiData?.choices?.[0]?.message?.content;

    if (!rawContent) {
      return res.status(500).json({
        error: "Empty response from OpenAI",
        details: openaiData,
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(rawContent);
    } catch (error) {
      return res.status(500).json({
        error: "Failed to parse OpenAI JSON",
        raw: rawContent,
      });
    }

    return res.status(200).json(cleanModelResponse(parsed));
  } catch (error) {
    return res.status(500).json({
      error: "Proxy error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
