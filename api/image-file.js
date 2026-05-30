const ALLOWED_HOSTS = new Set([
  "images.pexels.com",
  "images.unsplash.com",
  "cdn.pixabay.com",
  "images.pixabay.com",
]);

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const src = typeof req.query?.src === "string" ? req.query.src : "";

    if (!src) {
      return res.status(400).json({
        error: "Missing src",
      });
    }

    const remoteUrl = new URL(src);

    if (!ALLOWED_HOSTS.has(remoteUrl.hostname)) {
      return res.status(403).json({
        error: "Image host not allowed",
        host: remoteUrl.hostname,
      });
    }

    const imageResponse = await fetchWithTimeout(
      remoteUrl.toString(),
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 Presentation Image Proxy",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      },
      30000
    );

    if (!imageResponse.ok) {
      return res.status(imageResponse.status).json({
        error: "Failed to fetch remote image",
        status: imageResponse.status,
      });
    }

    const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
    const arrayBuffer = await imageResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    return res.status(200).send(buffer);
  } catch (error) {
    return res.status(500).json({
      error: "Image proxy error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
