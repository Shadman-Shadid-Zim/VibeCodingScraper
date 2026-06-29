// ============================================================
// server.js — VibeCodingScraper Backend Engine v2
// ------------------------------------------------------------
// Two modes now exist:
//
// QUICK SCRAPE — headless (invisible) browser, no interaction.
//   Used for: grabbing a homepage's content fast.
//
// WORKFLOW RECORDER — visible browser window pops up on screen.
//   Used for: simulating a real user typing a search query,
//   pressing Enter, and capturing what the results page returns.
//   Think of it as hiring a visible robot intern you can watch work.
// ============================================================

const express   = require("express");
const cors      = require("cors");
const puppeteer = require("puppeteer");
const fs        = require("fs");
const path      = require("path");

const app  = express();
const PORT = 3000;

const WORKFLOWS_FILE = path.join(__dirname, "workflows.json");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Workflow file helpers ─────────────────────────────────────
function loadWorkflows() {
  if (!fs.existsSync(WORKFLOWS_FILE)) return [];
  return JSON.parse(fs.readFileSync(WORKFLOWS_FILE, "utf-8"));
}
function saveWorkflows(list) {
  fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(list, null, 2));
}

// ============================================================
// THE CORE ENGINE — scrapeUrl({ url, searchQuery, searchSelector })
// ------------------------------------------------------------
// Parameters:
//   url            — the website to visit (required)
//   searchQuery    — text to type into the search box (optional)
//   searchSelector — CSS address of the search box element (optional)
//
// When searchQuery + searchSelector are provided, the engine:
//   1. Opens a VISIBLE Chrome window (so you can watch)
//   2. Navigates to the URL
//   3. Clears the response log (so we only capture search-triggered traffic)
//   4. Finds the search box and clicks it
//   5. Types the query one character at a time with 100ms delays
//      — this is the "human typing simulation"
//   6. Pauses briefly, then presses Enter
//   7. Waits for the results page/AJAX response to load
//   8. Extracts all visible content from the results page
//   9. Closes the browser and returns the data
//
// HOW HUMAN TYPING IS SIMULATED:
//   page.type(selector, text, { delay: 100 }) is Puppeteer's built-in
//   method that dispatches real keyboard events (keydown → keypress →
//   input → keyup) for each character with a 100ms pause between them.
//   This mimics a person typing at ~10 characters/second — slow enough
//   that the site's autocomplete/validation JavaScript fires normally,
//   just as it would for a real user.
// ============================================================

