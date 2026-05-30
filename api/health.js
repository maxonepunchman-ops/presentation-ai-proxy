export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: "presentation-ai-proxy",
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    hasProxySecret: Boolean(process.env.AI_PROXY_SECRET),
  });
}
