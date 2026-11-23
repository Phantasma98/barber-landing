# Барбершоп «Демо» — лендінг із заявками в Telegram

> **Демо-проєкт.** Барбершоп, адреса, ціни й фото ілюстративні: реального закладу не існує.
> Це приклад пакета **«сайт + Telegram-бот запису під ключ»**.
>
> - **Сайт:** <https://barber.soniqcloud.com>
> - **Бот запису:** [@barber_example1_bot](https://t.me/barber_example1_bot)
> - **Код бота:** <https://github.com/Phantasma98/barber-booking-bot>

Лендінг пояснює клієнту, чим добре місце, показує прайс і веде на запис у Telegram-боті. Для тих, хто не
хоче месенджер, є форма заявки: вона надходить власнику в чат того самого бота. Послуги, ціни, тривалість,
години роботи й (вигадана) адреса беруться з конфігурації бота (`src/config.ts`), тому сайт і бот не розходяться.

## Що всередині

- Адаптивна сторінка українською, mobile-first: hero з основною кнопкою «Записатися в Telegram», послуги й ціни,
  «Як записатися» (3 кроки), галерея, години та адреса зі статусом «зараз відчинено» (за київським часом),
  форма заявки, FAQ, підвал із позначкою «Демо-проєкт». На мобільному — липка кнопка запису.
- Форма → `POST /api/lead` (Cloudflare Pages Function) → `sendMessage` власнику в Telegram.
  Працює і з JS (без перезавантаження, дружні повідомлення), і без нього (звичайний POST → редірект на `/dyakuyemo/`).
- SEO: `title`/`description`, Open Graph + Twitter-картка, іконки, `manifest`, JSON-LD `BarberShop`
  (позначений як вигаданий), `sitemap.xml`, `robots.txt`.
- Безпека: CSP та інші заголовки в `public/_headers`, без зовнішніх ресурсів (шрифти й фото — свої).

## Стек

Чистий HTML + CSS + ~200 рядків JS без залежностей у браузері. Хостинг — **Cloudflare Pages** (безкоштовно),
форма — **Pages Functions** (`functions/api/lead.js`). Збірки немає: `public/` віддається як є.
Dev-залежності: `wrangler` (локальний сервер і деплой) та `sharp` (лише для підготовки зображень).

```
public/              статика (те, що деплоїться)
  index.html         сторінка
  css/styles.css     стилі
  js/main.js         статус «відчинено», липка кнопка, відправка форми
  img/               фото AVIF/WebP/JPEG у кількох розмірах + og.jpg
  fonts/             Oswald (cyrillic + latin, variable woff2)
  dyakuyemo/         сторінка подяки (редірект після POST без JS)
  _headers           кеш і безпекові заголовки
functions/api/lead.js  обробник форми
scripts/photos.mjs   завантаження й стиснення фото, генерація іконок
scripts/og.html      макет Open Graph-картинки
scripts/test-lead.mjs  автоматична перевірка /api/lead з моком Telegram
```

## Запуск локально

```bash
npm install
cp .dev.vars.example .dev.vars     # впишіть BOT_TOKEN та OWNER_CHAT_ID (файл у .gitignore)
npx wrangler pages dev             # сайт на http://localhost:8788
```

Щоб не слати справжні повідомлення, у `.dev.vars` можна задати `TELEGRAM_API_BASE=http://127.0.0.1:<порт>`
і підняти локальний мок Telegram API. Зміни `.dev.vars` підхоплюються після перезапуску `wrangler`.

### Перевірка форми

```bash
npm test
```

Скрипт сам піднімає мок Telegram і `wrangler pages dev` та перевіряє: валідна заявка → рівно один `sendMessage`
з екранованим текстом на `OWNER_CHAT_ID`; хибний номер → 400 без виклику Telegram; заповнений honeypot → тиха
«успішна» відповідь без виклику Telegram; надто швидка відправка → відмова; POST без JS → 303 на сторінку подяки;
ліміт частоти → 429; збій Telegram → 502; чужий `Origin`, завеликий запит, неправильний метод і формат.

## Як працює форма й захист від спаму

| Захист | Як |
| --- | --- |
| Валідація на сервері | імʼя 2–40 символів, український номер (ті самі правила, що в боті: `+380…`, `380…`, `0…`), коментар ≤ 300, тіло запиту ≤ 4 КБ |
| Екранування | `&`, `<`, `>` у тексті користувача екрануються, повідомлення йде з `parse_mode: HTML` |
| Honeypot | приховане поле `website`; якщо заповнене — відповідаємо «успіх», але нічого не надсилаємо |
| Мінімальний час | JS передає `fill_ms` — скільки мс форма була на сторінці; менше 3 с → відмова. Без JS поля немає, перевірка пропускається |
| Ліміт частоти | не більше 3 заявок / 10 хв з однієї IP; лічильник у **Cache API** Cloudflare |
| Origin | POST приймається лише зі свого домену |

**Обмеження чесно.** Ліміт на Cache API — це фільтр від випадкового спаму, не захист від атаки: лічильник живе в
кеші того дата-центру, що обробив запит (тож ліміт «на IP на ЦОД», не глобальний), запис не атомарний (два
одночасні запити можуть проскочити), а на `*.workers.dev` Cache API не працює (на кастомному домені працює).
Те саме з `fill_ms`: його повідомляє клієнт, тож його може підробити спеціально написаний бот. Якщо форму почнуть
спамити — наступні кроки безкоштовні: [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) на
формі й правило rate limiting у WAF.

## Деплой на Cloudflare Pages

1. Увійдіть: `npx wrangler login`.
2. Створіть Pages-проєкт: `npx wrangler pages project create barber-landing --production-branch main`.
3. Задайте секрети (ті самі токен і chat id, що в боті; бот має вже бути запущений власником хоча б раз,
   інакше Telegram не дозволить писати йому в чат):
   ```bash
   npx wrangler pages secret put BOT_TOKEN --project-name barber-landing
   npx wrangler pages secret put OWNER_CHAT_ID --project-name barber-landing
   ```
4. Деплой: `npm run deploy` (це `wrangler pages deploy public --project-name barber-landing`; папка `functions/`
   підхоплюється автоматично).
5. Власний домен: Cloudflare Dashboard → Workers & Pages → `barber-landing` → Custom domains →
   додати `barber.soniqcloud.com` (зона `soniqcloud.com` має бути в тому ж акаунті Cloudflare — DNS-запис
   створиться сам).

Альтернатива: підключити GitHub-репозиторій у Pages (build command — порожня, output directory — `public`).

## Зображення та іконки

`npm run photos` завантажує оригінали з Unsplash у `.cache/` (у `.gitignore`), нарізає потрібні пропорції й
зберігає `public/img/*-{480,800,1200,…}.{avif,webp,jpg}`; там само з `public/favicon.svg` генеруються
`favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`. Готові файли вже в репозиторії,
повторно запускати не потрібно. Open Graph-картинка `public/img/og.jpg` (1200×630) — скриншот макета
`scripts/og.html`, відкритого в браузері у вікні 1200×630.

## Подяки та ліцензії

Усі фото — з [Unsplash](https://unsplash.com) за [ліцензією Unsplash](https://unsplash.com/license): безкоштовне
використання, зокрема комерційне, без обов'язкової атрибуції (вказуємо з поваги до авторів). Фото завантажені
в репозиторій і віддаються з власного домену.

| Де на сайті | Фото | Автор |
| --- | --- | --- |
| Hero, Open Graph | [Black leather barber chair near brown brick wall](https://unsplash.com/photos/black-leather-barber-chair-near-brown-brick-wall-EW_rqoSdDes) | [Nathon Oski](https://unsplash.com/@onatecan) |
| Галерея | [Barber trimming hair with straight razor](https://unsplash.com/photos/barber-trimming-hair-with-straight-razor-1Pmp9uxK8X8) | [Agustin Fernandez](https://unsplash.com/@agustinfernandez) |
| Галерея | [A man cutting another man's hair with a pair of scissors](https://unsplash.com/photos/a-man-cutting-another-mans-hair-with-a-pair-of-scissors-tgPrIYnW3g4) | [Nate Johnston](https://unsplash.com/@natejohnston) |
| Галерея | [Hair clippers and grooming tools](https://unsplash.com/photos/hair-clippers-and-grooming-tools-MNu0n-3BIKs) | [Andrea Donato](https://unsplash.com/@andreadonato) |
| Галерея | [Man sitting on barber's chair](https://unsplash.com/photos/man-sitting-on-barbers-chair-IvQeAVeJULw) | [Allef Vinicius](https://unsplash.com/@seteph) |
| Галерея | [Black and silver barber chair](https://unsplash.com/photos/black-and-silver-barber-chair-dU6eE_j2My8) | [Joshua Lawrence](https://unsplash.com/@orangetiephotography) |
| Галерея | [Salon interior with lighted pendant lamps](https://unsplash.com/photos/salon-interior-with-lighted-pendant-lamps-2seUdPQNy_I) | [Jason Leung](https://unsplash.com/@ninjason) |

Шрифт [Oswald](https://fonts.google.com/specimen/Oswald) — SIL Open Font License 1.1 (файли лежать у `public/fonts/`,
без підключення до Google Fonts).
