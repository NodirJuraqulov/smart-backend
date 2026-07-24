# s-backend — Production'ga chiqarish qo'llanmasi

Bu hujjat faqat **s-backend**ga tegishli amaliy qadamlar: `.env` ni qanday
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

# ENCRYPTION_KEY (32 bayt = 64 hex belgi — AES-256-GCM uchun aniq shu uzunlikda bo'lishi SHART)
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
| `ENCRYPTION_KEY` | Yuqoridagi generatsiya qilingan hex string (**32 bayt/64 belgi aniq**) |
| `CORS_ORIGIN` | Frontend production domeni, masalan `https://app.stoyanka.uz` |

**MUHIM**: `ENCRYPTION_KEY`ni deploy qilgandan keyin O'ZGARTIRMANG — bu
kalit `tb_settings.camera_password_encrypted`dagi barcha shifrlangan
parollarni ochish uchun kerak. Kalit yo'qolsa/o'zgarsa, barcha saqlangan
kamera parollari qayta kiritilishi kerak bo'ladi.

## 2. Startup xavfsizlik tekshiruvi

`src/config/env.ts` production rejimida (`NODE_ENV=production`) quyidagilarni
avtomatik tekshiradi va MOS KELMASA serverni **ishga tushirishdan oldin**
`process.exit(1)` bilan to'xtatadi:

- `JWT_SECRET` dev qiymatida qolgan yoki 32 belgidan qisqa
- `ENCRYPTION_KEY` 64 hex belgidan (32 bayt) boshqa uzunlikda
- `CORS_ORIGIN` `localhost` ga ishora qilsa yoki umuman belgilanmagan (`*`)
- `DB_PASSWORD` bo'sh, 8 belgidan qisqa, yoki oddiy parollar ro'yxatida
  (`password`, `123456`, `admin` va h.k.)

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

**MUHIM — OCR so'rovlari uchun timeout**: haqiqiy YOLOv8+PaddleOCR inference
5+ soniya davom etishi kuzatilgan (yuqori yuklamada, so'rovlar s-python'ning
navbatida kutganda, undan ham ko'proq). Agar Nginx standart timeout bilan
qolsa, bu so'rovlar backend/s-python o'zi to'g'ri ishlayotgan bo'lsa ham
Nginx darajasida **504 Gateway Timeout** bilan uzilib qolishi mumkin — bu
"yo'lda" kesib tashlanadigan, backend hech qanday aloqasi bo'lmagan xato.

**Live View (`/socket.io`) esa BUTUNLAY BOSHQA holat**: bu — bir martalik
so'rov emas, operator kamerani soatlab ochiq qoldirishi mumkin bo'lgan
uzluksiz ulanish. Oddiy API so'rovlari uchun mos timeout bu yerda ulanishni
operator hali tomosha qilib turganida ham uzib qo'yadi.

```nginx
server {
    listen 443 ssl;
    server_name sizning-domeningiz.uz;

    # Frontend (s-frontend build chiqishi, masalan `npm run build` dan keyingi dist/)
    # Backend bilan BIR XIL domenda joylashgani uchun CSP'dagi 'self' ikkalasini
    # ham qamrab oladi — connect-src/img-src'ga alohida backend manzili KERAK EMAS
    # (buni s-backend/src/app.ts'dagi helmet CSP va s-frontend/vite.config.ts'dagi
    # dev CSP bilan solishtiring — u yerda frontend/backend turli portda bo'lgani
    # uchun manzillar aniq ko'rsatilgan).
    location / {
        root /var/www/s-frontend/dist;
        try_files $uri /index.html;

        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'" always;
    }

    location /api {
        proxy_pass http://localhost:5000;
        proxy_set_header Host $host;

        # OCR so'rovlari sekin bo'lishi mumkin
        # (5-15 soniya, yuqori yuklamada undan ko'p) —
        # standart 60s odatda yetarli, lekin ehtiyot
        # uchun aniq belgilanadi:
        proxy_read_timeout 30s;
        proxy_connect_timeout 10s;
        proxy_send_timeout 30s;
    }

    location /socket.io {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Live View uchun UZOQ MUDDATLI ulanish
        # (operator kamerani soatlab ochiq qoldirishi
        # mumkin) — bu ODATIY so'rovlardan FARQLI,
        # timeout YO'Q yoki JUDA UZOQ bo'lishi kerak:
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /uploads {
        proxy_pass http://localhost:5000;
    }
}
```

**Eslatma**: `/api`dagi `30s` — odatiy holat uchun yetarli zaxira bilan
tanlangan (kuzatilgan real inference vaqti ~5s). Agar production'da
yuqori parallel yuklama ostida (bir nechta stoyanka bir vaqtda entry/exit
yuborganda, s-python'ning ichki navbatida kutish ortishi mumkin) baribir
`504` ko'rina boshlasa, shu qiymatni oshirishni ko'rib chiqing — bu Nginx
konfiguratsiyasi, kod o'zgarishi talab qilmaydi.

## 6. Deploydan keyin tekshirish ro'yxati

- [ ] `GET /health` — `status: "ok"` va `db_pool` ma'lumoti to'g'ri qaytmoqda
- [ ] `POST /api/auth/login` — super_admin bilan kirish ishlayapti
- [ ] `uploads/` va `backups/` papkalari server diskida yozish huquqiga ega
- [ ] Kunlik backup joblari (`0 3 * * *`) va rasm tozalash (`0 4 * * *`)
  konsol logida "rejalashtirildi" deb ko'rinmoqda
- [ ] `.env` fayli **git repo tarkibida emasligini** tasdiqlang
  (`.gitignore`da `.env` bor, faqat `.env.production.example` commit qilinadi)
- [ ] MySQL serverning `max_connections`i `DB_POOL_MAX` dan (va agar bir
  nechta instance ishlatilsa, ularning yig'indisidan) sezilarli katta
  ekanini tekshiring
- [ ] Brauzerda frontend domenini oching, DevTools → Network → istalgan
  so'rov Response Headers'ida `Content-Security-Policy` borligini va
  konsolda "Refused to..." xatosi yo'qligini tasdiqlang (login, Live View,
  rasm ko'rish, WebSocket ulanishi — barchasi tekshirilsin)
