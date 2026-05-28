import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";

const app = express();
const PORT = 3001;
const DATA_FILE = path.resolve("data/events.json");

app.use(cors({ origin: "*" }));
app.use(express.json());

// GET /api/events?date=2026-06-15
app.get("/api/events", async (req, res) => {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const data = JSON.parse(raw);

    const { date, source } = req.query;

    let events = data.events || [];

    // Filter by date if provided
    if (date) {
      events = events.filter(ev => {
        if (!ev.date) return false;
        // Exact ISO date match
        if (ev.date === date) return true;
        // Raw date string contains the date (fallback)
        if (ev.rawDate && ev.rawDate.includes(date)) return true;
        return false;
      });
    }

    // Filter by source if provided
    if (source) {
      events = events.filter(ev => ev.source === source);
    }

    res.json({
      date: date || null,
      scrapedAt: data.scrapedAt,
      totalEvents: events.length,
      events,
    });

  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(503).json({
        error: "No event data available yet. Run the scraper first: npm run scrape",
      });
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status — shows when data was last scraped
app.get("/api/status", async (req, res) => {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const data = JSON.parse(raw);
    res.json({
      scrapedAt: data.scrapedAt,
      totalEvents: data.totalEvents,
      errors: data.errors,
    });
  } catch {
    res.json({ scrapedAt: null, totalEvents: 0, message: "No data yet — run npm run scrape" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`   GET http://localhost:${PORT}/api/events?date=2026-06-15`);
  console.log(`   GET http://localhost:${PORT}/api/status`);
});
