// POST /api/lead — заявка з форми лендінгу → повідомлення власнику в Telegram.
//
// Змінні середовища: BOT_TOKEN, OWNER_CHAT_ID (секрети), TELEGRAM_API_BASE (необов'язково, для тестів).
// Два режими відповіді:
//   • fetch із JS (Content-Type: application/json) → JSON { ok, error?, message?, fields? };
//   • звичайний POST форми без JS (urlencoded) → 303 на сторінку подяки або HTML-сторінка з помилкою.

const MIN_FILL_MS = 3000; // швидше — це бот, а не людина
const RATE_LIMIT = 3; // заявок з однієї IP…
const RATE_WINDOW_S = 600; // …за 10 хвилин
const MAX_BODY_BYTES = 4096;
const NAME_MAX = 40;
const COMMENT_MAX = 300;
const TELEGRAM_TIMEOUT_MS = 8000;
const DEFAULT_TELEGRAM_BASE = "https://api.telegram.org";
const THANKS_PATH = "/dyakuyemo/";

const MESSAGES = {
  validation: "Перевірте, будь ласка, виділені поля.",
  too_fast: "Ви надіслали форму надто швидко. Зачекайте пару секунд і натисніть ще раз.",
  rate_limited: "Забагато заявок з вашої адреси. Спробуйте за кілька хвилин або запишіться через Telegram-бота.",
  too_large: "Запит завеликий.",
  bad_request: "Не вдалося прочитати форму. Оновіть сторінку й спробуйте ще раз.",
  forbidden: "Запит відхилено.",
  unsupported: "Непідтримуваний формат запиту.",
  method_not_allowed: "Метод не підтримується.",
  not_configured: "Форма тимчасово не працює. Запишіться через Telegram-бота — він відповідає одразу.",
  telegram_failed: "Не вдалося надіслати заявку. Спробуйте ще раз або запишіться через Telegram-бота.",
};

const STATUS = {
  validation: 400,
  too_fast: 400,
  bad_request: 400,
  forbidden: 403,
  method_not_allowed: 405,
  too_large: 413,
  unsupported: 415,
  rate_limited: 429,
  not_configured: 503,
  telegram_failed: 502,
};

// ——— валідація (та сама логіка номера й імені, що в Telegram-боті) ———

/** +380671234567, 380671234567, 0671234567, 067 123 45 67, (067) 123-45-67 → "+380XXXXXXXXX" або null. */
export function normalizeUaPhone(input) {
  const compact = String(input).trim().replace(/[\s\-().]/g, "");
  const m = /^(?:\+?38)?0([3-9]\d{8})$/.exec(compact);
  return m ? `+380${m[1]}` : null;
}

export function normalizeName(input) {
  const name = String(input).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > NAME_MAX) return null;
  if (!/\p{L}/u.test(name)) return null;
  return name;
}

/** Коментар необов'язковий; нові рядки зберігаємо (не більше двох поспіль), решту керуючих символів прибираємо. */
export function normalizeComment(input) {
  const text = String(input)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > COMMENT_MAX ? null : text;
}