async function scrapeUrl({ url, searchQuery = null, searchSelector = null }) {
  // Recording mode activates whenever a searchQuery is provided.
  // The selector is OPTIONAL — if blank, auto-detect fills it after page load.
  const isRecording    = Boolean(searchQuery);
  let resolvedSelector = searchSelector || null; // may be replaced by auto-detect

  const browser = await puppeteer.launch({
    // Visible browser for recording; hidden for quick scrapes
    headless: !isRecording,
    // null = use the browser's natural window size (better for demos)
    defaultViewport: isRecording ? null : { width: 1280, height: 800 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  // Pose as a real Chrome user so the site doesn't block us
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
  );

  // ── NETWORK INTERCEPTION ──────────────────────────────────
  // We listen to every JSON response the browser receives.
  // In recording mode, we CLEAR this list right before typing
  // the search query — so the array only contains responses
  // that were triggered BY the search action, not the page load.
  const interceptedApiCalls = [];

  page.on("response", async (response) => {
    const responseUrl = response.url();
    const contentType = response.headers()["content-type"] || "";
    const status      = response.status();

    if (contentType.includes("application/json") && status === 200) {
      try {
        const json = await response.json();
        interceptedApiCalls.push({ endpoint: responseUrl, data: json });
      } catch (_) {}
    }
  });
  // ── END NETWORK INTERCEPTION ──────────────────────────────

  // Navigate — swallow timeout errors since sites like DSE never fully settle
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (err) {
    if (!err.message.toLowerCase().includes("timeout")) throw err;
  }

  // Initial render wait — let JavaScript paint the page
  await new Promise((r) => setTimeout(r, 2000));

  // ── RECORDING MODE: SEARCH INTERACTION ───────────────────
  if (isRecording) {
    // IMPORTANT: flush the page-load API calls collected so far.
    // From this moment on, the array only collects traffic caused
    // by the search action — exactly the "narrow" interception requested.
    interceptedApiCalls.length = 0;

    // ── STEP 1: AUTO-DETECT SEARCH FIELD (if selector was left blank) ───
    // Analogy: the user pointed us at a building (the URL) but didn't tell
    // us which door is the entrance. Auto-detect walks the building's floor
    // plan (the DOM) and tries every door in order of likelihood.
    if (!resolvedSelector) {
      // React/Vue sites mount components AFTER domcontentloaded fires.
      // Poll the DOM for up to 6 s before running auto-detect so the scan
      // always sees a fully rendered page, not a half-hydrated skeleton.
      await page.waitForFunction(() => {
        const probes = [
          'input[type="search"]', 'input[name="q"]', 'input[name="s"]',
          'input[name="search"]', 'input[name="query"]', 'input[name="keyword"]',
          'input[type="text"]',
        ];
        return probes.some(sel => {
          const el = document.querySelector(sel);
          return el && getComputedStyle(el).display !== "none" && !el.disabled;
        });
      }, { timeout: 6000 }).catch(() => {}); // silently proceed if nothing appears

      resolvedSelector = await page.evaluate(() => {
        // Priority list — most specific patterns first, generic last
        const cssCandidates = [
          'input[type="search"]',
          'input[name="q"]',
          'input[name="s"]',
          'input[name="search"]',
          'input[name="query"]',
          'input[name="keyword"]',
        ];

        // isUsable: checks the element's OWN computed style.
        // offsetParent would also return null for position:fixed elements and elements
        // inside collapsed containers (like Wikipedia's search bar) — too aggressive.
        // getComputedStyle reads the element itself and is far more reliable.
        const isUsable = (el) =>
          getComputedStyle(el).display     !== "none" &&
          getComputedStyle(el).visibility  !== "hidden" &&
          !el.readOnly && !el.disabled;

        // Try exact CSS matches first (covers most sites instantly)
        for (const sel of cssCandidates) {
          const el = document.querySelector(sel);
          if (el && isUsable(el)) return sel;
        }

        // Fall back to JavaScript scan for fuzzy attribute matching
        // Also include input[type="search"] in the scan pool
        const inputs = Array.from(
          document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')
        );

        // A "stable" ID is written by a human developer (e.g. "searchInput", "q").
        // React/Next.js auto-generate IDs like ":Rklarct:" (contain colons) —
        // those change on every render and are useless as selectors.
        const stableId = (id) => id && /^[a-zA-Z]/.test(id) && !id.includes(":");

        // Build the most specific, stable selector for an input element
        const selectorFor = (input) => {
          if (stableId(input.id))   return `#${input.id}`;
          if (input.name)           return `input[name="${input.name}"]`;
          if (input.placeholder)    return `input[placeholder="${input.placeholder}"]`;
          return input.type === "search" ? 'input[type="search"]' : 'input[type="text"]';
        };

        for (const input of inputs) {
          if (!isUsable(input)) continue;

          const name  = (input.name                       || "").toLowerCase();
          const id    = (input.id                         || "").toLowerCase();
          const ph    = (input.placeholder                || "").toLowerCase();
          const cls   = (input.className                  || "").toLowerCase();
          const label = (input.getAttribute("aria-label") || "").toLowerCase();

          const isSearchLike =
            name.includes("search")  || name.includes("query")   || name.includes("keyword") ||
            id.includes("search")    || id.includes("query")     ||
            ph.includes("search")    || ph.includes("find")      || ph.includes("look up")   ||
            cls.includes("search")   ||
            label.includes("search") || label.includes("destination") || label.includes("location");

          if (isSearchLike) return selectorFor(input);
        }

        // Last resort: first usable text/search input on the page
        for (const input of inputs) {
          if (isUsable(input)) return selectorFor(input);
        }

        return null; // nothing found
      });

      if (!resolvedSelector) {
        await browser.close();
        throw new Error(
          "Auto-detect could not find a search field on this page. " +
          "Please enter the CSS Selector manually (right-click the search box → Inspect)."
        );
      }
      console.log(`[Auto-detect] Found search field: "${resolvedSelector}"`);
    }
    // ── END AUTO-DETECT ────────────────────────────────────────

    // Step 2: Verify the resolved selector is present and visible
    try {
      await page.waitForSelector(resolvedSelector, { visible: true, timeout: 10000 });
    } catch {
      await browser.close();
      throw new Error(
        `Could not find the search box using selector "${resolvedSelector}". ` +
        `Tip: right-click the search field on the website → click Inspect → ` +
        `look for the id= or name= attribute in the highlighted HTML.`
      );
    }

    // Step 3: Click the search box (triple-click selects all existing text so
    // our typing replaces it cleanly, like highlighting and overwriting)
    await page.click(resolvedSelector, { clickCount: 3 });

    // Step 4: TYPE the query — one character at a time, 100ms per keystroke.
    // Real keydown → keypress → input → keyup events fire for each letter,
    // so the site's autocomplete JS responds exactly as it would for a human.
    console.log(`[Recording] Typing "${searchQuery}" into "${resolvedSelector}"...`);
    await page.type(resolvedSelector, searchQuery, { delay: 100 });

    // Step 5: Pause 400ms — humans don't instantly submit after typing
    await new Promise((r) => setTimeout(r, 400));

    // Step 6: Press Enter — works for most standard search forms
    await page.keyboard.press("Enter");
    console.log(`[Recording] Enter pressed.`);

    // Step 7: Try to click the nearest submit button (needed for DSE-style sites).
    // Wrapped in try/catch: fast-navigating sites (IMDB, Wikipedia) destroy the JS
    // context the moment Enter is pressed — that's fine, Enter already submitted.
    try {
      const clickedBtn = await page.evaluate((inputSel) => {
        const input = document.querySelector(inputSel);
        if (!input) return null;
        let container = input.parentElement;
        for (let i = 0; i < 6; i++) {
          const btn = container
            ? container.querySelector('button[type="submit"], input[type="submit"]')
            : null;
          if (btn) {
            btn.click();
            return btn.className || btn.id || "submit button";
          }
          if (container && container.parentElement) container = container.parentElement;
        }
        return null;
      }, resolvedSelector);

      if (clickedBtn) {
        console.log(`[Recording] Also clicked submit button: "${clickedBtn}"`);
      } else {
        console.log(`[Recording] No submit button found nearby — relying on Enter.`);
      }
    } catch (_) {
      // Page already navigating after Enter — that means Enter worked perfectly.
      console.log(`[Recording] Page navigating — submit button click not needed.`);
    }

    // Step 8: Wait for results — sites fall into two categories:
    //   (a) Full navigation (IMDB, Wikipedia): waitForNavigation resolves when new page loads
    //   (b) AJAX-only (DSE): no navigation, JS updates the table in-place — 4s timeout wins
    // Promise.race handles both: whichever finishes first proceeds.
    console.log(`[Recording] Waiting for search results to appear...`);
    await Promise.race([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {}),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    // Extra buffer so the results page renders its own JS before we extract data
    await new Promise((r) => setTimeout(r, 1500));
    console.log(`[Recording] Results ready.`);
  }
  // ── END RECORDING MODE ────────────────────────────────────

  // ── EXTRACT VISIBLE PAGE CONTENT ─────────────────────────
  const pageData = await page.evaluate(() => {
    const text = (el) => el ? el.innerText.trim().replace(/\s+/g, " ") : "";

    const title = document.title;

    const metaDesc = document.querySelector("meta[name='description']");
    const description = metaDesc ? metaDesc.content : "";

    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((h) => ({ level: h.tagName, text: text(h) }))
      .filter((h) => h.text.length > 0)
      .slice(0, 20);

    const paragraphs = Array.from(document.querySelectorAll("p"))
      .map((p) => text(p))
      .filter((t) => t.length > 30)
      .slice(0, 15);

    const links = Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({ text: text(a), href: a.href }))
      .filter((l) => l.text.length > 0 && l.href.startsWith("http"))
      .slice(0, 30);

    const tables = Array.from(document.querySelectorAll("table")).map((table) => {
      const headers = Array.from(table.querySelectorAll("th")).map((th) => text(th));
      const rows = Array.from(table.querySelectorAll("tr"))
        .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => text(td)))
        .filter((row) => row.length > 0);
      return { headers, rows };
    }).slice(0, 5);

    const images = Array.from(document.querySelectorAll("img[alt]"))
      .map((img) => ({ alt: img.alt, src: img.src }))
      .filter((img) => img.alt.length > 0)
      .slice(0, 10);

    return { title, description, headings, paragraphs, links, tables, images };
  });
  // ── END EXTRACT ───────────────────────────────────────────

  await browser.close();

  return {
    url,
    searchQuery,                     // null for quick scrapes; the typed term for recordings
    searchSelector: resolvedSelector, // the actual selector used (may be auto-detected)
    autoDetected: !searchSelector && Boolean(resolvedSelector), // flag for UI to display
    scrapedAt: new Date().toISOString(),
    pageContent: pageData,
    interceptedApiCalls: interceptedApiCalls.slice(0, 10)
  };
}

