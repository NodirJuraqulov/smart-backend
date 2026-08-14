# smart-backend

AutoStoyanka — avtomatik avtoturargoh boshqaruv tizimining backend qismi. IP-kamera (Hikvision va shu kabi ANPR qurilmalar) mashina raqamini o'zi aniqlab, to'g'ridan-to'g'ri webhook orqali backendga yuboradi — kirish/chiqishni qayd qiladi, tarif bo'yicha to'lovni hisoblaydi, shlagbaumni rele orqali ochadi, chek chop etadi, va operator/super-admin uchun REST API + real-vaqt (Socket.IO) hodisalarini, jamoat ekranlari (public display) uchun esa autentifikatsiyasiz API va WebSocket xonasini taqdim etadi.

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
| `ENCRYPTION_KEY` | Kamera relay parollarini AES-256-GCM bilan shifrlash uchun 32 baytli hex yoki base64 kalit |
| `JWT_EXPIRES_IN` | Access token amal qilish muddati |
| `REFRESH_TOKEN_EXPIRES_DAYS` | Refresh token amal qilish muddati (kun) |
| `CORS_ORIGIN` | Frontend manzili |
| `UPLOADS_MAX_SIZE_MB` | Yuklangan fayllar uchun umumiy hajm chegarasi |
| `PLATFORM_DEFAULT_TIMEZONE` | Ko'p tashkilotli hisobotlar uchun standart vaqt zonasi |
| `PUBLIC_BASE_URL` | Serverning tashqi (public) manzili — webhook URL generatsiyasi uchun ishlatiladi (masalan `http://195.158.9.168:84`). Production'da MAJBURIY, aks holda server ishga tushmaydi |
| `PAYME_ENABLED` | Payme onlayn to'lov integratsiyasi yoqilganmi (`true`/`false`) — hozircha faqat skelet, `false` qoldiring |
| `CLICK_ENABLED` | Click onlayn to'lov integratsiyasi yoqilganmi (`true`/`false`) — hozircha faqat skelet, `false` qoldiring |

Har bir tashkilot (`tb_organizations`) uchun printer/kamera va webhook sozlamalari bazada saqlanadi. Kamera relay credentiallari `PATCH /api/organizations/:id/camera-relay-settings` orqali sozlanadi.

## API endpointlar

### Auth (`/api/auth`)
- `POST /login`
- `POST /refresh`
- `POST /logout`
- `GET /me` (auth)

### Admin — Organizations (`/api/admin/organizations`, faqat super_admin)
- `GET /`
- `POST /`
- `PUT /:id`
- `PATCH /:id/block`
- `GET /:id/stats`
- `PUT /:id/pricing-mode`
- `PUT /:id/capacity`
- `POST /:id/operator`
- `POST /:id/printer/test`
- `GET /:id/integration-settings`
- `PUT /:id/integration-settings`
- `POST /:id/integration-settings/regenerate-token`
- `/:id/tariff-intervals/*`
- `/:id/permissions/*`

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

### Tariff Intervals (`/api/tariff-intervals`)
- `GET /`
- `POST /`
- `PUT /:intervalId`
- `DELETE /:intervalId`

### Subscription Plans (`/api/subscription-plans`)
- `GET /`
- `POST /`
- `PUT /:id`
- `DELETE /:id`

### Subscriptions (`/api/subscriptions`)
- `GET /`
- `POST /`
- `PUT /:id`
- `POST /:id/renew`
- `DELETE /:id`

### VIP Vehicles (`/api/vip-vehicles`)
- `GET /`
- `POST /`
- `PUT /:id`
- `DELETE /:id`

### Settings (`/api/settings`)
- `GET /`
- `PUT /`

### Parking (`/api/parking`)
- `POST /entry/manual`
- `POST /exit/manual`
- `GET /capacity`
- `GET /active`
- `GET /sessions`
- `GET /sessions/awaiting-payment`
- `GET /sessions/:id`
- `POST /sessions/:id/force-close`
- `POST /sessions/:id/print-receipt`
- `POST /sessions/:id/confirm-cash-payment`
- `POST /sessions/:id/payment-method`
- `DELETE /sessions/clear-test` (faqat `NODE_ENV !== production`)

### Reports (`/api/reports`)
- `GET /daily`
- `GET /monthly`
- `GET /yearly`

### Public Display (`/api/public/display`, AUTH TALAB QILINMAYDI)
- `GET /:orgId/status`

### Webhook (`/api/webhook`, AUTH TALAB QILINMAYDI — `webhook_token` orqali)
- `POST /debug/:token/:direction(entry|exit)`
- `POST /hikvision/:token/:direction(entry|exit)`

### Payments (`/api/payments`, AUTH TALAB QILINMAYDI — hozircha skelet/stub)
- `POST /payme/webhook`
- `POST /click/webhook`

### Health
- `GET /health`

## WebSocket (Socket.IO)

Ikki xil ulanish rejimi mavjud:
- **Autentifikatsiyalangan** (`handshake.auth.token` — JWT): operator/owner `org_{orgId}` xonasiga, super_admin `admins` xonasiga qo'shiladi.
- **Public display** (`handshake.auth.orgId` — auth talab qilinmaydi): `public:org:{orgId}` xonasiga qo'shiladi.

Hodisalar: `entry_detected`, `parking_full`, `exit_awaiting_payment`, `exit_completed`, `plate_not_recognized_for_exit`, `relay_failed`, `webhook_parse_failed`.
