// Перевірка POST /api/lead проти мока Telegram API.
// Запуск: npm test. Піднімає мок на вільному порту, `wrangler pages dev` з мок-змінними і ганяє сценарії.
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";

const BOT_TOKEN = "123456:TEST-TOKEN";
const OWNER_CHAT_ID = "424242";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ——— мок Telegram ———
const tgCalls = [];
let tgFail = false;
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    tgCalls.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
    res.setHeader("Content-Type", "application/json");
    if (tgFail) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, description: "mock failure" }));
    }
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockPort = mock.address().port;
const sitePort = await freePort();
const site = `http://127.0.0.1:${sitePort}`;

const wrangler = spawn(
  "npx",
  [
    "wrangler", "pages", "dev", "public",
    "--port", String(sitePort), "--ip", "127.0.0.1",
    "--binding", `BOT_TOKEN=${BOT_TOKEN}`,
    "--binding", `OWNER_CHAT_ID=${OWNER_CHAT_ID}`,
    "--binding", `TELEGRAM_API_BASE=http://127.0.0.1:${mockPort}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let wranglerLog = "";
wrangler.stdout.on("data", (c) => (wranglerLog += c));
wrangler.stderr.on("data", (c) => (wranglerLog += c));

async function stop() {
  wrangler.kill("SIGTERM");
  mock.close();
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${site}/api/lead`);
      if (r.status === 405) return;
    } catch {
      /* ще не піднявся */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler pages dev не піднявся:\n" + wranglerLog);
}

const goodBody = (extra = {}) => ({
  name: "Іван Петренко",
  phone: "+380 67 123 45 67",
  comment: "Завтра після 18:00",
  website: "",
  fill_ms: 12000,
  ...extra,
});

let ipCounter = 0;
const nextIp = () => `203.0.113.${++ipCounter}`;