// ============================================================
// API ROUTES
// ============================================================

// ── POST /api/scrape ─────────────────────────────────────────
// Accepts: { url, searchQuery?, searchSelector? }
// If searchQuery + searchSelector present → recording mode (visible browser)
// Otherwise → quick scrape mode (headless)
app.post("/api/scrape", async (req, res) => {
  const { url, searchQuery, searchSelector } = req.body;

  if (!url || !url.startsWith("http")) {
    return res.status(400).json({ error: "Please provide a valid URL starting with http:// or https://" });
  }

  const mode = searchQuery && searchSelector ? "RECORD" : "SCRAPE";
  try {
    console.log(`[${mode}] ${url}${searchQuery ? ` → query: "${searchQuery}"` : ""}`);
    const result = await scrapeUrl({ url, searchQuery, searchSelector });
    console.log(`[Done]   ${url}`);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`[Error]  ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/workflows ───────────────────────────────────────
app.get("/api/workflows", (req, res) => {
  res.json(loadWorkflows());
});

// ── POST /api/workflows ──────────────────────────────────────
// Saves a recorded result as a named, replayable workflow.
// Stores searchQuery and searchSelector so re-runs work automatically.
app.post("/api/workflows", (req, res) => {
  const { name, url, searchQuery, searchSelector, data } = req.body;
  if (!name || !url) return res.status(400).json({ error: "Name and URL are required." });

  const list = loadWorkflows();
  const workflow = {
    id:             Date.now().toString(),
    name,
    url,
    searchQuery:    searchQuery    || null,
    searchSelector: searchSelector || null,
    createdAt:      new Date().toISOString(),
    lastResult:     data || null
  };

  list.unshift(workflow);
  saveWorkflows(list);
  res.json({ success: true, workflow });
});

// ── POST /api/workflows/:id/run ──────────────────────────────
// Re-runs a saved workflow — replays the full search recording
// using the stored URL, query, and selector automatically.
app.post("/api/workflows/:id/run", async (req, res) => {
  const list     = loadWorkflows();
  const workflow = list.find((w) => w.id === req.params.id);
  if (!workflow) return res.status(404).json({ error: "Workflow not found." });

  try {
    console.log(`[Re-run] "${workflow.name}" → ${workflow.url}`);
    const result = await scrapeUrl({
      url:            workflow.url,
      searchQuery:    workflow.searchQuery,
      searchSelector: workflow.searchSelector
    });
    workflow.lastResult = result;
    workflow.lastRun    = new Date().toISOString();
    saveWorkflows(list);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/workflows/:id ────────────────────────────────
app.delete("/api/workflows/:id", (req, res) => {
  let list   = loadWorkflows();
  const prev = list.length;
  list       = list.filter((w) => w.id !== req.params.id);
  if (list.length === prev) return res.status(404).json({ error: "Workflow not found." });
  saveWorkflows(list);
  res.json({ success: true });
});

// ── GET /api/live/:workflowId?q=<term> ───────────────────────
// ============================================================
// THE AUTOCOMPLETE API GENERATOR
// ------------------------------------------------------------
// This is the headline feature: a dynamic, callable API endpoint.
//
// Analogy: imagine you saved a "DSE Company Search" workflow.
// Now any app, spreadsheet, or script can call:
//   GET http://localhost:3000/api/live/{id}?q=ROBI
// and our robot instantly:
//   1. Opens DSE in a headless (invisible) browser
//   2. Types "ROBI" into the search box
//   3. Waits 1.5 seconds for the autocomplete dropdown to appear
//   4. Captures both the network JSON response AND the dropdown
//      items visible in the page (two sources for maximum coverage)
//   5. Returns all of it as clean JSON — right here in this HTTP response
//
// The ?q= parameter is DYNAMIC — changing it changes the search.
// This turns a static website into a queryable API with zero backend changes to DSE.
// ============================================================
app.get("/api/live/:workflowId", async (req, res) => {
  const q = (req.query.q || "").trim();

  if (!q) {
    return res.status(400).json({
      error: "Missing search term. Add ?q=ROBI to the URL.",
      example: `http://localhost:${PORT}/api/live/${req.params.workflowId}?q=ROBI`
    });
  }

  const workflow = loadWorkflows().find((w) => w.id === req.params.workflowId);
  if (!workflow)          return res.status(404).json({ error: "Workflow not found." });
  if (!workflow.searchSelector) {
    return res.status(400).json({
      error: "This workflow was saved without a search selector — it cannot be used as a Live API. Re-record it using Workflow Recorder mode."
    });
  }

  console.log(`[Live API] workflow="${workflow.name}" q="${q}"`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true, // Always invisible for API calls — no popup window
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: { width: 1280, height: 800 }
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    );

    // ── RESPONSE INTERCEPTOR ─────────────────────────────────
    // We collect ALL JSON responses the browser receives.
    // After the page loads we flush this array, so only traffic
    // triggered by typing the query gets recorded.
    const capturedApiCalls = [];
    page.on("response", async (response) => {
      const ct = response.headers()["content-type"] || "";
      if (response.status() === 200 && ct.includes("application/json")) {
        try {
          const json = await response.json();
          capturedApiCalls.push({ endpoint: response.url(), data: json });
        } catch (_) {}
      }
    });

    // Navigate to the saved URL
    try {
      await page.goto(workflow.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (err) {
      if (!err.message.toLowerCase().includes("timeout")) throw err;
    }
    await new Promise((r) => setTimeout(r, 2000));

    // Flush page-load responses — we only want search-triggered ones
    capturedApiCalls.length = 0;

    // Find the search box
    await page.waitForSelector(workflow.searchSelector, { visible: true, timeout: 10000 })
      .catch(() => { throw new Error(`Search box "${workflow.searchSelector}" not found on page.`); });

    // Clear any existing text and type the query
    await page.click(workflow.searchSelector, { clickCount: 3 });
    await page.type(workflow.searchSelector, q, { delay: 80 });

    // ── WAIT FOR AUTOCOMPLETE ─────────────────────────────────
    // 1.5 seconds gives the site's JavaScript time to:
    //   a) detect the input change event
    //   b) fire an XHR/fetch call to its search API
    //   c) receive the response and render the dropdown
    await new Promise((r) => setTimeout(r, 1500));

    // ── EXTRACT DROPDOWN FROM THE DOM ────────────────────────
    // Some sites (like DSE with jQuery UI) render the autocomplete
    // results directly into the HTML as <li> elements inside a
    // <ul class="ui-autocomplete"> menu. We scrape those items too,
    // giving us the data even if the network response wasn't JSON.
    const dropdownItems = await page.evaluate(() => {
      // These selectors cover the most common autocomplete libraries
      const candidates = [
        { sel: ".ui-autocomplete .ui-menu-item",    textSel: "a, .ui-menu-item-wrapper, div" },
        { sel: ".ui-menu .ui-menu-item",            textSel: "a, .ui-menu-item-wrapper" },
        { sel: ".autocomplete-suggestions .autocomplete-suggestion", textSel: null },
        { sel: "[role='listbox'] [role='option']",  textSel: null },
        { sel: ".dropdown-menu li",                 textSel: "a, span" },
        { sel: ".search-results li",                textSel: null },
      ];

      for (const { sel, textSel } of candidates) {
        const nodes = Array.from(document.querySelectorAll(sel));
        if (!nodes.length) continue;

        const items = nodes.map((node) => {
          const child = textSel ? node.querySelector(textSel) : null;
          const el    = child || node;
          return {
            text:  (el.innerText || el.textContent || "").trim().replace(/\s+/g, " "),
            value: node.getAttribute("data-value") || node.getAttribute("data-id") || null
          };
        }).filter((it) => it.text.length > 0);

        if (items.length) return { foundVia: sel, items };
      }
      return { foundVia: null, items: [] };
    });

    await browser.close();
    browser = null;

    console.log(`[Live API] Dropdown items: ${dropdownItems.items.length} | API calls: ${capturedApiCalls.length}`);

    // Return the structured result
    res.json({
      success:        true,
      query:          q,
      capturedAt:     new Date().toISOString(),
      workflow:       { id: workflow.id, name: workflow.name, url: workflow.url },
      dropdownItems,        // Items rendered in the autocomplete dropdown (from DOM)
      capturedApiCalls      // Raw JSON intercepted from the network during typing
    });

  } catch (err) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    console.error(`[Live API Error] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  VibeCodingScraper v2 is running!    ║");
  console.log(`║  Open: http://localhost:${PORT}         ║`);
  console.log("╚══════════════════════════════════════╝");
});
