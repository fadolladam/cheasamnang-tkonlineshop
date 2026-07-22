/**
 * TK Online Shop — Google Apps Script Backend  (v1)
 *
 * ── SETUP ────────────────────────────────────────────────────────────────────
 * 1. Go to script.google.com → New Project → rename it "TK Online Shop Webhook"
 * 2. Project Settings ⚙️ → Script Properties → Add:
 *      BOT_TOKEN       = your Telegram bot token from @BotFather
 *      SPREADSHEET_ID  = your Google Sheet ID (from the sheet URL)
 *      ADMIN_SETUP_KEY = any long random string you make up (protects the
 *                        seller-setup endpoint below — this URL is public,
 *                        so without a key anyone who finds it could register
 *                        themselves as the seller and steal your order
 *                        notifications)
 * 3. Paste this entire file (replace all default code)
 * 4. Deploy → New Deployment → Web App
 *    Execute as: Me  |  Who has access: Anyone
 * 5. Copy the Web App URL → paste into index.html as WEBHOOK_URL
 * 6. Find your Telegram Chat ID:
 *    a. Send any message to your bot
 *    b. Open: https://api.telegram.org/bot{YOUR_TOKEN}/getUpdates
 *    c. Find "chat": { "id": 123456789 }
 * 7. Register yourself as seller:
 *    [Web App URL]?setup=seller&chat_id=YOUR_CHAT_ID&key=YOUR_ADMIN_SETUP_KEY
 *
 * ── GOOGLE SHEET STRUCTURE ───────────────────────────────────────────────────
 *
 * Sheet 1 — "Products"  (headers in row 1, one product per row)
 * ┌──────────┬──────┬──────────┬──────────┬───────┬───────────────┬───────┐
 * │ id       │ name │ audience │ category │ price │ originalPrice │ label │
 * │ featured │creat-│description│ images  │colors │ sizes         │ stock │
 * │          │edAt  │          │          │       │               │       │
 * └──────────┴──────┴──────────┴──────────┴───────┴───────────────┴───────┘
 *
 *   images  → pipe-separated full URLs:
 *             https://example.com/img1.jpg|https://example.com/img2.jpg
 *
 *   colors  → pipe-separated "Name:#hex" pairs:
 *             White:#ffffff|Black:#111111|Navy:#17264a
 *
 *   sizes   → pipe-separated size values:
 *             S|M|L|XL|XXL    or    XS|S|M|L|XL    or   110|120|130
 *
 *   featured   → TRUE or FALSE
 *   originalPrice → leave empty if the product is not on sale
 *   label      → Sale / New / Popular / Best Seller / Limited Offer (or empty)
 *   audience   → Men / Women / Kids (used for the top navigation tabs)
 *   stock      → number; 0 shows "Out of Stock" and disables Add to Cart
 *
 * Sheet 2 — "Config"  (optional — store settings, column A = key, column B = value)
 *   name                | TK Online Shop
 *   currency            | USD
 *   currencySymbol      | $
 *   telegramUsername    | your_telegram_username
 *   deliveryFee         | 1.5   (charged only when the order has 1 item;
 *                                2+ items ship free)
 *
 * Sheets "Orders" and "Customers" are created automatically on first order.
 */

const BOT_TOKEN        = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN");
const SPREADSHEET_ID   = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
const ADMIN_SETUP_KEY  = PropertiesService.getScriptProperties().getProperty("ADMIN_SETUP_KEY");
const SELLER_CHAT_KEY  = "SELLER_CHAT_ID";

// ─────────────────────────────────────────────────────────────────────────────
// HTTP ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────────────

const SHOP_CACHE_KEY = "shop_data_v1";
const SHOP_CACHE_TTL = 120; // seconds — how long a cached response is served before re-reading the sheet

