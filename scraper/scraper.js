import fetch from "node-fetch";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-CA,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

async function fetchHTML(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Fetch a Wix visitor token for API access (needed for Wix-hosted sites)
async function getWixVisitorToken(siteUrl) {
  try {
    const res = await fetch(`${siteUrl}/_api/v1/access-tokens`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.apps?.["14bcded7-0066-7c35-14d7-466cb3f09103"]?.instance || null;
  } catch { return null; }
}

// ─── SCRAPERS ────────────────────────────────────────────────────────────────

async function scrapeNAC() {
  // URL: https://nac-cna.ca/en/tickets
  // Fetches listing page, filters to events within 60 days,
  // then fetches event pages in parallel batches of 5.
  console.log("  Scraping National Arts Centre...");
  const events = [];
  const seen = new Set();

  let html;
  try {
    html = await fetchHTML("https://nac-cna.ca/en/tickets");
  } catch(e) {
    console.log("    NAC unreachable:", e.message);
    return [];
  }

  const $ = cheerio.load(html);
  const now = new Date();
  const cutoff = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 days out
  const items = [];

  $("li.eventSearch--item").each((_, el) => {
    const link    = $(el).find("a.eventSearchBox--link").first();
    const href    = link.attr("href");
    const eventId = link.attr("data-eventid") || href || "";
    const title   = $(el).find("span.event-title").first().text().trim();
    const subtitle= $(el).find("span.event-subtitle").first().text().trim();
    const venue   = $(el).find("span.venue").first().text().trim().replace(/\s{2,}/g, " ").trim();

    if (!title || !href || seen.has(eventId)) return;
    seen.add(eventId);
    items.push({ href, title, subtitle, venue, eventId });
  });

  console.log(`    Found ${items.length} NAC listings, fetching dates in batches...`);

  // Fetch event pages in parallel batches of 20
  const BATCH = 20;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (item) => {
      const fullUrl = resolveURL("https://nac-cna.ca", item.href);
      let date = null;
      let time = null;
      let extraDates = null;

      try {
        const eventHtml = await fetchHTML(fullUrl);
        const $e = cheerio.load(eventHtml);

        // span.hide.start / span.hide.end contain "2026-05-27 20:00" in raw HTML
        const startRaw = $e("span.hide.start").first().text().trim();
        const endRaw   = $e("span.hide.end").first().text().trim();
        if (startRaw) {
          // Parse date portion directly to avoid UTC timezone shift
          const startDate = startRaw.split(" ")[0]; // "2026-05-27"
          const endDate   = endRaw ? endRaw.split(" ")[0] : startDate; // "2026-05-28"
          const timeStr   = startRaw.split(" ")[1] || ""; // "20:00"

          // Store time in 24h format "HH:MM" consistent with other scrapers
          if (timeStr) {
            time = timeStr; // already "20:00" format from NAC
          }

          // Generate one entry per day between start and end
          const allDates = [];
          const cur = new Date(startDate + "T12:00:00"); // noon avoids DST edge cases
          const end = new Date(endDate + "T12:00:00");
          while (cur <= end) {
            allDates.push(cur.toISOString().split("T")[0]);
            cur.setDate(cur.getDate() + 1);
          }
          date = allDates[0];
          extraDates = allDates.length > 1 ? allDates : null;
        }

      } catch { /* use null date */ }

      return { ...item, date, time, extraDates, fullUrl };
    }));

    const todayStr  = now.toISOString().split("T")[0];
    const cutoffStr = cutoff.toISOString().split("T")[0];
    for (const item of results) {
      // Skip events outside our 60-day window (compare strings directly, no timezone issues)
      if (item.date && (item.date < todayStr || item.date > cutoffStr)) continue;
      // If event spans multiple days, create one entry per day
      const dates = item.extraDates || [item.date];
      for (const d of dates) {
        events.push({
          source: "nac",
          title: item.title,
          subtitle: item.subtitle || null,
          date: d,
          rawDate: d,
          time: item.time,
          venue: item.venue || null,
          description: item.subtitle || null,
          url: item.fullUrl,
        });
      }
    }
  }

  console.log(`    Done — ${events.length} NAC events in the next 60 days`);
  return events;
}