function postJson(body, headers = {}) {
  return fetch(`${site}/api/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp(), ...headers },
    body: JSON.stringify(body),
  });
}

function postForm(fields, headers = {}) {
  return fetch(`${site}/api/lead`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": nextIp(), ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

let passed = 0;
const results = [];
async function check(title, fn) {
  tgCalls.length = 0;
  tgFail = false;
  try {
    await fn();
    passed++;
    results.push(`  ✓ ${title}`);
  } catch (err) {
    results.push(`  ✗ ${title}\n      ${String(err.message).split("\n").join("\n      ")}`);
  }
}

try {
  await waitReady();

  await check("валідна заявка → 200 {ok:true} і рівно один sendMessage власнику з екранованим текстом", async () => {
    const res = await postJson(goodBody({ name: "Іван <b>&", comment: "<script>alert(1)</script> & «привіт»" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(tgCalls.length, 1);
    const call = tgCalls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url, `/bot${BOT_TOKEN}/sendMessage`);
    assert.equal(call.body.chat_id, OWNER_CHAT_ID);
    assert.equal(call.body.parse_mode, "HTML");
    const text = call.body.text;
    assert.ok(text.includes("Іван &lt;b&gt;&amp;"), "імʼя екрановане: " + text);
    assert.ok(text.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; «привіт»"), "коментар екранований: " + text);
    assert.ok(!text.includes("<script>"), "сирого <script> немає");
    assert.ok(text.includes("+380671234567"), "телефон нормалізований: " + text);
    // єдині «живі» теги — наш власний <b> у заголовку
    assert.deepEqual(text.match(/<[^>]*>/g), ["<b>", "</b>"]);
  });

  await check("нормалізація номера: 067 123 45 67 → +380671234567", async () => {
    const res = await postJson(goodBody({ phone: "(067) 123-45-67" }));
    assert.equal(res.status, 200);
    assert.ok(tgCalls[0].body.text.includes("+380671234567"));
  });

  await check("некоректний номер → 400 з fields.phone, без звернення до Telegram", async () => {
    for (const phone of ["12345", "+1 202 555 0100", "abc", "0221234567", ""]) {
      const res = await postJson(goodBody({ phone }));
      assert.equal(res.status, 400, `phone=${JSON.stringify(phone)}`);
      const j = await res.json();
      assert.equal(j.ok, false);
      assert.equal(j.error, "validation");
      assert.ok(j.fields.phone);
    }
    assert.equal(tgCalls.length, 0);
  });

  await check("закоротке імʼя / задовгий коментар → 400, без Telegram", async () => {
    let res = await postJson(goodBody({ name: "І" }));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).fields.name);
    res = await postJson(goodBody({ comment: "x".repeat(301) }));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).fields.comment);
    assert.equal(tgCalls.length, 0);
  });

  await check("honeypot заповнений → тихий 200 {ok:true}, без Telegram", async () => {
    const res = await postJson(goodBody({ website: "http://spam.example" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(tgCalls.length, 0);
  });

  await check("надто швидка відправка (fill_ms < 3000 або відсутнє) → 400 too_fast, без Telegram", async () => {
    let res = await postJson(goodBody({ fill_ms: 800 }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "too_fast");
    const body = goodBody();
    delete body.fill_ms;
    res = await postJson(body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "too_fast");
    res = await postForm({ name: "Іван", phone: "0671234567", fill_ms: "500" });
    assert.equal(res.status, 400);
    assert.equal(tgCalls.length, 0);
  });

  await check("звичайний POST форми без JS → 303 на /dyakuyemo/ і один sendMessage; сторінка подяки відкривається", async () => {
    const res = await postForm({ name: "Марія", phone: "0671234567", comment: "Субота", website: "", fill_ms: "" });
    assert.equal(res.status, 303);
    assert.equal(new URL(res.headers.get("Location")).pathname, "/dyakuyemo/");
    assert.equal(tgCalls.length, 1);
    assert.ok(tgCalls[0].body.text.includes("Марія"));
    const page = await fetch(`${site}/dyakuyemo/`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("Дякуємо"));
  });

  await check("POST форми без JS з поганим номером → 400 HTML-сторінка з поясненням, без Telegram", async () => {
    const res = await postForm({ name: "Марія", phone: "111", website: "" });
    assert.equal(res.status, 400);
    assert.ok((res.headers.get("Content-Type") || "").startsWith("text/html"));
    assert.ok((await res.text()).includes("український номер"));
    assert.equal(tgCalls.length, 0);
  });

  await check("honeypot у формі без JS → 303 (тихо), без Telegram", async () => {
    const res = await postForm({ name: "Бот", phone: "0671234567", website: "x" });
    assert.equal(res.status, 303);
    assert.equal(tgCalls.length, 0);
  });

  await check("ліміт частоти: 4-та валідна заявка з тієї ж IP за вікно → 429 + Retry-After, Telegram викликано 3 рази", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < 3; i++) {
      const ok = await postJson(goodBody(), { "CF-Connecting-IP": ip });
      assert.equal(ok.status, 200, `запит ${i + 1}`);
    }
    const limited = await postJson(goodBody(), { "CF-Connecting-IP": ip });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, "rate_limited");
    assert.ok(Number(limited.headers.get("Retry-After")) > 0);
    assert.equal(tgCalls.length, 3);
    const other = await postJson(goodBody(), { "CF-Connecting-IP": "198.51.100.78" });
    assert.equal(other.status, 200, "інша IP не обмежена");
  });

  await check("збій Telegram → 502 з дружнім повідомленням", async () => {
    tgFail = true;
    const res = await postJson(goodBody());
    assert.equal(res.status, 502);
    const j = await res.json();
    assert.equal(j.error, "telegram_failed");
    assert.ok(!JSON.stringify(j).includes(BOT_TOKEN), "токен не витікає у відповідь");
    assert.equal(tgCalls.length, 1);
  });

  await check("чужий Origin → 403; завеликий запит → 413; GET → 405; не JSON → 400; чужий Content-Type → 415", async () => {
    let res = await postJson(goodBody(), { Origin: "https://evil.example" });
    assert.equal(res.status, 403);
    res = await postJson(goodBody({ comment: "x".repeat(5000) }));
    assert.equal(res.status, 413);
    res = await fetch(`${site}/api/lead`);
    assert.equal(res.status, 405);
    res = await fetch(`${site}/api/lead`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
    assert.equal(res.status, 400);
    res = await fetch(`${site}/api/lead`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hi" });
    assert.equal(res.status, 415);
    res = await postJson(goodBody(), { Origin: site });
    assert.equal(res.status, 200, "свій Origin дозволений");
    assert.equal(tgCalls.length, 1);
  });
} catch (err) {
  results.push("  ✗ збій harness: " + err.message);
} finally {
  console.log("Перевірка /api/lead (мок Telegram на :" + mockPort + ", сайт на :" + sitePort + ")");
  console.log(results.join("\n"));
  console.log(`\nПройдено: ${passed} із ${results.length}`);
  await stop();
  process.exit(passed === results.length ? 0 : 1);
}
