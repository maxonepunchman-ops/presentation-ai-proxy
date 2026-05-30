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

function normalizeCount(value) {
  const count = Math.round(Number(value));

  if (!Number.isFinite(count)) {
    return 6;
  }

  return Math.min(12, Math.max(1, count));
}

function normalizeOrientation(value) {
  const orientation = cleanText(value).toLowerCase();

  if (["landscape", "portrait", "square"].includes(orientation)) {
    return orientation;
  }

  return "landscape";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
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

  const pexelsApiKey = process.env.PEXELS_API_KEY;
  const proxySecret = process.env.AI_PROXY_SECRET;
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (!pexelsApiKey) {
    return res.status(500).json({
      error: "PEXELS_API_KEY is not configured on Vercel proxy",
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

    const query = cleanText(body?.query);
    const count = normalizeCount(body?.count);
    const orientation = normalizeOrientation(body?.orientation);

    if (!query) {
      return res.status(400).json({
        error: "Query is required",
        requestId,
      });
    }

    const params = new URLSearchParams({
      query,
      per_page: String(count),
      orientation,
    });

    const pexelsResponse = await fetchWithTimeout(
      `https://api.pexels.com/v1/search?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: pexelsApiKey,
        },
      },
      30000
    );

    const responseText = await pexelsResponse.text();

    if (!pexelsResponse.ok) {
      return res.status(pexelsResponse.status).json({
        error: "Pexels request failed",
        details: responseText,
        requestId,
      });
    }

    const data = JSON.parse(responseText);
    const photos = Array.isArray(data?.photos) ? data.photos : [];

    const images = photos.map((photo) => ({
      id: photo?.id ?? null,
      width: photo?.width ?? null,
      height: photo?.height ?? null,
      alt: cleanText(photo?.alt),
      photographer: cleanText(photo?.photographer),
      url: photo?.url || "",
      src: {
        original: photo?.src?.original || "",
        large: photo?.src?.large || "",
        large2x: photo?.src?.large2x || "",
        medium: photo?.src?.medium || "",
        small: photo?.src?.small || "",
        portrait: photo?.src?.portrait || "",
        landscape: photo?.src?.landscape || "",
        tiny: photo?.src?.tiny || "",
      },
    }));

    return res.status(200).json({
      images,
      requestId,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Proxy error",
      message: error instanceof Error ? error.message : String(error),
      requestId,
    });
  }
}