async function scrapeNationalGallery() {
  // URL: https://www.gallery.ca/whats-on/event-calendar/upcoming
  // Container: div.node.node-event.node-teaser
  // Title:     div.field-name-title h2 a
  // Date:      span[content] with ISO datetime e.g. "2026-05-28T17:00:00-04:00"
  // Time:      span.date-display-start / span.date-display-end
  // Desc:      div.field-name-body
  // Location:  div.field-name-field-event-location
  // Type:      div.field-name-field-event-type
  // URL:       about attribute on container div
  console.log("  Scraping National Gallery...");
  const events = [];
  const seen = new Set();

  let html;
  try {
    // Gallery requires full browser-like headers to avoid 403
    const res = await fetch("https://www.gallery.ca/whats-on/event-calendar", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-CA,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch(e) {
    console.log("    Gallery unreachable:", e.message);
    return [];
  }

  const $ = cheerio.load(html);

  $("div.node.node-event.node-teaser").each((_, el) => {
    const title = $(el).find(".field-name-title h2 a").first().text().trim();
    const href  = $(el).find(".field-name-title h2 a").first().attr("href");
    const about = $(el).attr("about") || "";

    // Use the content attribute for ISO date with timezone
    const startContent = $(el).find("span[content]").first().attr("content") || "";
    const endContent   = $(el).find("span[content]").last().attr("content") || "";

    const startDate = startContent ? startContent.split("T")[0] : null;
    const endDate   = endContent   ? endContent.split("T")[0]   : startDate;

    // Time display
    const timeStart = $(el).find("span.date-display-start").first().text().trim();
    const timeEnd   = $(el).find("span.date-display-end").first().text().trim();
    const time      = timeStart ? (timeEnd ? `${timeStart} – ${timeEnd}` : timeStart) : null;

    const desc     = $(el).find(".field-name-body").first().text().trim().slice(0, 200);
    const location = $(el).find(".field-name-field-event-location").first().text().trim();
    const type     = $(el).find(".field-name-field-event-type").first().text().trim();
    const url      = href
      ? resolveURL("https://www.gallery.ca", href)
      : (about ? resolveURL("https://www.gallery.ca", about) : "https://www.gallery.ca/whats-on/event-calendar");

    if (!title || seen.has(url)) return;
    seen.add(url);

    // Generate one entry per day for multi-day events
    const allDates = [];
    if (startDate && endDate) {
      const cur = new Date(startDate + "T12:00:00");
      const end = new Date(endDate   + "T12:00:00");
      // Cap at 365 days to avoid runaway loops for year-long events
      let count = 0;
      while (cur <= end && count < 365) {
        allDates.push(cur.toISOString().split("T")[0]);
        cur.setDate(cur.getDate() + 1);
        count++;
      }
    } else if (startDate) {
      allDates.push(startDate);
    }

    for (const d of allDates) {
      events.push({
        source: "gallery",
        title,
        date: d,
        rawDate: d,
        time,
        venue: location || null,
        description: desc || (type ? `Type: ${type}` : null),
        url,
      });
    }
  });

  console.log(`    Found ${events.length} Gallery events`);
  return events;
}

async function scrapeBluesFest() {
  console.log("  Scraping Blues Fest Ottawa...");
  const candidates = [
    "https://ottawabluesfest.ca/schedule",
    "https://ottawabluesfest.ca/lineup",
    "https://ottawabluesfest.ca",
  ];

  let html = "";
  for (const url of candidates) {
    try { html = await fetchHTML(url); break; } catch { continue; }
  }

  if (!html) {
    console.log("    Blues Fest unreachable — likely off-season");
    return [];
  }

  const $ = cheerio.load(html);
  const events = [];

  $("article, .show, .performance, .event, [class*='show'], [class*='artist'], [class*='event']").each((_, el) => {
    const title = $(el).find("h2,h3,h4,.title,.name,[class*='title'],[class*='name']").first().text().trim();
    const date  = $(el).find("time,.date,[class*='date']").first().text().trim();
    const link  = $(el).find("a").first().attr("href");
    const parsedDate = normalizeDate(date);
    if (title && title.length > 2 && parsedDate) {
      events.push({
        source: "blues",
        title,
        date: parsedDate,
        rawDate: date,
        time: null,
        description: null,
        url: link ? resolveURL("https://ottawabluesfest.ca", link) : "https://ottawabluesfest.ca",
      });
    }
  });

  console.log(`    Found ${events.length} Blues Fest events`);
  return events;
}

async function scrapeJazzFest() {
  console.log("  Scraping Ottawa Jazz Festival...");
  const candidates = [
    "https://ottawajazzfestival.com/schedule",
    "https://ottawajazzfestival.com/lineup",
    "https://ottawajazzfestival.com/events",
    "https://ottawajazzfestival.com",
  ];

  let html = "";
  let baseUrl = "https://ottawajazzfestival.com";
  for (const url of candidates) {
    try { html = await fetchHTML(url); baseUrl = url; break; } catch { continue; }
  }

  if (!html) {
    console.log("    Jazz Fest unreachable — likely off-season");
    return [];
  }

  const $ = cheerio.load(html);
  const events = [];

  $("article, .show, .event, .performance, [class*='event'], [class*='show']").each((_, el) => {
    const title = $(el).find("h2,h3,h4,.title,.name,[class*='title']").first().text().trim();
    const date  = $(el).find("time,.date,[class*='date']").first().text().trim();
    const link  = $(el).find("a").first().attr("href");
    if (title && title.length > 2) {
      events.push({
        source: "jazz",
        title,
        date: normalizeDate(date),
        rawDate: date,
        time: null,
        description: null,
        url: link ? resolveURL(baseUrl, link) : baseUrl,
      });
    }
  });

  console.log(`    Found ${events.length} Jazz Fest events`);
  return events;
}

async function scrapeOttawaGigs() {
  // Webflow CMS site — listing page has title/date/genre, individual pages have time+venue
  console.log("  Scraping Ottawa Gigs...");
  const html = await fetchHTML("https://ottawagigs.ca/");
  const $ = cheerio.load(html);
  const events = [];
  const seen = new Set();

  const NEIGHBOURHOODS = new Set([
    "centretown","byward market","the glebe","old ottawa south","gatineau",
    "alta vista","westboro","hintonburg","orleans","wakefield","vanier",
    "gloucester","nepean","kanata","barrhaven",
  ]);

  $("div[role='listitem'].job-listing, div.job-listing.w-dyn-item").each((_, el) => {
    const title   = $(el).find("[fs-cmsfilter-field='Title'], .job-listing-title").first().text().trim();
    const rawDate = $(el).find("[fs-cmsfilter-field='Date']").first().text().trim();
    const genre   = $(el).find("[fs-cmsfilter-field='genre']").first().text().trim();
    const href    = $(el).find("a[href*='/gig/']").first().attr("href");
    const url     = href ? resolveURL("https://ottawagigs.ca", href) : "https://ottawagigs.ca";

    if (!title || NEIGHBOURHOODS.has(title.toLowerCase())) return;
    const key = `${title}|${rawDate}`;
    if (seen.has(key)) return;
    seen.add(key);

    events.push({
      source: "gigs",
      title,
      date: normalizeDate(rawDate),
      rawDate: rawDate || null,
      time: null,
      venue: null,
      description: genre ? `Genre: ${genre}` : null,
      url,
    });
  });

  // Fetch individual pages in batches to get time + venue
  // Individual page has: <div class="job-page-info-text date">Jun 1, 2026 8:00 PM</div>
  // and <a href="/venue/..." class="job-page-info-text link">The Laff</a>
  for (let i = 0; i < events.length; i += 5) {
    const batch = events.slice(i, i + 5);
    await Promise.all(batch.map(async (ev) => {
      if (!ev.url || ev.url === "https://ottawagigs.ca") return;
      try {
        const pageHtml = await fetchHTML(ev.url);
        const $p = cheerio.load(pageHtml);

        // Date/time: "Jun 1, 2026 8:00 PM"
        const dateTimeText = $p(".job-page-info-text.date").first().text().trim();
        const tm = dateTimeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (tm) {
          let h = parseInt(tm[1]);
          const m = tm[2];
          const ampm = tm[3].toUpperCase();
          if (ampm === "PM" && h !== 12) h += 12;
          if (ampm === "AM" && h === 12) h = 0;
          ev.time = `${String(h).padStart(2,"0")}:${m}`;
        }

        // Venue: first link inside a job-page-info-block that follows the venue icon
        const venueText = $p(".job-page-info-text.link").first().text().trim();
        if (venueText && !NEIGHBOURHOODS.has(venueText.toLowerCase())) {
          ev.venue = venueText;
        }
      } catch { /* skip */ }
    }));
  }

  console.log(`    Found ${events.length} Ottawa Gigs events`);
  return events;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function resolveURL(base, href) {
  if (!href) return base;
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  if (href.startsWith("/")) return new URL(base).origin + href;
  return base.replace(/\/$/, "") + "/" + href;
}

// Like normalizeDate but appends current year if only month+day found
function normalizeDateWithYear(raw) {
  if (!raw) return null;
  raw = raw.replace(/\s+/g," ").trim();
  if (!raw) return null;
  // Already has a 4-digit year
  if (/\d{4}/.test(raw)) return normalizeDate(raw);
  // "May 27" → "May 27 2026"
  const year = new Date().getFullYear();
  const withYear = raw + " " + year;
  const d = new Date(withYear);
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return null;
}

function normalizeDate(raw) {
  if (!raw) return null;
  raw = raw.trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return null;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function runScraper() {
  console.log("🎭 Ottawa Events Scraper");
  console.log("========================");
  console.log(`Started: ${new Date().toLocaleString("en-CA")}\n`);

  const scrapers = [scrapeNAC, scrapeNationalGallery, scrapeBluesFest, scrapeJazzFest, scrapeOttawaGigs, scrapeRedBird, scrapeIrenesPub, scrapeGladstone, scrapeGCTC, scrapeBlackSheep, scrapeOttawaPops, scrapeOrkidstra, scrapeThirteenStrings, scrapeGoogleSheet, scrapeBronson, scrapeChamberfest, scrapeCityFolk, scrapeMotelChelsea];
  const allEvents = [];
  const errors = [];

  for (const scraper of scrapers) {
    const t0 = Date.now();
    try {
      const events = await scraper();
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`    ⏱  ${secs}s`);
      allEvents.push(...events);
    } catch (err) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`  ❌ ${scraper.name} failed after ${secs}s: ${err.message}`);
      errors.push({ scraper: scraper.name, error: err.message });
    }
  }

  // Deduplicate: if same title+date exists from a dedicated scraper, drop the gigs version
  const AGGREGATORS = new Set(["gigs"]);
  const dedicatedKeys = new Set(
    allEvents.filter(e => !AGGREGATORS.has(e.source)).map(e => `${e.date}|${e.title.toLowerCase().trim()}`)
  );
  const deduped = allEvents.filter(e => {
    if (!AGGREGATORS.has(e.source)) return true;
    return !dedicatedKeys.has(`${e.date}|${e.title.toLowerCase().trim()}`);
  });
  const dropped = allEvents.length - deduped.length;
  if (dropped > 0) console.log(`  Removed ${dropped} duplicate(s) from aggregator sources`);

  const output = {
    scrapedAt: new Date().toISOString(),
    totalEvents: deduped.length,
    errors,
    events: deduped,
  };

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(path.resolve("data/events.json"), JSON.stringify(output, null, 2));

  console.log(`\n✅ Done! ${deduped.length} events saved to data/events.json`);
  if (errors.length > 0) console.log(`⚠️  ${errors.length} source(s) had errors — see above`);
}

runScraper().catch(console.error);

// ─── NEW SOURCES ─────────────────────────────────────────────────────────────

async function scrapeRedBird() {
  // Red Bird uses Showpass (venue ID 14170) - has a clean public API
  console.log("  Scraping Red Bird Live...");
  const events = [];

  try {
    const res = await fetch(
      "https://www.showpass.com/api/public/events/?venue=14170&page_size=50&is_hidden=false",
      { headers: { "Accept": "application/json", "User-Agent": HEADERS["User-Agent"] } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = data.results || data || [];

    for (const item of items) {
      const title   = item.name || item.title;
      const startRaw = item.starts_on || item.start_date;
      const endRaw   = item.ends_on   || item.end_date;
      if (!title || !startRaw) continue;

      const startDate = startRaw.split("T")[0];
      const endDate   = endRaw ? endRaw.split("T")[0] : startDate;
      const timeStr   = startRaw.includes("T") ? startRaw.split("T")[1].slice(0,5) : null;
      let time = null;
      if (timeStr) {
        const [h, m] = timeStr.split(":").map(Number);
        const period = h >= 12 ? "p.m." : "a.m.";
        time = `${h % 12 || 12}:${String(m).padStart(2,"0")} ${period}`;
      }

      const url = item.slug
        ? `https://www.showpass.com/${item.slug}/`
        : "https://www.redbirdlive.ca/shows";

      // Generate one entry per day
      const cur = new Date(startDate + "T12:00:00");
      const end = new Date(endDate   + "T12:00:00");
      while (cur <= end) {
        events.push({
          source: "redbird",
          title,
          date: cur.toISOString().split("T")[0],
          rawDate: cur.toISOString().split("T")[0],
          time,
          venue: "Red Bird Live",
          description: (item.description || "").replace(/<[^>]+>/g,"").slice(0,200) || null,
          url,
        });
        cur.setDate(cur.getDate() + 1);
      }
    }
  } catch(e) {
    console.log("    Red Bird unreachable:", e.message);
  }

  console.log(`    Found ${events.length} Red Bird events`);
  return events;
}

async function scrapeIrenesPub() {
  // Squarespace events site - standard HTML listing at /events
  console.log("  Scraping Irene's Pub...");
  const events = [];
  try {
    const html = await fetchHTML("https://irenespub.ca/events");
    const $ = cheerio.load(html);

    // Squarespace event list items
    $("article.eventlist-event, li.eventlist-event, [class*='eventlist-event']").each((_, el) => {
      const title   = $(el).find("[class*='eventlist-title'], h1, h2, h3").first().text().trim();
      const dateEl  = $(el).find("time[datetime], [class*='event-date'], [class*='eventlist-date']").first();
      const dtAttr = dateEl.attr("datetime") || "";
      const dtText = dateEl.text().replace(/\s+/g," ").trim();
      const rawDate = dtAttr || dtText;
      const href    = $(el).find("a").first().attr("href");
      const descEl  = $(el).find("[class*='eventlist-description'], [class*='summary']").first();
      descEl.find("style").remove();
      const desc    = descEl.text().replace(/#block-[^{]+\{[^}]*\}/g, "").replace(/\s+/g," ").trim();

      if (!title) return;
      events.push({
        source: "irenes",
        title,
        date: normalizeDateWithYear(rawDate),
        rawDate: rawDate || null,
        time: null,
        venue: "Irene's Pub",
        description: desc.slice(0,200) || null,
        url: href ? resolveURL("https://irenespub.ca", href) : "https://irenespub.ca/events",
      });
    });

    // Fetch individual event pages in batches to get times
    // Time is in <time class="event-time-localized-start">8:30 p.m.</time>
    for (let i = 0; i < events.length; i += 5) {
      const batch = events.slice(i, i + 5);
      await Promise.all(batch.map(async (ev) => {
        if (!ev.url || ev.url === "https://irenespub.ca/events") return;
        try {
          const pageHtml = await fetchHTML(ev.url);
          const $p = cheerio.load(pageHtml);
          // Try specific time element first, then fall back to body text scan
          const timeText = $p("time.event-time-localized-start").first().text().trim()
            || $p("time.event-time-12hr").first().text().trim();
          const tm = timeText.match(/(\d{1,2}):(\d{2})\s*(a\.m\.|p\.m\.|am|pm)/i)
            || $p("body").text().match(/(\d{1,2}):(\d{2})\s*(a\.m\.|p\.m\.|am|pm)/i);
          if (tm) {
            let h = parseInt(tm[1]);
            const m = tm[2];
            const ampm = tm[3].toLowerCase().replace(/\./g,"");
            if (ampm === "pm" && h !== 12) h += 12;
            if (ampm === "am" && h === 12) h = 0;
            ev.time = `${String(h).padStart(2,"0")}:${m}`;
          }
        } catch { /* skip if individual page fails */ }
      }));
    }
  } catch(e) {
    console.log("    Irene's Pub unreachable:", e.message);
  }
  console.log(`    Found ${events.length} Irene's Pub events`);
  return events;
}

async function scrapeGladstone() {
  // Structure confirmed from page source (Bricks/WordPress theme):
  //   Container:  div.card-shows
  //   Title:      h3.card-shows__title
  //   Date:       div containing text like "Jun 3, 2026 – Jun 13, 2026"
  //   Link:       a.card-shows__wrap-title (or any <a> inside card-shows linking to /shows/)
  //   Presenter:  div.card-shows__pre-header
  console.log("  Scraping The Gladstone Theatre...");
  const events = [];
  const seen = new Set();

  let html = "";
  try {
    html = await fetchHTML("https://thegladstone.ca/upcoming-shows/");
  } catch(e) {
    console.log("    Gladstone unreachable:", e.message);
    return [];
  }

  const $ = cheerio.load(html);

  $("div.card-shows").each((_, el) => {
    const title    = $(el).find("h3.card-shows__title").first().text().trim();
    const subtitle = $(el).find(".card-shows__subtitle").first().text().trim();
    const href     = $(el).find("a[href*='/shows/']").first().attr("href");
    const presenter= $(el).find(".card-shows__pre-header").first().text().trim();

    // Date is in a text div — match "Jun 3, 2026" or "Jun 3, 2026 – Jun 13, 2026"
    const dateText = $(el).text().replace(/\s+/g, " ").trim();
    const dateMatch = dateText.match(/([A-Z][a-z]{2} \d{1,2}, \d{4})/);
    const endMatch  = dateText.match(/–\s*([A-Z][a-z]{2} \d{1,2}, \d{4})/);
    const rawDate  = dateMatch ? dateMatch[1] : "";
    const rawEnd   = endMatch  ? endMatch[1]  : rawDate;

    if (!title || !href || seen.has(href)) return;
    seen.add(href);

    // Generate one entry per day for multi-day runs
    const startDate = normalizeDate(rawDate);
    const endDate   = normalizeDate(rawEnd) || startDate;

    if (startDate && endDate) {
      const cur = new Date(startDate + "T12:00:00");
      const end = new Date(endDate   + "T12:00:00");
      let count = 0;
      while (cur <= end && count < 365) {
        events.push({
          source: "gladstone",
          title,
          date: cur.toISOString().split("T")[0],
          rawDate: rawDate || null,
          time: null,
          venue: "The Gladstone Theatre",
          description: subtitle || (presenter ? presenter.replace(" Presents", "") : null),
          url: resolveURL("https://thegladstone.ca", href),
        });
        cur.setDate(cur.getDate() + 1);
        count++;
      }
    } else {
      events.push({
        source: "gladstone", title, date: null, rawDate: rawDate || null,
        time: null, venue: "The Gladstone Theatre",
        description: subtitle || null,
        url: resolveURL("https://thegladstone.ca", href),
      });
    }
  });

  console.log(`    Found ${events.length} Gladstone events`);

  // Fetch each unique show page to get time from "Showtimes" section
  // Time is written as prose e.g. "7:30 nightly" in brxe-prgomj div
  const uniqueUrls = [...new Set(events.map(e => e.url))];
  const timeByUrl = {};
  for (let i = 0; i < uniqueUrls.length; i += 5) {
    const batch = uniqueUrls.slice(i, i + 5);
    await Promise.all(batch.map(async (url) => {
      try {
        const pageHtml = await fetchHTML(url);
        const $p = cheerio.load(pageHtml);
        // Showtimes section text e.g. "7:30 nightly" or "2:00 pm and 7:30 pm"
        const showtimeText = $p("[id*='brxe'] h3").filter((_, el) => 
          $p(el).text().toLowerCase().includes("showtime")
        ).closest("[id*='brxe']").next().text().replace(/\s+/g," ").trim();
        
        const tm = showtimeText.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i)
          || $p("body").text().match(/(\d{1,2}):(\d{2})\s*(nightly|pm|am)/i);
        if (tm) {
          let h = parseInt(tm[1]);
          const m = tm[2];
          const ampm = (tm[3] || "").toLowerCase();
          if ((ampm === "pm" || (!ampm && h < 12)) && h !== 12) h += 12;
          timeByUrl[url] = `${String(h).padStart(2,"00")}:${m}`;
        }
      } catch { /* skip */ }
    }));
  }

  // Apply times to all events
  for (const ev of events) {
    if (timeByUrl[ev.url]) ev.time = timeByUrl[ev.url];
  }

  return events;
}

async function scrapeGCTC() {
  console.log("  Scraping Great Canadian Theatre Company...");
  const events = [];
  let html = "", base = "https://www.gctc.ca";
  for (const url of ["https://www.gctc.ca/buy-tickets","https://www.gctc.ca/season","https://www.gctc.ca"]) {
    try { html = await fetchHTML(url); base = url; break; } catch { continue; }
  }
  if (!html) { console.log("    GCTC unreachable"); return []; }

  const $ = cheerio.load(html);
  const seen = new Set();
  const showLinks = [];

  $("a[href*='/shows/'], a[href*='/events/']").each((_, el) => {
    const href  = $(el).attr("href");
    if (!href || seen.has(href)) return;
    const title = $(el).text().trim();
    if (!title || title.length < 4 || title.toLowerCase().includes("shows & events")) return;
    seen.add(href);
    showLinks.push({ href: resolveURL(base, href), title });
  });

  // Fetch each show page for dates (batches of 3)
  for (let i = 0; i < showLinks.length; i += 3) {
    const batch = showLinks.slice(i, i + 3);
    const results = await Promise.all(batch.map(async ({ href, title }) => {
      let date = null, time = null, desc = null;
      try {
        const pageHtml = await fetchHTML(href);
        const $p = cheerio.load(pageHtml);
        const bodyText = $p("body").text();

        // Extract time — try 24hr element, 12hr element, then body text regex
        const time24 = $p("time.event-time-24hr").first().text().trim();
        const time12 = $p("time.event-time-12hr").first().text().trim();

        if (time24 && /^\d{2}:\d{2}$/.test(time24)) {
          time = time24;
        } else if (time12) {
          const tm = time12.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
          if (tm) {
            let h = parseInt(tm[1]);
            if (tm[3].toUpperCase() === "PM" && h !== 12) h += 12;
            if (tm[3].toUpperCase() === "AM" && h === 12) h = 0;
            time = `${String(h).padStart(2,"0")}:${tm[2]}`;
          }
        } else {
          const tm = bodyText.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM|a\.m\.|p\.m\.)/i);
          if (tm) {
            let h = parseInt(tm[1]);
            const ampm = tm[3].replace(/\./g,"").toUpperCase();
            if (ampm === "PM" && h !== 12) h += 12;
            if (ampm === "AM" && h === 12) h = 0;
            time = `${String(h).padStart(2,"0")}:${tm[2]}`;
          }
        }

        // Match "June 10 – July 5, 2026" or "June 10, 2026"
        const m = bodyText.match(/([A-Z][a-z]+ \d{1,2})\s*[–-]\s*[A-Z][a-z]+ \d{1,2},\s*(\d{4})/);
        if (m) date = normalizeDate(`${m[1]}, ${m[2]}`);
        if (!date) {
          const m2 = bodyText.match(/([A-Z][a-z]+ \d{1,2},?\s*\d{4})/);
          if (m2) date = normalizeDate(m2[1]);
        }
        desc = $p("meta[name='description']").attr("content")?.slice(0,200) || null;
      } catch {}
      return { href, title, date, time, desc };
    }));
    for (const { href, title, date, time, desc } of results) {
      events.push({ source: "gctc", title, date, rawDate: date, time, venue: "GCTC", description: desc, url: href });
    }
  }

  console.log(`    Found ${events.length} GCTC events`);
  return events;
}

async function scrapeBlackSheep() {
  // Black Sheep is a Wix site — content is JS-rendered so HTML scraping won't work.
  // Use the Wix public events API instead.
  console.log("  Scraping Black Sheep Inn...");
  const events = [];
  try {
    // Wix Events v1 API — publicly accessible for sites using the Wix Events app
    const apiUrls = [
      "https://www.theblacksheep.ca/_api/events/v1/events?status=UPCOMING&limit=50",
      "https://www.theblacksheep.ca/_api/wix-one-events-server/v1/events?status=UPCOMING&limit=50",
    ];

    let items = [];
    for (const url of apiUrls) {
      try {
        // First try without auth
        let res = await fetch(url, { headers: { ...HEADERS, "Accept": "application/json" } });
        // If unauthorized, try getting a visitor token
        if (!res.ok) {
          const token = await getWixVisitorToken("https://www.theblacksheep.ca");
          if (token) {
            res = await fetch(url, { headers: { ...HEADERS, "Accept": "application/json", "Authorization": token } });
          }
        }
        if (!res.ok) continue;
        const data = await res.json();
        items = data.events || data.items || [];
        if (items.length > 0) break;
      } catch { continue; }
    }

    for (const item of items) {
      const title = item.title || item.name || "";
      const slug  = item.slug || item.id || "";
      const start = item.scheduling?.config?.startDate || item.dateAndTimeSettings?.startDate || "";
      const desc  = (item.description || "").slice(0, 200);
      if (!title) continue;
      events.push({
        source: "blacksheep",
        title,
        date: start ? start.split("T")[0] : null,
        rawDate: start || null,
        time: start ? start.split("T")[1]?.slice(0, 5) : null,
        venue: "Black Sheep Inn",
        description: desc || null,
        url: slug ? `https://www.theblacksheep.ca/events/${slug}` : "https://www.theblacksheep.ca/shows",
      });
    }

    if (events.length === 0) {
      console.log("    Black Sheep: API returned 0 events (Wix may require auth)");
    }
  } catch(e) {
    console.log("    Black Sheep Inn unreachable:", e.message);
  }
  console.log(`    Found ${events.length} Black Sheep Inn events`);
  return events;
}

// ── Squarespace helper: fetch events via JSON API ─────────────────────────────
async function scrapeSquarespace(baseUrl, source, venueName) {
  const events = [];
  // Squarespace exposes events as JSON at /<collection>?format=json
  const apiUrl = `${baseUrl}?format=json`;
  try {
    const res = await fetch(apiUrl, { headers: { ...HEADERS, "Accept": "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = data.items || data.upcoming || [];
    for (const item of items) {
      const title = item.title || "";
      const start = item.startDate; // Unix ms timestamp
      const url   = item.fullUrl ? `${new URL(baseUrl).origin}${item.fullUrl}` : baseUrl;
      const desc  = (item.body || item.excerpt || "").replace(/<[^>]+>/g,"").trim().slice(0,200);
      if (!title || !start) continue;
      const d = new Date(start);
      events.push({
        source,
        title,
        date: d.toISOString().split("T")[0],
        rawDate: d.toISOString(),
        time: d.toTimeString().slice(0,5),
        venue: venueName,
        description: desc || null,
        url,
      });
    }
  } catch(e) {
    console.log(`    ${venueName} unreachable: ${e.message}`);
  }
  return events;
}

async function scrapeOttawaPops() {
  console.log("  Scraping Ottawa Pops Orchestra...");
  const events = await scrapeSquarespace(
    "https://www.ottawapopsorchestra.ca/events",
    "ottawapops",
    "Ottawa Pops Orchestra"
  );
  console.log(`    Found ${events.length} Ottawa Pops events`);
  return events;
}

async function scrapeOrkidstra() {
  // WordPress with baytek-performances plugin
  // Listing page has image links to individual event pages; dates are in title text
  console.log("  Scraping Orkidstra...");
  const events = [];
  const BASE = "https://orkidstra.ca";
  const LIST = `${BASE}/events/upcoming-events/`;
  const SKIP_HREFS = new Set([LIST, `${BASE}/events/`, `${BASE}/`]);
  const SKIP_TITLES = new Set(["about","events","programs","support","news","home","donate","book an event","upcoming events","event galleries"]);

  try {
    const html = await fetchHTML(LIST);
    const $ = cheerio.load(html);
    const seen = new Set();
    const eventLinks = [];

    // Collect all links that go deeper into /events/upcoming-events/
    $("a").each((_, el) => {
      const href = $(el).attr("href") || "";
      const absHref = href.startsWith("http") ? href : resolveURL(BASE, href);
      if (!absHref.includes("/events/upcoming-events/")) return;
      if (SKIP_HREFS.has(absHref) || seen.has(absHref)) return;
      seen.add(absHref);

      // Get title from link text or nearby heading
      const linkText = $(el).text().trim();
      const container = $(el).closest("div, li, article");
      const heading = container.find("h2,h3,h4").first().text().trim();
      const candidate = (heading || linkText).replace(/\s+/g," ").trim();

      // Only collect if title contains a month name (real events have "June 3: ..." in title)
      if (!/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(candidate)) return;

      eventLinks.push({ href: absHref, candidate });
    });

    // Fetch each event page to get the date (title comes from link text on listing page)
    for (let i = 0; i < eventLinks.length; i += 3) {
      const batch = eventLinks.slice(i, i + 3);
      const results = await Promise.all(batch.map(async ({ href, candidate }) => {
        try {
          const pageHtml = await fetchHTML(href);
          const $p = cheerio.load(pageHtml);
          const bodyText = $p("body").text().replace(/\s+/g," ");
          // Look for date patterns like "June 3, 2026" or "June 3"
          const dm = bodyText.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?)/i);
          const rawDate = dm ? dm[1] : "";
          // Use candidate title from listing page, strip leading date prefix
          const title = candidate.replace(/^[A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?\s*[-:]\s*/i, "").trim() || candidate;
          // Extract time from meta description or body text: "at 6:30 PM"
          const metaDesc = $p('meta[property="og:description"]').attr("content") || "";
          const timeSource = metaDesc || bodyText;
          let time = null;
          const tm = timeSource.match(/at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i)
            || timeSource.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
          if (tm) {
            let h = parseInt(tm[1]);
            const m = tm[2];
            const ampm = tm[3].toUpperCase();
            if (ampm === "PM" && h !== 12) h += 12;
            if (ampm === "AM" && h === 12) h = 0;
            time = `${String(h).padStart(2,"00")}:${m}`;
          }
          if (!title || title.length < 4 || SKIP_TITLES.has(title.toLowerCase())) return null;
          if (!rawDate) return null;
          const date = normalizeDateWithYear(rawDate);
          // Skip past events
          if (date && date < new Date().toISOString().split("T")[0]) return null;
          return { href, title, rawDate, date, time };
        } catch { return null; }
      }));
      for (const r of results) {
        if (!r) continue;
        events.push({
          source: "orkidstra", title: r.title,
          date: r.date, rawDate: r.rawDate,
          time: r.time || null, venue: "Orkidstra", description: null, url: r.href,
        });
      }
    }
  } catch(e) {
    console.log("    Orkidstra unreachable:", e.message);
  }
  console.log(`    Found ${events.length} Orkidstra events`);
  return events;
}

async function scrapeThirteenStrings() {
  // WordPress/WooCommerce + Visual Composer. Events are /product/ pages.
  // Structure: <a href="/product/..."><img></a> then <h4>title</h4><p>Day, Month DD, YYYY | time</p>
  console.log("  Scraping Thirteen Strings...");
  const events = [];
  try {
    const html = await fetchHTML("https://thirteenstrings.ca/events/");
    const $ = cheerio.load(html);
    const seen = new Set();
    $("a[href*='/product/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || seen.has(href)) return;
      // Climb up to find the column container, then search within it
      const col = $(el).closest(".wpb_column, .vc_column_container");
      const title = col.find("h4").first().text().trim();
      const dateText = col.find("p").first().text().trim();
      // "Wednesday, May 13, 2026 | 7:30 p.m."
      const dm = dateText.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i);
      const tm = dateText.match(/(\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?))/i);
      if (!title || title.length < 3 || !dm) return;
      seen.add(href);
      events.push({
        source: "thirteenstrings", title: title.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,"").trim(),
        date: normalizeDate(dm[1]), rawDate: dm[1],
        time: tm ? tm[1].replace(/\./g,"").toLowerCase() : null,
        venue: "Thirteen Strings", description: null, url: href,
      });
    });
  } catch(e) {
    console.log("    Thirteen Strings unreachable:", e.message);
  }
  console.log(`    Found ${events.length} Thirteen Strings events`);
  return events;
}