function doGet(e) {
  try {
    if (e.parameter.setup === "seller") return handleSellerSetup(e);
    if (!SPREADSHEET_ID) return jsonError("SPREADSHEET_ID is not configured in Script Properties.");

    // Serve from cache when possible — reading the whole sheet on every
    // request is the main source of load latency, so this makes repeat
    // requests within SHOP_CACHE_TTL seconds near-instant.
    var cache  = CacheService.getScriptCache();
    var cached = e.parameter.fresh ? null : cache.get(SHOP_CACHE_KEY);

    if (cached) {
      return ContentService
        .createTextOutput(cached)
        .setMimeType(ContentService.MimeType.JSON);
    }

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    var payload = JSON.stringify({
      store:    getConfig(ss),
      products: getProducts(ss)
    });

    try {
      cache.put(SHOP_CACHE_KEY, payload, SHOP_CACHE_TTL);
    } catch (cacheErr) {
      // Payload too large for the cache (>100KB) — fine, just skip caching.
    }

    return ContentService
      .createTextOutput(payload)
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return jsonError(err.message);
  }
}

const ORDER_RATE_LIMIT_KEY    = "order_rate_limit";
const ORDER_RATE_LIMIT_MAX    = 20; // max orders accepted in the rolling window below
const ORDER_RATE_LIMIT_WINDOW = 60; // seconds

function doPost(e) {
  try {
    if (!SPREADSHEET_ID) return jsonError("SPREADSHEET_ID is not configured in Script Properties.");

    const order = JSON.parse(e.postData.contents);

    if (!isValidOrder(order)) {
      return jsonError("Invalid order payload.");
    }

    if (isOrderRateLimited()) {
      return jsonError("Too many orders right now — please try again in a minute.");
    }

    const ss      = SpreadsheetApp.openById(SPREADSHEET_ID);
    const orderId = "ORD-" + Date.now();

    saveOrder(ss, orderId, order);
    upsertCustomer(ss, order);
    notifySeller(orderId, order);
    notifyBuyer(orderId, order);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, orderId: orderId }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return jsonError(err.message);
  }
}

function isValidOrder(order) {
  return !!order &&
    typeof order.itemsSummary === "string" && order.itemsSummary.trim().length > 0 &&
    Number(order.total) > 0;
}