export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ——— обмеження частоти: Cache API, без KV ———
// Лічильник живе в кеші дата-центру Cloudflare, де обробляється запит: ліміт «на IP на ЦОД», а не глобальний;
// запис не атомарний (два одночасні запити можуть проскочити); на *.workers.dev Cache API не працює.
// Для демо-форми це прийнятно — це фільтр від випадкового спаму, не захист від цілеспрямованої атаки.
async function hitRateLimit(ip) {
  const cache = caches.default;
  const key = new Request(`https://rate-limit.invalid/lead/${encodeURIComponent(ip)}`);
  const now = Date.now();
  let count = 0;
  let resetAt = now + RATE_WINDOW_S * 1000;
  const hit = await cache.match(key);
  if (hit) {
    try {
      const saved = await hit.json();
      if (Number.isFinite(saved.count) && Number.isFinite(saved.resetAt) && saved.resetAt > now) {
        count = saved.count;
        resetAt = saved.resetAt;
      }
    } catch {
      /* пошкоджений запис — починаємо вікно заново */
    }
  }
  if (count >= RATE_LIMIT) return { limited: true, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
  const ttl = Math.max(1, Math.ceil((resetAt - now) / 1000));
  await cache.put(
    key,
    new Response(JSON.stringify({ count: count + 1, resetAt }), {
      headers: { "Cache-Control": `public, max-age=${ttl}` },
    }),
  );
  return { limited: false };
}

// ——— відповіді ———

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function errorPage(message, status, headers = {}) {
  const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Помилка — Барбершоп «Демо»</title><link rel="stylesheet" href="/css/styles.css"></head><body class="page-plain"><main class="plain"><p class="eyebrow">Заявку не надіслано</p><h1>Щось пішло не так</h1><p>${escapeHtml(message)}</p><p class="plain-actions"><a class="btn btn-primary" href="/#zayavka">Повернутися до форми</a> <a class="btn btn-ghost" href="https://t.me/barber_example1_bot">Записатися в Telegram</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function fail(wantsJson, code, extra = {}, headers = {}) {
  const status = STATUS[code] ?? 400;
  const message = MESSAGES[code];
  if (wantsJson) return json({ ok: false, error: code, message, ...extra }, status, headers);
  const detail = extra.fields ? `${message} ${Object.values(extra.fields).join(" ")}` : message;
  return errorPage(detail, status, headers);
}

function success(wantsJson, request) {
  if (wantsJson) return json({ ok: true });
  return new Response(null, {
    status: 303,
    headers: { Location: new URL(THANKS_PATH, request.url).toString(), "Cache-Control": "no-store" },
  });
}

// ——— Telegram ———

function leadMessage({ name, phone, comment }) {
  const when = new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  const lines = [
    "📩 <b>Нова заявка з сайту</b>",
    "",
    `👤 ${escapeHtml(name)}`,
    `📞 ${escapeHtml(phone)}`,
  ];
  if (comment) lines.push(`💬 ${escapeHtml(comment)}`);
  lines.push("", `🕒 ${when} (Київ)`);
  return lines.join("\n");
}

async function sendToOwner(env, text) {
  const base = (env.TELEGRAM_API_BASE || DEFAULT_TELEGRAM_BASE).replace(/\/+$/, "");
  const res = await fetch(`${base}/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.OWNER_CHAT_ID,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    let description = "";
    try {
      description = (await res.json()).description ?? "";
    } catch {
      /* тіло не JSON */
    }
    throw new Error(`Telegram sendMessage ${res.status} ${description}`.trim());
  }
}

// ——— обробник ———

async function handlePost(context) {
  const { request, env } = context;
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  const wantsJson = contentType.includes("application/json");

  // Форму можна надсилати лише зі своєї сторінки (браузер завжди додає Origin до POST).
  const origin = request.headers.get("Origin");
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === new URL(request.url).host;
    } catch {
      /* некоректний Origin */
    }
    if (!sameOrigin) return fail(wantsJson, "forbidden");
  }

  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) return fail(wantsJson, "too_large");
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return fail(wantsJson, "too_large");

  let data;
  if (wantsJson) {
    try {
      data = JSON.parse(raw);
    } catch {
      return fail(true, "bad_request");
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) return fail(true, "bad_request");
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    data = Object.fromEntries(new URLSearchParams(raw));
  } else {
    return fail(false, "unsupported");
  }
  const str = (key) => (typeof data[key] === "string" ? data[key] : "");

  // Пастка для ботів: людина цього поля не бачить. Вдаємо успіх і нічого не надсилаємо.
  if (str("website").trim() !== "") return success(wantsJson, request);

  // Час заповнення (мс від завантаження сторінки, міряє клієнт). Без JS поля немає — тоді перевірку пропускаємо,
  // у режимі JSON воно обов'язкове.
  const fillRaw = data.fill_ms;
  if (wantsJson || (fillRaw !== undefined && fillRaw !== "")) {
    const fillMs = Number(fillRaw);
    if (!Number.isFinite(fillMs) || fillMs < MIN_FILL_MS) return fail(wantsJson, "too_fast");
  }

  const fields = {};
  const name = normalizeName(str("name"));
  if (name === null) fields.name = `Вкажіть імʼя: від 2 до ${NAME_MAX} символів, хоча б одна літера.`;
  const phone = normalizeUaPhone(str("phone"));
  if (phone === null) fields.phone = "Вкажіть український номер, наприклад +380 67 123 45 67 або 067 123 45 67.";
  const comment = normalizeComment(str("comment"));
  if (comment === null) fields.comment = `Коментар задовгий: не більше ${COMMENT_MAX} символів.`;
  if (Object.keys(fields).length > 0) return fail(wantsJson, "validation", { fields });

  if (!env.BOT_TOKEN || !env.OWNER_CHAT_ID) {
    console.error("lead: BOT_TOKEN або OWNER_CHAT_ID не задані");
    return fail(wantsJson, "not_configured");
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const limit = await hitRateLimit(ip);
  if (limit.limited) return fail(wantsJson, "rate_limited", {}, { "Retry-After": String(limit.retryAfter) });

  try {
    await sendToOwner(env, leadMessage({ name, phone, comment }));
  } catch (err) {
    console.error("lead: не вдалося надіслати в Telegram:", err instanceof Error ? err.message : "помилка");
    return fail(wantsJson, "telegram_failed");
  }
  return success(wantsJson, request);
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed", message: MESSAGES.method_not_allowed }, 405, { Allow: "POST" });
  }
  return handlePost(context);
}