async function scrapeGoogleSheet() {
  // Public Google Sheet — read-only CSV export, no API key needed
  // Columns: title, date, time, venue, url, description, category
  console.log("  Scraping Google Sheet (manual events)...");
  const events = [];
  const SHEET_ID = "1hqa-QdXf3EABAZbrPQKpEyyHKI2YcNB0DPRRfXsNlGg";
  const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

  try {
    const res = await fetch(CSV_URL, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    const lines = text.trim().split("\n");
    if (lines.length < 2) { console.log("    No manual events in sheet"); return []; }

    // Parse header row to find column indices (case-insensitive)
    const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/^"|"$/g, ""));
    const col = name => headers.indexOf(name);

    for (let i = 1; i < lines.length; i++) {
      // Handle quoted CSV fields
      const row = lines[i].match(/("(?:[^"]|"")*"|[^,]*),?/g)
        ?.map(f => f.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim()) || [];

      const title = row[col("title")] || "";
      const date  = row[col("date")]  || "";
      const time  = row[col("time")]  || null;
      const venue = row[col("venue")] || null;
      const url   = row[col("url")]   || "https://docs.google.com/spreadsheets/d/" + SHEET_ID;
      const desc  = row[col("description")] || null;
      const cat   = row[col("category")]?.toLowerCase() || null;

      if (!title || !date) continue;
      // Accept YYYY-MM-DD or DD-MM-YYYY, convert to YYYY-MM-DD
      let normDate = date;
      if (/^\d{2}-\d{2}-\d{4}$/.test(date)) {
        const [d, m, y] = date.split("-");
        normDate = `${y}-${m}-${d}`;
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        continue; // skip unrecognised formats
      }

      events.push({
        source: "manual",
        title,
        date: normDate,
        rawDate: date,
        time: time || null,
        venue: venue || null,
        description: desc?.slice(0, 200) || null,
        category: cat || null,
        url,
      });
    }
  } catch(e) {
    console.log("    Google Sheet unreachable:", e.message);
  }

  console.log(`    Found ${events.length} manual events`);
  return events;
}

