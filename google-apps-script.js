/**
 * TK Online Shop — Google Apps Script Backend  (v1)
 *
 * ── SETUP ────────────────────────────────────────────────────────────────────
 * 1. Go to script.google.com → New Project → rename it "TK Online Shop Webhook"
 * 2. Project Settings ⚙️ → Script Properties → Add:
 *      BOT_TOKEN      = your Telegram bot token from @BotFather
 *      SPREADSHEET_ID = your Google Sheet ID (from the sheet URL)
 * 3. Paste this entire file (replace all default code)
 * 4. Deploy → New Deployment → Web App
 *    Execute as: Me  |  Who has access: Anyone
 * 5. Copy the Web App URL → paste into index.html as WEBHOOK_URL
 * 6. Find your Telegram Chat ID:
 *    a. Send any message to your bot
 *    b. Open: https://api.telegram.org/bot{YOUR_TOKEN}/getUpdates
 *    c. Find "chat": { "id": 123456789 }
 * 7. Register yourself as seller:
 *    [Web App URL]?setup=seller&chat_id=YOUR_CHAT_ID
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
 *   deliveryFee         | 2
 *   freeDeliveryMinimum | 50
 *
 * Sheets "Orders" and "Customers" are created automatically on first order.
 */

const BOT_TOKEN       = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN");
const SPREADSHEET_ID  = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
const SELLER_CHAT_KEY = "SELLER_CHAT_ID";

// ─────────────────────────────────────────────────────────────────────────────
// HTTP ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────────────

function doGet(e) {
  try {
    if (e.parameter.setup === "seller") return handleSellerSetup(e);
    if (!SPREADSHEET_ID) return jsonError("SPREADSHEET_ID is not configured in Script Properties.");

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    return ContentService
      .createTextOutput(JSON.stringify({
        store:    getConfig(ss),
        products: getProducts(ss)
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return jsonError(err.message);
  }
}

function doPost(e) {
  try {
    if (!SPREADSHEET_ID) return jsonError("SPREADSHEET_ID is not configured in Script Properties.");

    const order   = JSON.parse(e.postData.contents);
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

// ─────────────────────────────────────────────────────────────────────────────
// SELLER SETUP
// ─────────────────────────────────────────────────────────────────────────────

function handleSellerSetup(e) {
  var chatId = e.parameter.chat_id;

  if (!chatId) {
    return ContentService.createTextOutput(
      "❌ Missing chat_id parameter.\n\n" +
      "Steps:\n" +
      "1. Send any message to your Telegram bot.\n" +
      "2. Open in browser: https://api.telegram.org/bot" + BOT_TOKEN + "/getUpdates\n" +
      "3. Find your id inside the chat object.\n" +
      "4. Open: [this URL]?setup=seller&chat_id=YOUR_CHAT_ID"
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
    deliveryFee:         2,
    freeDeliveryMinimum: 50
  };

  var sheet = ss.getSheetByName("Config");
  if (!sheet) return defaults;

  var config = Object.assign({}, defaults);

  sheet.getDataRange().getValues().forEach(function(row) {
    if (row[0]) config[String(row[0]).trim()] = row[1];
  });

  config.deliveryFee         = Number(config.deliveryFee)         || 0;
  config.freeDeliveryMinimum = Number(config.freeDeliveryMinimum) || 0;

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
// ORDER STORAGE
// ─────────────────────────────────────────────────────────────────────────────

function saveOrder(ss, orderId, order) {
  var sheet = ss.getSheetByName("Orders");

  if (!sheet) {
    sheet = ss.insertSheet("Orders");
    sheet.getRange(1, 1, 1, 10)
      .setValues([["Order ID", "Date & Time", "Buyer Name", "Username", "Telegram ID",
                   "Items", "Subtotal ($)", "Delivery ($)", "Total ($)", "Status"]])
      .setFontWeight("bold");
  }

  sheet.appendRow([
    orderId,
    new Date(),
    order.buyerName   || "",
    order.username    || "",
    order.telegramId  || "",
    order.itemsSummary || "",
    Number(order.subtotal) || 0,
    Number(order.delivery) || 0,
    Number(order.total)    || 0,
    "New"
  ]);
}

function upsertCustomer(ss, order) {
  if (!order.telegramId) return;

  var sheet = ss.getSheetByName("Customers");

  if (!sheet) {
    sheet = ss.insertSheet("Customers");
    sheet.getRange(1, 1, 1, 7)
      .setValues([["Chat ID", "Buyer Name", "Username",
                   "First Order", "Last Order", "Total Orders", "Total Spent ($)"]])
      .setFontWeight("bold");
  }

  var data    = sheet.getDataRange().getValues();
  var chatIds = data.slice(1).map(function(r) { return String(r[0]); });
  var idx     = chatIds.indexOf(String(order.telegramId));

  if (idx === -1) {
    sheet.appendRow([
      order.telegramId,
      order.buyerName || "",
      order.username  || "",
      new Date(), new Date(), 1, Number(order.total) || 0
    ]);
  } else {
    var r = idx + 2;
    sheet.getRange(r, 5).setValue(new Date());
    sheet.getRange(r, 6).setValue((Number(data[idx + 1][5]) || 0) + 1);
    sheet.getRange(r, 7).setValue((Number(data[idx + 1][6]) || 0) + (Number(order.total) || 0));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

function notifySeller(orderId, order) {
  var chatId = PropertiesService.getScriptProperties().getProperty(SELLER_CHAT_KEY);
  if (!chatId || !BOT_TOKEN) return;

  var msg =
    "🛍️ <b>NEW ORDER — " + orderId + "</b>\n\n" +
    "👤 " + esc(order.buyerName || "Guest") +
    (order.username  ? "  (@" + esc(order.username) + ")\n" : "\n") +
    (order.telegramId ? "🆔 " + esc(String(order.telegramId)) + "\n" : "") +
    "\n━━━━ ITEMS ━━━━\n" +
    esc(order.itemsSummary || "") + "\n\n" +
    "💰 Subtotal : $" + fmt(order.subtotal) + "\n" +
    "🚚 Delivery : " + (Number(order.delivery) === 0 ? "FREE 🎉" : "$" + fmt(order.delivery)) + "\n" +
    "✅ <b>TOTAL: $" + fmt(order.total) + "</b>";

  sendTg(chatId, msg);
}

function notifyBuyer(orderId, order) {
  if (!order.telegramId || !BOT_TOKEN) return;

  var msg =
    "✅ <b>Order Received!</b>\n\n" +
    "📦 Order ID: <code>" + orderId + "</code>\n\n" +
    esc(order.itemsSummary || "") + "\n\n" +
    "💰 Total: <b>$" + fmt(order.total) + "</b>\n\n" +
    "We'll contact you on Telegram to confirm your order.\n" +
    "Thank you for shopping at TK Online Shop! 🛍️";

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
