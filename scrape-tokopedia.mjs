import { chromium, firefox, webkit } from "playwright";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) args[k.slice(2)] = true;
    else args[k.slice(2)] = v;
  }
  return args;
}

function cleanText(s) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

function normalizeUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return raw.split("?")[0];
  }
}

function toAbsUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function isTokopediaProductUrl(raw) {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "");
    if (host !== "tokopedia.com") return false;

    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length < 2) return false; // /toko/slug-produk

    const blockedFirst = new Set([
      "search", "cart", "help", "events", "promo", "discover",
      "p", "mobile-apps", "blog", "mitra", "seller", "edu",
      "care", "about", "terms", "privacy",
    ]);
    if (blockedFirst.has(seg[0])) return false;

    return true;
  } catch {
    return false;
  }
}

async function loadExistingJsonl(outFile) {
  const seen = new Set();
  let lines = 0;
  if (!fs.existsSync(outFile)) return { seen, lines };

  const data = await fsp.readFile(outFile, "utf8");
  for (const line of data.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj?.url) seen.add(obj.url);
      lines++;
    } catch {}
  }
  return { seen, lines };
}

async function appendJsonl(outFile, row) {
  await fsp.appendFile(outFile, JSON.stringify(row) + "\n", "utf8");
}

async function saveDiagnostics(page, prefix) {
  try {
    const ts = Date.now();
    await page.screenshot({ path: `${prefix}.${ts}.png`, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => "");
    if (html) await fsp.writeFile(`${prefix}.${ts}.html`, html, "utf8").catch(() => {});
  } catch {}
}

// Retry goto (buat network flaky / http2 error di sebagian kondisi)
async function safeGoto(page, url, tries = 4) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 90_000 });
      await page.waitForTimeout(1500);
      return;
    } catch (e) {
      lastErr = e;
      await page.evaluate(() => window.stop()).catch(() => {});
      const backoff = 1200 * i;
      console.log(`[safeGoto] retry ${i}/${tries} after ${backoff}ms -> ${e?.message || e}`);
      await page.waitForTimeout(backoff);
      await page.reload({ waitUntil: "commit", timeout: 90_000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
  }
  throw lastErr;
}

async function autoScroll(page, { steps = 10, stepPx = 1200, waitMs = 900 } = {}) {
  let lastH = await page.evaluate(() => document.body?.scrollHeight ?? 0);
  for (let i = 0; i < steps; i++) {
    await page.evaluate((px) => window.scrollBy(0, px), stepPx);
    await page.waitForTimeout(waitMs);
    const newH = await page.evaluate(() => document.body?.scrollHeight ?? 0);
    if (newH === lastH) break;
    lastH = newH;
  }
}

async function waitForListingReady(page, timeoutMs = 45_000) {
  await page.waitForSelector("body", { timeout: timeoutMs });
  await page.waitForSelector('a[data-testid="lnkProductContainer"]', { timeout: timeoutMs });
}

// Ambil href dari anchor yang kamu sebutkan
async function getListingProductUrls(page) {
  await autoScroll(page);

  const hrefs = await page.$$eval('a[data-testid="lnkProductContainer"]', (as) =>
    as.map((a) => a.getAttribute("href")).filter(Boolean)
  );

  const base = page.url();
  const urls = hrefs
    .map((h) => toAbsUrl(h, base))
    .map((u) => normalizeUrl(u))
    .filter((u) => u && isTokopediaProductUrl(u));

  const seen = new Set();
  const uniq = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    uniq.push(u);
  }
  return uniq;
}

// Scrape PDP pakai selector kamu
async function scrapePdp(context, productUrl) {
  const p = await context.newPage();
  try {
    await safeGoto(p, productUrl);

    const titleLoc = p.locator('[data-testid="lblPDPDetailProductName"]');
    const priceLoc = p.locator('[data-testid="lblPDPDetailProductPrice"]');
    const descLoc  = p.locator('[data-testid="lblPDPDescriptionProduk"]');

    await titleLoc.first().waitFor({ timeout: 35_000 });

    // pastikan deskripsi ke-load
    await descLoc.first().scrollIntoViewIfNeeded().catch(() => {});
    await p.waitForTimeout(250);

    const title = cleanText(await titleLoc.first().innerText().catch(() => ""));
    if (!title) return null;

    const price = cleanText(await priceLoc.first().innerText().catch(() => ""));
    const description = cleanText(await descLoc.first().innerText().catch(() => ""));

    return {
      title,
      price: price || null,
      description: description || null,
      finalUrl: normalizeUrl(p.url()),
    };
  } finally {
    await p.close().catch(() => {});
  }
}