async function scrapeBronson() {
  // Custom WordPress theme — events at /events/ with pagination
  // Structure: article.event-item > header.event-date + div.event-title > a
  console.log("  Scraping The Bronson...");
  const events = [];
  const BASE = "https://bronsoncentremusictheatre.com";
  const seen = new Set();

  const MONTH_MAP = {
    Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
    Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12"
  };

  function parseBronsonDate(raw) {
    // "Friday, Jun 5, Doors: 6pm" or "Thursday, Jul 16, Doors: 7pm"
    const m = raw.match(/(\w{3})\s+(\d{1,2})/);
    if (!m) return { date: null, time: null };
    const month = MONTH_MAP[m[1]];
    if (!month) return { date: null, time: null };
    const day = m[2].padStart(2,"0");
    const year = new Date().getFullYear();
    // If month is earlier than current month, it's next year
    const curMonth = new Date().getMonth() + 1;
    const eventYear = parseInt(month) < curMonth ? year + 1 : year;
    const date = `${eventYear}-${month}-${day}`;
    // Extract time: "Doors: 6pm" → "18:00"
    const tm = raw.match(/Doors:\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    let time = null;
    if (tm) {
      let h = parseInt(tm[1]);
      const mins = tm[2] || "00";
      if (tm[3].toLowerCase() === "pm" && h !== 12) h += 12;
      if (tm[3].toLowerCase() === "am" && h === 12) h = 0;
      time = `${String(h).padStart(2,"0")}:${mins}`;
    }
    return { date, time };
  }

  try {
    let page = 1;
    while (page <= 5) {
      const url = page === 1 ? `${BASE}/events/` : `${BASE}/events/page/${page}/`;
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      const items = $("article.event-item");
      if (items.length === 0) break;

      items.each((_, el) => {
        const rawDate = $(el).find("header.event-date").text().trim();
        const titleEl = $(el).find("div.event-title a");
        const title = titleEl.text().trim();
        const href = titleEl.attr("href") || "";
        if (!title || !href || seen.has(href)) return;
        seen.add(href);
        const { date, time } = parseBronsonDate(rawDate);
        if (!date) return;
        events.push({
          source: "bronson",
          title,
          date,
          rawDate,
          time,
          venue: "The Bronson",
          description: null,
          url: href,
        });
      });

      // Check if there's a next page
      if ($("a[href*='/events/page/']").length === 0 && page > 1) break;
      page++;
    }
  } catch(e) {
    console.log("    Bronson unreachable:", e.message);
  }

  console.log(`    Found ${events.length} Bronson events`);
  return events;
}

async function scrapeChamberfest() {
  // WordPress site — events listed as plain links: "Sun Jul 5 2026 Event Title"
  // Individual pages have time in <h1>...<small>13:00</small></h1>
  // and venue in <div class="cf-event-loc"><a>Venue Name | address</a></div>
  console.log("  Scraping Chamberfest...");
  const events = [];
  const BASE = "https://www.chamberfest.com";

  const MONTH_MAP = {
    Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
    Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12"
  };

  try {
    const html = await fetchHTML(`${BASE}/events/`);
    const $ = cheerio.load(html);
    const seen = new Set();

    // Events are anchor tags with text like "Sun Jul 5 2026 Event Title"
    $("a[href*='/event/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || seen.has(href)) return;
      const fullText = $(el).text().trim();
      const dm = fullText.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})\s+(.+)$/i);
      if (!dm) return;
      seen.add(href);
      const month = MONTH_MAP[dm[1]];
      const day = dm[2].padStart(2, "0");
      const year = dm[3];
      const title = dm[4].trim();
      if (!title || !month) return;
      events.push({
        source: "chamberfest",
        title,
        date: `${year}-${month}-${day}`,
        rawDate: `${dm[1]} ${dm[2]} ${year}`,
        time: null,
        venue: "Chamberfest",
        description: null,
        url: href,
      });
    });

    // Fetch individual pages in batches to get time and venue
    for (let i = 0; i < events.length; i += 5) {
      const batch = events.slice(i, i + 5);
      await Promise.all(batch.map(async (ev) => {
        try {
          const pageHtml = await fetchHTML(ev.url);
          const $p = cheerio.load(pageHtml);
          // Time is in <h1>...<small>13:00</small></h1>
          const timeText = $p("h1 small").first().text().trim();
          if (timeText && /^\d{2}:\d{2}$/.test(timeText)) {
            ev.time = timeText;
          }
          // Venue is in .cf-event-loc a — "The Robo Lounge | 275 Carling Ave..."
          const venueText = $p(".cf-event-loc a").first().text().trim();
          if (venueText) {
            ev.venue = venueText.split("|")[0].trim();
          }
        } catch { /* skip */ }
      }));
    }
  } catch(e) {
    console.log("    Chamberfest unreachable:", e.message);
  }

  console.log(`    Found ${events.length} Chamberfest events`);
  return events;
}

