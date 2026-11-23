// Невеликий прогресивний шар: статус «відчинено», липка кнопка, відправка форми без перезавантаження.
// Без JS сторінка повністю працює: форма робить звичайний POST на /api/lead з редіректом на сторінку подяки.
(() => {
  "use strict";

  const pageStart = performance.now();

  // ——— «Зараз відчинено» за київським часом (розклад — як у боті: Пн вихідний, решта 10:00–20:00) ———
  const OPEN = { from: 10 * 60, to: 20 * 60 };
  const SCHEDULE = [OPEN, null, OPEN, OPEN, OPEN, OPEN, OPEN]; // індекс — день тижня, 0 = неділя
  const WHEN = ["в неділю", "в понеділок", "у вівторок", "в середу", "в четвер", "в пʼятницю", "в суботу"];
  const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function kyivNow() {
    const opts = { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "Europe/Kyiv" });
    } catch {
      fmt = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "Europe/Kiev" });
    }
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    return { day: DAY_INDEX[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  function openStatus() {
    const { day, minutes } = kyivNow();
    const today = SCHEDULE[day];
    if (today && minutes >= today.from && minutes < today.to) {
      return { state: "open", text: "Зараз відчинено · до 20:00" };
    }
    if (today && minutes < today.from) return { state: "closed", text: "Зараз зачинено · сьогодні з 10:00" };
    for (let i = 1; i <= 7; i++) {
      const next = (day + i) % 7;
      if (SCHEDULE[next]) {
        const when = i === 1 ? "завтра" : WHEN[next];
        return { state: "closed", text: `Зараз зачинено · ${when} з 10:00` };
      }
    }
    return null;
  }

  // Intl з часовим поясом — відносно дорога ініціалізація: робимо її, коли браузер вільний, а не під час першого малювання.
  function showOpenStatus() {
    try {
      const status = openStatus();
      if (!status) return;
      for (const id of ["open-now", "open-now-2"]) {
        const pill = document.getElementById(id);
        const text = document.getElementById(id === "open-now" ? "open-now-text" : "open-now-text-2");
        if (!pill || !text) continue;
        pill.dataset.state = status.state;
        text.textContent = status.text;
      }
    } catch {
      /* лишається статичний текст з розмітки */
    }
  }
  if ("requestIdleCallback" in window) requestIdleCallback(showOpenStatus, { timeout: 2000 });
  else setTimeout(showOpenStatus, 300);

  // ——— липка кнопка: з'являється, коли основна кнопка hero пішла за верх екрана ———
  const sticky = document.getElementById("sticky-cta");
  const heroCta = document.getElementById("hero-cta");
  const form = document.getElementById("lead-form");
  if (sticky && heroCta && "IntersectionObserver" in window) {
    let pastHero = false;
    let typing = false;
    const update = () => sticky.classList.toggle("is-visible", pastHero && !typing);
    new IntersectionObserver(
      ([entry]) => {
        pastHero = !entry.isIntersecting && entry.boundingClientRect.top < 0;
        update();
      },
      { threshold: 0 },
    ).observe(heroCta);
    // на час введення в форму ховаємо панель — вона не повинна перекривати поля над клавіатурою
    if (form) {
      form.addEventListener("focusin", () => ((typing = true), update()));
      form.addEventListener("focusout", () => ((typing = false), update()));
    }
  }

  // ——— форма ———
  if (!form) return;
  form.noValidate = true; // свої повідомлення замість браузерних

  const submitBtn = document.getElementById("submit-btn");
  const statusEl = document.getElementById("form-status");
  const success = document.getElementById("form-success");
  const inputs = {
    name: document.getElementById("f-name"),
    phone: document.getElementById("f-phone"),
    comment: document.getElementById("f-comment"),
  };
  const errors = {
    name: document.getElementById("e-name"),
    phone: document.getElementById("e-phone"),
    comment: document.getElementById("e-comment"),
  };

  const UA_PHONE = /^(?:\+?38)?0[3-9]\d{8}$/;
  const clientRules = {
    name: (v) => (/\p{L}/u.test(v) && v.trim().length >= 2 && v.trim().length <= 40 ? "" : "Вкажіть імʼя: від 2 до 40 символів."),
    phone: (v) => (UA_PHONE.test(v.trim().replace(/[\s\-().]/g, "")) ? "" : "Вкажіть український номер, наприклад +380 67 123 45 67 або 067 123 45 67."),
    comment: (v) => (v.length <= 300 ? "" : "Коментар задовгий: не більше 300 символів."),
  };

  function setFieldError(field, message) {
    const input = inputs[field];
    const box = errors[field];
    if (message) {
      box.textContent = message;
      box.hidden = false;
      input.setAttribute("aria-invalid", "true");
    } else {
      box.textContent = "";
      box.hidden = true;
      input.removeAttribute("aria-invalid");
    }
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind || "";
  }

  for (const field of Object.keys(inputs)) {
    inputs[field].addEventListener("input", () => {
      if (inputs[field].hasAttribute("aria-invalid")) setFieldError(field, clientRules[field](inputs[field].value));
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("");

    let firstInvalid = null;
    for (const field of Object.keys(inputs)) {
      const message = clientRules[field](inputs[field].value);
      setFieldError(field, message);
      if (message && !firstInvalid) firstInvalid = inputs[field];
    }
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    const payload = {
      name: inputs.name.value,
      phone: inputs.phone.value,
      comment: inputs.comment.value,
      website: form.elements.website.value,
      fill_ms: Math.round(performance.now() - pageStart),
    };

    submitBtn.disabled = true;
    submitBtn.textContent = "Надсилаю…";
    submitBtn.setAttribute("aria-busy", "true");
    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* відповідь не JSON (наприклад, збій на боці Cloudflare) */
      }
      if (res.ok && data && data.ok) {
        form.hidden = true;
        success.hidden = false;
        success.focus();
        return;
      }
      if (data && data.fields) {
        let first = null;
        for (const [field, message] of Object.entries(data.fields)) {
          if (!inputs[field]) continue;
          setFieldError(field, message);
          first = first || inputs[field];
        }
        if (first) first.focus();
      }
      setStatus((data && data.message) || "Не вдалося надіслати заявку. Спробуйте ще раз або запишіться через Telegram-бота.", "error");
    } catch {
      setStatus("Немає звʼязку з сервером. Перевірте інтернет і спробуйте ще раз або запишіться через Telegram-бота.", "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Надіслати заявку";
      submitBtn.removeAttribute("aria-busy");
    }
  });
})();
