# s-backend

AutoStoyanka — avtomatik avtoturargoh boshqaruv tizimining backend qismi. Kamera orqali (s-agent va s-python OCR xizmati bilan) mashina raqamini aniqlab, kirish/chiqishni qayd qiladi, tarif bo'yicha to'lovni hisoblaydi, shlagbaumni boshqaradi, va operator/super-admin uchun REST API + real-vaqt (Socket.IO) hodisalarini taqdim etadi.

## O'rnatish

```bash
npm install
cp .env.example .env
```

`.env` faylini to'ldiring (quyidagi jadvalga qarang).

```bash
npm run migrate
npm run seed
```

## Ishga tushirish

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm run migrate
pm2 start ecosystem.config.js --env production
```

To'liq production deploy qo'llanmasi uchun `DEPLOYMENT.md`ga qarang.

## .env o'zgaruvchilari

| O'zgaruvchi | Tavsif |
|---|---|
| `NODE_ENV` | `development` yoki `production` |
| `PORT` | Server porti |
| `DB_HOST` | MySQL host |
| `DB_PORT` | MySQL port |
| `DB_NAME` | Database nomi |
| `DB_USER` | Database foydalanuvchisi |
| `DB_PASSWORD` | Database paroli |
| `DB_POOL_MIN` | Connection pool minimal soni |
| `DB_POOL_MAX` | Connection pool maksimal soni |
| `JWT_SECRET` | JWT token imzolash kaliti (kamida 32 belgi) |
| `JWT_EXPIRES_IN` | Access token amal qilish muddati |
| `REFRESH_TOKEN_EXPIRES_DAYS` | Refresh token amal qilish muddati (kun) |
| `ENCRYPTION_KEY` | Kamera parollarini shifrlash uchun 32 baytli (64 hex belgi) kalit |
| `PYTHON_OCR_URL` | s-python (raqam aniqlash) xizmati manzili |
| `INTERNAL_API_KEY` | s-python bilan bir xil bo'lishi shart bo'lgan ichki kalit |
| `CORS_ORIGIN` | Frontend manzili |
| `UPLOADS_MAX_SIZE_MB` | Yuklanadigan rasm fayli hajm chegarasi |
| `PLATFORM_DEFAULT_TIMEZONE` | Ko'p tashkilotli hisobotlar uchun standart vaqt zonasi |

## API endpointlar

### Auth (`/api/auth`)
- `POST /login`
- `POST /refresh`
- `POST /logout`
- `GET /me`

### Admin — Organizations (`/api/admin/organizations`)
- `GET /`
- `POST /`
- `PUT /:id`
- `PATCH /:id/block`
- `GET /:id/stats`

### Admin — Stats (`/api/admin/stats`)
- `GET /`

### Admin — Users (`/api/admin/users`)
- `GET /`
- `POST /`
- `PUT /:id`
- `PATCH /:id/block`

### Admin — Activity Logs (`/api/admin/activity-logs`)
- `GET /`

### Tariffs (`/api/tariffs`)
- `GET /`
- `POST /`
- `PUT /:id`
- `DELETE /:id`

### Settings (`/api/settings`)
- `GET /`
- `PUT /`
- `POST /barrier/test`
- `POST /agent-key/generate`

### Parking (`/api/parking`)
- `POST /entry`
- `POST /entry/manual`
- `POST /exit`
- `POST /exit/manual`
- `GET /active`
- `GET /sessions`
- `GET /sessions/:id`
- `POST /sessions/:id/force-close`
- `DELETE /sessions/clear-test` (faqat `NODE_ENV !== production`)

### Reports (`/api/reports`)
- `GET /daily`
- `GET /monthly`
- `GET /yearly`

### Agent — Parking (`/api/agent/parking`)
- `POST /entry`
- `POST /exit`
- `POST /verify`

### Agent — Config (`/api/agent/config`)
- `GET /`

### Agent — Heartbeat (`/api/agent/heartbeat`)
- `POST /`

### Live View (`/api/live-view`)
- `GET /`

### Health
- `GET /health`