async function scrapeCityFolk() {
  // WordPress site — schedule page has h2 day headings + h3 artist names
  console.log("  Scraping CityFolk Festival...");
  const events = [];
  const BASE = "https://cityfolkfestival.com";

  // Known dates for 2026 festival — Sep 16-20
  const DAY_DATES = {
    "wed, sep 16": "2026-09-16",
    "thu, sep 17": "2026-09-17",
    "fri, sep 18": "2026-09-18",
    "sat, sep 19": "2026-09-19",
    "sun, sep 20": "2026-09-20",
  };

  try {
    const html = await fetchHTML(`${BASE}/schedule/`);
    const $ = cheerio.load(html);
    let currentDate = null;

    // Walk through h2 (day headings) and h3 (artist names)
    $("h2, h3").each((_, el) => {
      const text = $(el).text().trim();
      if (el.name === "h2") {
        const key = text.toLowerCase();
        currentDate = DAY_DATES[key] || null;
      } else if (el.name === "h3" && currentDate && text.length > 1) {
        // Skip "Share" and other UI labels
        if (text.toLowerCase() === "share" || text.length < 2) return;
        const title = text.charAt(0) + text.slice(1).toLowerCase()
          .replace(/\b\w/g, c => c.toUpperCase()); // Title case
        events.push({
          source: "cityfolk",
          title,
          date: currentDate,
          rawDate: currentDate,
          time: null,
          venue: "CityFolk Festival",
          description: null,
          url: `${BASE}/schedule/`,
        });
      }
    });
  } catch(e) {
    console.log("    CityFolk unreachable:", e.message);
  }

  console.log(`    Found ${events.length} CityFolk events`);
  return events;
}