// Soft, best-effort throttle against spam/flooding — the endpoint has to
// stay public for the website/Mini App to call it, so this can't be a hard
// security boundary, but it caps how much notification/sheet spam a script
// or bot hitting the URL directly can generate. CacheService increments
// aren't perfectly atomic under concurrent requests, which is fine here.
function isOrderRateLimited() {
  var cache   = CacheService.getScriptCache();
  var current = Number(cache.get(ORDER_RATE_LIMIT_KEY)) || 0;

  if (current >= ORDER_RATE_LIMIT_MAX) return true;

  cache.put(ORDER_RATE_LIMIT_KEY, String(current + 1), ORDER_RATE_LIMIT_WINDOW);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// SELLER SETUP
// ─────────────────────────────────────────────────────────────────────────────

function handleSellerSetup(e) {
  if (!ADMIN_SETUP_KEY) {
    return ContentService.createTextOutput(
      "❌ ADMIN_SETUP_KEY is not configured.\n\n" +
      "Add a secret ADMIN_SETUP_KEY value in Project Settings ⚙️ → Script Properties " +
      "(pick any long random string) before this endpoint can be used — this stops " +
      "strangers who find your Web App URL from registering themselves as the seller."
    ).setMimeType(ContentService.MimeType.TEXT);
  }

  if (e.parameter.key !== ADMIN_SETUP_KEY) {
    return ContentService.createTextOutput(
      "❌ Missing or incorrect key."
    ).setMimeType(ContentService.MimeType.TEXT);
  }

  var chatId = e.parameter.chat_id;

  if (!chatId) {
    return ContentService.createTextOutput(
      "❌ Missing chat_id parameter.\n\n" +
      "Steps:\n" +
      "1. Send any message to your Telegram bot.\n" +
      "2. Open in browser: https://api.telegram.org/bot" + BOT_TOKEN + "/getUpdates\n" +
      "3. Find your id inside the chat object.\n" +
      "4. Open: [this URL]?setup=seller&chat_id=YOUR_CHAT_ID&key=YOUR_ADMIN_SETUP_KEY"
    ).setMimeType(ContentService.MimeType.TEXT);
  }

  PropertiesService.getScriptProperties().setProperty(SELLER_CHAT_KEY, chatId);

  return ContentService.createTextOutput(
    "✅ Seller registered!\n" +
    "Chat ID: " + chatId + "\n\n" +
    "You will now receive a Telegram notification for every new order."
  ).setMimeType(ContentService.MimeType.TEXT);
}

// ─────────────────────────────────────────────────────────────────────────────
// SHEET READERS
// ─────────────────────────────────────────────────────────────────────────────

function getConfig(ss) {
  var defaults = {
    name:                "TK Online Shop",
    currency:            "USD",
    currencySymbol:      "$",
    telegramUsername:    "",
    deliveryFee:         1.5
  };

  var sheet = ss.getSheetByName("Config");
  if (!sheet) return defaults;

  var config = Object.assign({}, defaults);

  sheet.getDataRange().getValues().forEach(function(row) {
    if (row[0]) config[String(row[0]).trim()] = row[1];
  });

  config.deliveryFee = Number(config.deliveryFee) || 0;

  return config;
}

function getProducts(ss) {
  var sheet = ss.getSheetByName("Products");
  if (!sheet || sheet.getLastRow() < 2) return [];

  var data    = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h).trim(); });

  return data.slice(1)
    .filter(function(row) { return row[0]; })
    .map(function(row) {
      var p = {};
      headers.forEach(function(h, i) { p[h] = row[i]; });

      // Parse pipe-separated fields
      p.images = parsePipe(p.images);
      p.sizes  = parsePipe(p.sizes);
      p.colors = parsePipe(p.colors).map(function(c) {
        var idx = c.lastIndexOf(":");
        return idx > 0
          ? { name: c.slice(0, idx).trim(), value: c.slice(idx + 1).trim() }
          : { name: c.trim(), value: "#cccccc" };
      });

      // Normalize types
      p.price         = Number(p.price) || 0;
      p.originalPrice = (p.originalPrice !== "" && p.originalPrice != null && p.originalPrice !== false)
                        ? (Number(p.originalPrice) || null)
                        : null;
      p.stock    = Number(p.stock) || 0;
      p.featured = (p.featured === true || String(p.featured).toUpperCase() === "TRUE");
      p.createdAt = (p.createdAt instanceof Date)
                    ? p.createdAt.toISOString().slice(0, 10)
                    : String(p.createdAt || "");

      return p;
    });
}

