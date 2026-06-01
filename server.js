import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.set("trust proxy", 1);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:3000"];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
}));

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a few minutes." },
});
app.use("/api/", limiter);

const SYSTEM_PROMPT = `You are a knowledgeable travel advisor. The user will describe their ideal holiday. Search the web for real current deals on sites like Skyscanner, Booking.com, Expedia, TUI, Jet2, Kayak and Airbnb.

Return ONLY a valid JSON object with no markdown fences in this exact shape:
{
  "summary": "2-3 sentence overview",
  "destination_tips": ["tip1", "tip2", "tip3"],
  "flights": [
    { "airline": "...", "route": "...", "dates": "...", "price": "...", "url": "...", "notes": "..." }
  ],
  "hotels": [
    { "name": "...", "location": "...", "rating": "...", "price_per_night": "...", "url": "...", "notes": "..." }
  ],
  "packages": [
    { "operator": "...", "description": "...", "price": "...", "url": "...", "highlights": ["..."] }
  ],
  "budget_breakdown": { "flights": "...", "accommodation": "...", "total_estimate": "..." },
  "best_deal": { "title": "...", "description": "...", "url": "...", "price": "..." },
  "tags": ["Beach", "Family-friendly"]
}

Rules:
- Return ONLY the JSON, no extra text or markdown
- Use real booking URLs where possible
- Price in GBP for UK queries`;

app.post("/api/search", async (req, res) => {
  const { query } = req.body;

  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "query is required." });
  }

  if (query.trim().length < 5) {
    return res.status(400).json({ error: "Please enter a more detailed query." });
  }

  if (query.length > 500) {
    return res.status(400).json({ error: "Query too long (max 500 characters)." });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: query.trim() }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const clean = text.replace(/```json|```/g, "").trim();

    let result;
    try {
      result = JSON.parse(clean);
    } catch {
      return res.json({ raw: text });
    }

    return res.json(result);

  } catch (err) {
    console.error("Anthropic API error:", err);
    if (err.status === 401) return res.status(500).json({ error: "Invalid API key." });
    if (err.status === 429) return res.status(429).json({ error: "Rate limit reached." });
    return res.status(500).json({ error: "Something went wrong." });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✈  Holiday Search API running on http://localhost:${PORT}`);
});