async function scrapeMotelChelsea() {
  // Wix site — events in link text format: "THURSDAY MAY 28 | The Sadies | 7:30PM"
  // Note: Wix lazy-loads, so only first few events are captured
  console.log("  Scraping Motel Chelsea (La Vallée)...");
  const events = [];
  const BASE = "https://www.motelchelsea.com";

  const MONTH_MAP = {
    JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
    JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12"
  };

  try {
    const html = await fetchHTML(`${BASE}/love-live`);
    const $ = cheerio.load(html);
    const seen = new Set();
    const today = new Date().toISOString().split("T")[0];

    $("a[href*='/post/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || seen.has(href)) return;
      const text = $(el).text().trim();
      // Match: "THURSDAY MAY 28 | The Sadies | 7:30PM" or "FRIDAY JUNE 4 | ..."
      const m = text.match(/^(?:MON|TUE|WED|THU|FRI|SAT|SUN)(?:DAY)?\s+(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\s+(\d{1,2})\s*\|\s*(.+?)\s*\|\s*(\d{1,2}:\d{2}(?:AM|PM)?)/i);
      if (!m) return;
      seen.add(href);

      const month = MONTH_MAP[m[1].toUpperCase().slice(0,3)];
      if (!month) return;
      const day = m[2].padStart(2, "0");
      const title = m[3].trim();
      const rawTime = m[4].trim();

      // Try current year first, use next year only if that gives a future date
      const curYear = new Date().getFullYear();
      const dateThisYear = `${curYear}-${month}-${day}`;
      const date = dateThisYear >= today ? dateThisYear : `${curYear + 1}-${month}-${day}`;
      if (date < today) return;

      // Convert time to 24h
      const tm = rawTime.match(/(\d{1,2}):(\d{2})(AM|PM)?/i);
      let time = null;
      if (tm) {
        let h = parseInt(tm[1]);
        const mins = tm[2];
        const ampm = tm[3]?.toUpperCase();
        if (ampm === "PM" && h !== 12) h += 12;
        if (ampm === "AM" && h === 12) h = 0;
        time = `${String(h).padStart(2,"0")}:${mins}`;
      }

      events.push({
        source: "motelchelsea",
        title,
        date,
        rawDate: `${m[1]} ${day}`,
        time,
        venue: "Motel Chelsea",
        description: null,
        url: href.startsWith("http") ? href : `${BASE}${href}`,
      });
    });
  } catch(e) {
    console.log("    Motel Chelsea unreachable:", e.message);
  }

  console.log(`    Found ${events.length} Motel Chelsea events`);
  return events;
}