async function launchBrowser(browserName, headless, slowMo) {
  const name = String(browserName || "firefox").toLowerCase();

  // NOTE:
  // - firefox/webkit: biasanya lolos dari ERR_HTTP2_PROTOCOL_ERROR yang kamu alami di headless chromium
  // - chrome channel: pakai Chrome sistem (kadang lebih stabil), tapi butuh Chrome terinstall
  if (name === "webkit") {
    return webkit.launch({ headless, slowMo });
  }

  if (name === "chromium") {
    return chromium.launch({
      headless,
      slowMo,
      args: [
        process.platform === "linux" ? "--no-sandbox" : "",
        "--disable-dev-shm-usage",
        "--disable-quic",
        "--disable-blink-features=AutomationControlled",
      ].filter(Boolean),
    });
  }

  if (name === "chrome") {
    return chromium.launch({
      channel: "chrome",
      headless,
      slowMo,
      args: [
        process.platform === "linux" ? "--no-sandbox" : "",
        "--disable-dev-shm-usage",
        "--disable-quic",
        "--disable-blink-features=AutomationControlled",
      ].filter(Boolean),
    });
  }

  // default firefox
  return firefox.launch({ headless, slowMo });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const startUrl =
    (typeof args.url === "string" && args.url) ||
    "https://www.tokopedia.com/p/komputer-laptop/laptop";

  const target = Number(args.target ?? 2000);
  const delayMs = Number(args.delay ?? 2500);
  const maxRoundsNoNew = Number(args.maxNoNew ?? 10);
  const browserName = args.browser ?? "firefox"; // DEFAULT FIREFOX
  const headless = args.headful ? false : true;
  const slowMo = Number(args.slowMo ?? (headless ? 0 : 120));
  const out = args.out ?? "tokopedia_laptop.jsonl";
  const blockImages = args.blockImages === undefined ? true : Boolean(args.blockImages);

  const absOut = path.resolve(out);
  const { seen, lines } = await loadExistingJsonl(absOut);

  console.log("Start URL :", startUrl);
  console.log("Browser   :", browserName);
  console.log("Headless  :", headless);
  console.log("Output    :", absOut);
  console.log("Resume    :", lines, "lines | seen:", seen.size);
  console.log("Target    :", target);

  const browser = await launchBrowser(browserName, headless, slowMo);

  const context = await browser.newContext({
    locale: "id-ID",
    timezoneId: "Asia/Jakarta",
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  // hemat bandwidth
  if (blockImages) {
    await context.route("**/*", (route) => {
      const rt = route.request().resourceType();
      if (["image", "font", "media"].includes(rt)) return route.abort();
      return route.continue();
    });
  }

  const listPage = await context.newPage();
  listPage.setDefaultTimeout(45_000);
  listPage.setDefaultNavigationTimeout(90_000);

  // START: goto kategori (pakai safeGoto)
  await safeGoto(listPage, startUrl);

  let total = seen.size;
  let noNewRounds = 0;

  while (total < target && noNewRounds < maxRoundsNoNew) {
    try {
      await waitForListingReady(listPage, 45_000);

      const productUrls = await getListingProductUrls(listPage);
      if (!productUrls.length) {
        noNewRounds++;
        console.log(`No product urls (round noNew=${noNewRounds}).`);
        await saveDiagnostics(listPage, "diag_list_empty");
        await sleep(delayMs);
        continue;
      }

      let added = 0;

      for (const url of productUrls) {
        if (total >= target) break;
        if (seen.has(url)) continue;

        console.log(`> PDP: ${url}`);

        const pdp = await scrapePdp(context, url).catch((e) => {
          console.log("  x PDP error:", e?.message || e);
          return null;
        });

        if (!pdp?.title) {
          console.log("  - skip (no title)");
          await sleep(delayMs);
          continue;
        }

        const finalUrl = normalizeUrl(pdp.finalUrl) || url;
        const row = {
          category_url: startUrl,
          url: finalUrl,
          title: pdp.title,
          price: pdp.price,
          description: pdp.description,
          scraped_at: new Date().toISOString(),
        };

        await appendJsonl(absOut, row);
        seen.add(finalUrl);
        total++;
        added++;

        console.log(`  + saved ${total}/${target} | ${pdp.title.slice(0, 70)}`);

        const jitter = Math.floor(Math.random() * 600);
        await sleep(delayMs + jitter);
      }

      if (added === 0) noNewRounds++;
      else noNewRounds = 0;

      // scroll untuk load produk baru di kategori
      await listPage.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 1.4)));
      await listPage.waitForTimeout(1200);
    } catch (e) {
      console.log("LIST ERROR:", e?.message || e);
      await saveDiagnostics(listPage, "diag_list_error");
      noNewRounds++;
      await sleep(Math.max(2500, delayMs));
    }
  }

  await browser.close();
  console.log(`\nDONE. Total saved: ${total}`);
  console.log("File:", absOut);

  if (noNewRounds >= maxRoundsNoNew) {
    console.log("Stop karena tidak ada produk baru yang bertambah (stagnant).");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
