# Ottawa Events Finder

A website to search cultural events in the Ottawa region, built with a nightly scraper and a simple local server. Zero per-search cost.

## Project Structure

```
ottawa-events/
├── frontend/
│   └── index.html       ← The website (deploy to GitHub Pages)
└── scraper/
    ├── scraper.js       ← Fetches & parses events from all sources
    ├── server.js        ← Serves scraped data to the frontend
    ├── package.json
    └── data/
        └── events.json  ← Auto-created when you run the scraper
```

## Getting Started

### 1. Install dependencies

```bash
cd scraper
npm install
```

### 2. Run the scraper

This fetches events from all sources and saves them to `data/events.json`:

```bash
npm run scrape
```

Run this once manually first. After that, set it up as a daily cron job (see below).

### 3. Start the server

```bash
npm run serve
```

You should see: `✅ Server running at http://localhost:3001`

### 4. Open the website

Open `frontend/index.html` in your browser. That's it!

---

## Keeping Data Fresh (Daily Scrape)

Add a cron job to re-scrape every night at midnight:

```bash
crontab -e
```

Add this line (update the path to match where you cloned the project):

```
0 0 * * * cd /path/to/ottawa-events/scraper && npm run scrape >> /tmp/ottawa-scraper.log 2>&1
```

---

## Deploying to GitHub Pages + a Free Server

**Frontend (GitHub Pages):**
1. Push the `frontend/` folder to a GitHub repo
2. Go to repo **Settings → Pages → Source → main / root**
3. Update the one line in `index.html`: `const API_URL = "https://your-server.railway.app/api/events"`

**Scraper + Server (Railway or Render — both free):**
1. Deploy the `scraper/` folder as a Node.js app
2. Set a cron job in Railway/Render to run `npm run scrape` nightly
3. The server runs continuously to answer frontend requests

---

## Adding More Sources

Add a new scraper function in `scraper.js` following the same pattern, then add the source to the `SOURCES` array in `frontend/index.html`.

Sources to add next:
- Bronson Center — bronsoncentremusictheatre.com
- Chamber Festival Ottawa — chamberfest.com  
- Music and Beyond — musicandbeyond.ca
- International Film Festival Ottawa — iffo.ca
- Ottawa Pops Orchestra — ottawapopsorchestra.ca
- Orkidstra — orkidstra.ca
- Thirteen Strings — thirteenstrings.ca
- Eventbrite Ottawa — eventbrite.ca
- CityFolk Festival — cityfolkfestival.com
- The Redbird — redbirdlive.ca
- Irene's Pub — irenespub.ca
- Gladstone Theater — thegladstone.ca
- Great Canadian Theater Company — gctc.ca
- Blacksheep Inn — theblacksheep.ca
- Ottawa Tourism — ottawatourism.ca
- La Vallee in Chelsea — motelchelsea.com