function parsePipe(value) {
  if (value === null || value === undefined || value === false || value === "") return [];
  return String(value).split("|").map(function(s) { return s.trim(); }).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME MIGRATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run this once from the Apps Script editor (select "migrateOrdersHeader" in
 * the function dropdown, then click Run) if your Orders sheet is missing the
 * "Contact Phone" / "Order Source" columns. It appends whichever of those two
 * are missing to the end of the header row — it never repositions or rewrites
 * existing columns, so your current data and column order are untouched.
 * saveOrder() does this automatically on the next order too, so running this
 * manually is optional — it just makes the columns appear immediately instead
 * of waiting for the next order. Safe to run more than once.
 */
function migrateOrdersHeader() {
  if (!SPREADSHEET_ID) {
    Logger.log("SPREADSHEET_ID is not configured in Script Properties.");
    return;
  }

  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName("Orders");

  if (!sheet || sheet.getLastRow() < 1) {
    Logger.log("No Orders sheet found — nothing to migrate, it will be created correctly on the next order.");
    return;
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var missing = ["Contact Phone", "Order Source"].filter(function(h) {
    return headers.indexOf(h) === -1;
  });

  if (missing.length === 0) {
    Logger.log("Already migrated — nothing to do.");
    return;
  }

  sheet.getRange(1, headers.length + 1, 1, missing.length)
    .setValues([missing])
    .setFontWeight("bold");

  Logger.log("Added missing column(s): " + missing.join(", "));
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER STORAGE
// ─────────────────────────────────────────────────────────────────────────────

// Base columns for a brand-new Orders sheet. Existing sheets keep whatever
// column order they already have — saveOrder() below writes by header name,
// not position, and appends any of these columns that are missing.
var ORDER_COLUMNS = [
  "Order ID", "Date & Time", "Buyer Name", "Username", "Telegram ID",
  "Contact Phone", "Order Source", "Items",
  "Subtotal ($)", "Delivery ($)", "Total ($)", "Status"
];

function saveOrder(ss, orderId, order) {
  var sheet = ss.getSheetByName("Orders");

  if (!sheet) {
    sheet = ss.insertSheet("Orders");
    sheet.getRange(1, 1, 1, ORDER_COLUMNS.length)
      .setValues([ORDER_COLUMNS])
      .setFontWeight("bold");
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  // Self-heal: add any of our required columns the sheet doesn't have yet
  // (e.g. an older sheet that predates "Contact Phone" / "Order Source").
  var missing = ORDER_COLUMNS.filter(function(h) { return headers.indexOf(h) === -1; });

  if (missing.length > 0) {
    sheet.getRange(1, headers.length + 1, 1, missing.length)
      .setValues([missing])
      .setFontWeight("bold");
    headers = headers.concat(missing);
  }

  var buyerName = order.buyerName ||
    [order.firstName, order.lastName].filter(Boolean).join(" ") || "";

  var valuesByHeader = {
    "Order ID":      orderId,
    "Date & Time":   new Date(),
    "Buyer Name":    buyerName,
    "Username":      order.username ? "@" + order.username : "",
    "Telegram ID":   order.telegramId || "",
    // A leading "'" forces Sheets to store this as plain text instead of
    // parsing it as a formula — appendRow() follows the same auto-parsing
    // rules as typing into a cell, and a leading "+" (like in "+855 ...")
    // is otherwise read as the start of a formula, producing #ERROR!.
    "Contact Phone": order.contactPhone ? "'" + order.contactPhone : "",
    "Order Source":  order.telegramId ? "Telegram Mini App" : "Website",
    "Items":         order.itemsSummary || "",
    "Subtotal ($)":  Number(order.subtotal) || 0,
    "Delivery ($)":  Number(order.delivery) || 0,
    "Total ($)":     Number(order.total)    || 0,
    "Status":        "New"
  };

  var row = headers.map(function(h) {
    return Object.prototype.hasOwnProperty.call(valuesByHeader, h) ? valuesByHeader[h] : "";
  });

  sheet.appendRow(row);
}

function upsertCustomer(ss, order) {
  if (!order.telegramId) return;

  var sheet = ss.getSheetByName("Customers");

  if (!sheet) {
    sheet = ss.insertSheet("Customers");
    sheet.getRange(1, 1, 1, 9)
      .setValues([[
        "Chat ID", "First Name", "Last Name", "Username",
        "Language", "Premium",
        "First Order", "Last Order", "Total Orders", "Total Spent ($)"
      ]])
      .setFontWeight("bold");
  }

  var data    = sheet.getDataRange().getValues();
  var chatIds = data.slice(1).map(function(r) { return String(r[0]); });
  var idx     = chatIds.indexOf(String(order.telegramId));

  if (idx === -1) {
    sheet.appendRow([
      order.telegramId,
      order.firstName   || order.buyerName || "",
      order.lastName    || "",
      order.username    ? "@" + order.username : "",
      order.languageCode || "",
      order.isPremium   ? "Yes" : "No",
      new Date(), new Date(), 1, Number(order.total) || 0
    ]);
  } else {
    var r = idx + 2;
    // Update name fields in case they changed
    sheet.getRange(r, 2).setValue(order.firstName || order.buyerName || "");
    sheet.getRange(r, 3).setValue(order.lastName  || "");
    sheet.getRange(r, 4).setValue(order.username  ? "@" + order.username : "");
    sheet.getRange(r, 8).setValue(new Date());
    sheet.getRange(r, 9).setValue((Number(data[idx + 1][8]) || 0) + 1);
    sheet.getRange(r, 10).setValue((Number(data[idx + 1][9]) || 0) + (Number(order.total) || 0));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

function notifySeller(orderId, order) {
  var chatId = PropertiesService.getScriptProperties().getProperty(SELLER_CHAT_KEY);
  if (!chatId || !BOT_TOKEN) return;

  var fullName  = [order.firstName || order.buyerName, order.lastName].filter(Boolean).join(" ") || "Guest";
  var isMiniApp = !!order.telegramId;

  // Mini App buyers get a tg://user?id= deep link (works even without a
  // username). Website buyers only have a username to go on, which is
  // already a tappable link in usernameLine below, so no separate link here.
  var contactLink = isMiniApp
    ? '<a href="tg://user?id=' + order.telegramId + '">💬 Tap to message buyer</a>'
    : "";

  var usernameLine = order.username
    ? "📎 <a href=\"https://t.me/" + encodeURIComponent(order.username) + "\">@" + esc(order.username) + "</a>\n"
    : "";

  var msg =
    "🛍️ <b>NEW ORDER — " + orderId + "</b>\n" +
    (isMiniApp ? "🤖 Placed via Telegram Mini App\n" : "🌐 Placed via Website\n") +
    "\n" +

    "━━━━ CUSTOMER ━━━━\n" +
    "👤 <b>" + esc(fullName) + "</b>" +
    (order.isPremium ? " ⭐" : "") + "\n" +
    usernameLine +
    (order.contactPhone ? "📱 " + esc(order.contactPhone) + "\n" : "") +
    (order.telegramId   ? "🆔 " + esc(String(order.telegramId)) + "\n" : "") +
    (order.languageCode ? "🌐 " + esc(order.languageCode.toUpperCase()) + "\n" : "") +
    (contactLink ? contactLink + "\n" : "") +
    (!isMiniApp && !order.username && !order.contactPhone
      ? "⚠️ No contact info provided\n"
      : "") +

    "\n━━━━ ITEMS ━━━━\n" +
    esc(order.itemsSummary || "") + "\n\n" +

    "━━━━ PAYMENT ━━━━\n" +
    "💰 Subtotal : $" + fmt(order.subtotal) + "\n" +
    "🚚 Delivery : " + (Number(order.delivery) === 0 ? "FREE 🎉" : "$" + fmt(order.delivery)) + "\n" +
    "✅ <b>TOTAL: $" + fmt(order.total) + "</b>";

  sendTg(chatId, msg);
}

function notifyBuyer(orderId, order) {
  if (!order.telegramId || !BOT_TOKEN) return;

  var firstName = order.firstName || order.buyerName || "";
  var greeting  = firstName ? "Hi <b>" + esc(firstName) + "</b>! 👋\n\n" : "";

  var msg =
    "✅ <b>Order Received!</b>\n\n" +
    greeting +
    "📦 Order ID: <code>" + orderId + "</code>\n\n" +

    "━━━━ YOUR ORDER ━━━━\n" +
    esc(order.itemsSummary || "") + "\n\n" +

    "💰 Subtotal : $" + fmt(order.subtotal) + "\n" +
    "🚚 Delivery : " + (Number(order.delivery) === 0 ? "FREE 🎉" : "$" + fmt(order.delivery)) + "\n" +
    "✅ <b>Total: $" + fmt(order.total) + "</b>\n\n" +

    "We'll contact you shortly to confirm your order. 🙏\n" +
    "<b>TK Online Shop</b> 🛍️";

  sendTg(String(order.telegramId), msg);
}

function sendTg(chatId, text) {
  if (!BOT_TOKEN) return;

  UrlFetchApp.fetch(
    "https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage",
    {
      method:             "post",
      contentType:        "application/json",
      muteHttpExceptions: true,
      payload: JSON.stringify({
        chat_id:    chatId,
        text:       text,
        parse_mode: "HTML"
      })
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmt(n) {
  return (Number(n) || 0).toFixed(2);
}

function jsonError(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}
