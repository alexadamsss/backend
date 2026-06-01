import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ── Anthropic client (key stays on the server) ──────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());

// Allow requests from your frontend origin (update in production)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:3000", "http://localhost:5500", "http://127.0.0.1:5500"];

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow requests with no origin (e.g. curl, server-to-server)
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
  })
);

// Rate limiting — 20 searches per IP per 10 minutes
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a few minutes and try again." },
});
app.use("/api/", limiter);

// ── System prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a knowledgeable travel advisor and deal-finder. The user will describe their ideal holiday.

Your job is to search the web for real, current deals and options — flights, accommodation, and package deals on sites like Skyscanner, Google Flights, Booking.com, Expedia, TUI, Jet2Holidays, Kayak, Hotels.com, and Airbnb.

Return ONLY a valid JSON object (no markdown fences, no preamble) in this exact shape:
{
  "summary": "2–3 sentence overview of what you found",
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
- Return ONLY the JSON — no extra text, no markdown.
- Use real URLs to actual search/booking pages wherever possible.
- If live prices aren't available, give realistic estimates and note they're approximate.
- Price in the user's implied currency (GBP for UK queries, EUR/USD otherwise).
- Include at least 2 flight options, 2–3 hotels, and 1–2 packages where relevant.`;

// ── Search endpoint ──────────────────────────────────────────────────────────
app.post("/api/search", async (req, res) => {
  const { query } = req.body;

  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "query is required and must be a string." });
  }

  if (query.trim().length < 5) {
    return res.status(400).json({ error: "Please enter a more detailed search query." });
  }

  if (query.length > 500) {
    return res.status(400).json({ error: "Query is too long (max 500 characters)." });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: query.trim() }],
    });

    // Extract the text content blocks
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // Aggressively strip markdown fences and extract JSON object
    let clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const firstBrace = clean.indexOf("{");
    const lastBrace = clean.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      clean = clean.substring(firstBrace, lastBrace + 1);
    }

    let result;
    try {
      result = JSON.parse(clean);
    } catch {
      // Model didn't return JSON — return raw text gracefully
      return res.json({ raw: text });
    }

    return res.json(result);
  } catch (err) {
    console.error("Anthropic API error:", err);

    if (err.status === 401) {
      return res.status(500).json({ error: "Invalid API key. Check your .env file." });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: "Anthropic rate limit reached. Please try again shortly." });
    }

    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✈  Holiday Search API running on http://localhost:${PORT}`);
});
