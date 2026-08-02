# smart-backend — Production'ga chiqarish qo'llanmasi

Bu hujjat faqat **smart-backend**ga tegishli amaliy qadamlar: `.env` ni qanday
to'ldirish, sirlarni qanday generatsiya qilish, va deploydan oldin/keyin
nimani tekshirish kerak.

## 1. `.env` faylini tayyorlash

`.env.production.example`ni production serverida `.env` nomiga nusxalang:

```bash
cp .env.production.example .env
```

Keyin quyidagi qiymatlarni **haqiqiy** ma'lumotlar bilan to'ldiring.

### Sirlarni generatsiya qilish

```bash
# JWT_SECRET (64 bayt = 128 hex belgi)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# ENCRYPTION_KEY (32 bayt = 64 hex belgi)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# DB_PASSWORD (kuchli, tasodifiy parol)
node -e "console.log(require('crypto').randomBytes(24).toString('base64'))"
```

Har birini `.env`dagi mos o'zgaruvchiga qo'ying:

| O'zgaruvchi | Qiymat manbai |
|---|---|
| `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER` | Production MySQL server ma'lumotlari |
| `DB_PASSWORD` | Yuqoridagi generatsiya qilingan parol |
| `JWT_SECRET` | Yuqoridagi generatsiya qilingan hex string |
| `ENCRYPTION_KEY` | Yuqoridagi 32 baytli generatsiya qilingan hex string |
| `CORS_ORIGIN` | Frontend production domeni, masalan `https://app.stoyanka.uz` |
| `PUBLIC_BASE_URL` | Serverning tashqi manzili — protokol + host + (agar standart bo'lmasa) port, oxirida `/` BO'LMASIN. Nginx orqasida bo'lsangiz ham HAQIQIY tashqi manzilni yozing (masalan `http://195.158.9.168:84`), Nginx qanday port ochganidan qat'iy nazar — bu qiymat kameraga/Payme/Click'ga ko'rsatiladigan webhook URL'larini generatsiya qilish uchun ishlatiladi va hech qachon so'rov sarlavhalaridan (Host) avtomatik aniqlanmaydi |
| `PAYME_ENABLED`/`CLICK_ENABLED` | Haqiqiy Payme/Click integratsiyasi ulanmaguncha `false` qoldiring |

Printer, kamera va webhook sozlamalari `.env`da EMAS — har bir tashkilot uchun
bazada saqlanadi. Kamera relay credentiallari
`PATCH /api/organizations/:id/camera-relay-settings` orqali sozlanadi.

## 2. Startup xavfsizlik tekshiruvi

`src/config/env.ts` production rejimida (`NODE_ENV=production`) quyidagilarni
avtomatik tekshiradi va MOS KELMASA serverni **ishga tushirishdan oldin**
`process.exit(1)` bilan to'xtatadi:

- `JWT_SECRET` dev qiymatida qolgan yoki 32 belgidan qisqa
- `CORS_ORIGIN` `localhost` ga ishora qilsa yoki umuman belgilanmagan (`*`)
- `DB_PASSWORD` bo'sh, 8 belgidan qisqa, yoki oddiy parollar ro'yxatida
  (`password`, `123456`, `admin` va h.k.)
- `PUBLIC_BASE_URL` belgilanmagan yoki noto'g'ri URL formatida
- `ENCRYPTION_KEY` 32 baytli hex yoki base64 qiymat bo'lmasa

Bu — birov tasodifan dev `.env`ni production serverga ko'chirib qo'ymasligi
uchun so'nggi xavfsizlik to'sig'i. Agar server shu sabab bilan to'xtasa,
konsolda aniq qaysi o'zgaruvchi(lar) muammoli ekani ko'rsatiladi.

## 3. Build va ishga tushirish

```bash
npm ci                  # aniq lock-fayldagi versiyalar bilan o'rnatish
npm run build            # TypeScript -> dist/
npm run migrate           # DB migratsiyalarini ishga tushirish
npm start                 # node dist/server.js
```

Production'da `npm run dev` (ts-node-dev) ISHLATILMASIN — u dev-only,
avtomatik qayta yuklanish uchun mo'ljallangan va production yukiga mos emas.
Har doim `npm run build` + `npm start` (kompilyatsiya qilingan `dist/`)
ishlatilsin.

## 4. Process manager (PM2)

Process crash bo'lganda avtomatik qayta ishga tushishi uchun PM2 ishlatiladi.
Konfiguratsiya loyiha ildizidagi `ecosystem.config.js`da — PM2'ning o'zi esa
loyihaga `dependency` sifatida QO'SHILMAYDI, serverga **global** o'rnatiladi:

```bash
npm install -g pm2
```

Ishga tushirish (loyiha papkasida, `npm run build` qilingandan keyin):

```bash
pm2 start ecosystem.config.js --env production
```

Serverni doim ochiq saqlash uchun (server qayta yuklanganda ham):

```bash
pm2 save        # joriy process ro'yxatini saqlaydi
pm2 startup     # OS bilan birga avtomatik ishga tushish skriptini o'rnatadi
                # (chiqadigan buyruqni ko'rsatilgan holda root sifatida bajaring)
```

### Foydali PM2 buyruqlari

```bash
pm2 list                    # jarayonlar holati
pm2 logs s-backend           # jonli loglar (error_file + out_file birlashtirilgan)
pm2 restart s-backend         # qo'lda qayta ishga tushirish
pm2 stop s-backend            # to'xtatish (avtomatik qayta ko'tarilmaydi)
pm2 delete s-backend          # PM2 ro'yxatidan butunlay olib tashlash
```

`ecosystem.config.js`dagi asosiy sozlamalar:
- `autorestart: true` + `max_restarts: 10` — jarayon qulasa (crash, `kill -9`
  va h.k.) avtomatik qayta ko'tariladi, ketma-ket 10 martadan ortiq tez-tez
  qulab tushsa, PM2 uni "errored" holatga o'tkazib to'xtatadi (cheksiz
  qayta-urinish tsiklidan saqlanish uchun)
- `min_uptime: '10s'` — kamida 10 soniya ishlagan jarayon "muvaffaqiyatli
  ishga tushdi" deb hisoblanadi (10 soniyadan oldin qulasa, restart hisobiga
  qo'shiladi)
- `max_memory_restart: '500M'` — xotira sizib ketsa (memory leak), 500MB dan
  oshganda avtomatik qayta ishga tushiriladi

### Log rotatsiyasi (`pm2-logrotate`)

PM2 o'zi `logs/pm2-out.log` va `logs/pm2-error.log` fayllarini HECH QACHON
o'zi qisqartirmaydi yoki o'chirmaydi — ular vaqt o'tishi bilan cheksiz o'sib,
diskni to'ldirib qo'yishi mumkin. Shuning uchun `pm2-logrotate` moduli serverga
bir marta o'rnatilishi SHART:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 30
pm2 set pm2-logrotate:compress true
```

Bu — global modul, `ecosystem.config.js`ga yozilmaydi va har bir serverda
alohida (PM2 o'rnatilgandan keyin, bir marta) qo'lda ishga tushiriladi.

## 5. Nginx konfiguratsiyasi (reverse proxy)

**MUHIM — kamera/to'lov webhooklari uchun `client_max_body_size`**:
`/api/webhook/*` va `/api/payments/*` route'lari `express.raw()` orqali
XOM (parse qilinmagan) body qabul qiladi — Hikvision multipart/XML signali
uchun `20mb`gacha, Payme/Click uchun `5mb`gacha ruxsat berilgan
(`src/modules/webhook/webhook.routes.ts`, `src/modules/payment/payment.routes.ts`).
Nginx'ning standart `client_max_body_size` qiymati atigi `1m` — agar buni
oshirmasangiz, kattaroq kamera signali Node'ga yetib borishdan OLDIN Nginx
darajasida **413 Request Entity Too Large** bilan rad etiladi (bu — backend
kodi bilan hech qanday aloqasi yo'q, sof Nginx cheklovi).

**Rele/printer timeout haqida**: webhook orqali kirish/chiqish so'rovi
ichida backend LAN qurilmalariga (rele, termal printer) TCP so'rov yuboradi —
har biri 5 soniyalik ichki timeout bilan (`src/modules/relay/relay.service.ts`,
`src/modules/printer/printer.service.ts`). Eng yomon holatda (ikkalasi ham
javob bermasa) bitta so'rov ~10-11 soniyagacha davom etishi mumkin — bu esa
Nginx'ning odatiy (`60s`) `proxy_read_timeout`idan ancha kam, shuning uchun
alohida uzaytirish SHART EMAS.

**Public display / operator paneli — WebSocket (`/socket.io`)**: bu — bir
martalik so'rov emas, brauzer soatlab ochiq qoldirishi mumkin bo'lgan uzluksiz
ulanish (real-vaqt parking hodisalari, jamoat ekranlari). Oddiy API so'rovlari
uchun mos timeout bu yerda ulanishni foydalanuvchi hali sahifani ochiq
turganida ham uzib qo'yadi.

```nginx
server {
    listen 443 ssl;
    server_name sizning-domeningiz.uz;

    client_max_body_size 20m;

    # Frontend (smart-frontend build chiqishi, masalan `npm run build` dan keyingi dist/)
    # Backend bilan BIR XIL domenda joylashgani uchun CSP'dagi 'self' ikkalasini
    # ham qamrab oladi — connect-src/img-src'ga alohida backend manzili KERAK EMAS
    # (buni smart-backend/src/app.ts'dagi helmet CSP va smart-frontend/vite.config.ts'dagi
    # dev CSP bilan solishtiring — u yerda frontend/backend turli portda bo'lgani
    # uchun manzillar aniq ko'rsatilgan).
    location / {
        root /var/www/smart-frontend/dist;
        try_files $uri /index.html;

        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'" always;
    }

    location /api {
        proxy_pass http://localhost:5000;
        proxy_set_header Host $host;
    }

    location /socket.io {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Uzluksiz WebSocket ulanishi uchun — operator/public display
        # sahifani uzoq vaqt ochiq qoldirishi mumkin:
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /uploads {
        proxy_pass http://localhost:5000;
    }
}
```

**Eslatma — kamera/Payme/Click tarmoq kirishi**: `/api/webhook/*` va
`/api/payments/*` server-serverga (kamera qurilmasi, Payme/Click serverlari)
so'rov yuboradi, brauzer orqali emas — shuning uchun ular frontend origin'idan
mustaqil ravishda, to'g'ridan-to'g'ri ushbu domenga yetib borishi kerak. Agar
serveringiz oldida qo'shimcha firewall/WAF bo'lsa, kamera qurilmasi va
Payme/Click'ning IP diapazonlaridan `POST /api/webhook/*` va
`POST /api/payments/*`ga kirish RUXSAT etilganini tasdiqlang.

## 6. Deploydan keyin tekshirish ro'yxati

- [ ] `GET /health` — `status: "ok"` va `db_pool` ma'lumoti to'g'ri qaytmoqda
- [ ] `POST /api/auth/login` — super_admin bilan kirish ishlayapti
- [ ] `POST /api/webhook/debug/:webhook_token/entry` (haqiqiy tashkilot
  tokeni bilan) — `200 {"ok": true}` qaytarayotganini va
  `tb_webhook_debug_logs`ga yozilganini tekshiring
- [ ] `GET /api/admin/organizations/:id/integration-settings` — `webhookEntryUrl`/
  `webhookExitUrl` to'g'ri, production domeningizga ishora qilayotganini
  tasdiqlang (kamerani shu URL'larga sozlang)
- [ ] `uploads/` va `backups/` papkalari server diskida yozish huquqiga ega
- [ ] Rejalashtirilgan cron joblar konsol logida "rejalashtirildi" deb
  ko'rinmoqda: backup (`0 3 * * *`), rasm backup (`15 3 * * *`), rasm
  xotirasini tozalash (`0 4 * * *`), webhook hodisalarini tozalash
  (`0 5 * * *`), webhook debug loglarini tozalash (`15 5 * * *`)
- [ ] `.env` fayli **git repo tarkibida emasligini** tasdiqlang
  (`.gitignore`da `.env` bor, faqat `.env.production.example` commit qilinadi)
- [ ] MySQL serverning `max_connections`i `DB_POOL_MAX` dan (va agar bir
  nechta instance ishlatilsa, ularning yig'indisidan) sezilarli katta
  ekanini tekshiring
- [ ] Brauzerda frontend domenini oching, DevTools → Network → istalgan
  so'rov Response Headers'ida `Content-Security-Policy` borligini va
  konsolda "Refused to..." xatosi yo'qligini tasdiqlang (login, public
  display, WebSocket ulanishi — barchasi tekshirilsin)
