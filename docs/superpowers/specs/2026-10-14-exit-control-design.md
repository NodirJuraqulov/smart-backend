# Exit Control V2 Design

## Maqsad

Chiqish kamerasining bir yoki ikki belgilik OCR xatolarida operatorga xavfsiz sessiya takliflarini berish, noaniq match sabab noto'g'ri karta summasi boshlanishini cheklash, chiqish nazorati statistikasini qo'shish va eski faol regular sessiyalarni boshqariladigan cron orqali tozalash.

Mavjud cash, online, card, Vendotek, LED, Telegram, kamera, shlagbaum, emergency va majburiy ochish oqimlari saqlanadi. Yangi matching va stale cleanup xatti-harakatlari default o'chirilgan env bayroqlari ortida bo'ladi. Kod commentsiz yoziladi. Commit va push qilinmaydi.

## Audit Qarorlari

### Mavjud matching

`createExitCandidate()` exact qidiruvda tashkilot, asl nomer va `active` yoki `awaiting_payment` statuslarini ishlatadi. Exact topilmasa `findFuzzyActiveSession()` tashkilotning barcha `active` sessiyalarini xotirada `isFuzzyPlateMatch()` bilan tekshiradi. Mavjud fuzzy qoidasi kamida olti belgili nomerlar orasida edit distance aynan bir bo'lgan yagona sessiyani oladi. Kamera voqeasidan keyin kirgan sessiyalarni cheklamaydi.

`EXIT_MATCH_V2_ENABLED=false` bo'lganda shu yo'l va fuzzy match topgan sessiya uchun avtomatik karta boshlash xatti-harakati o'zgarmaydi.

### Operator qidiruvi va majburiy ochish

`POST /api/exit-candidates/:id/search` hozir `{ results, active_sessions }` qaytaradi. Natijalarda sessiya ma'lumoti, `similarity_score`, tarif preview va kirish rasmlari mavjud.

Backend qidiruv bajarilganini qayd etmaydi va `force-open` oldidan qidiruv talab qilmaydi. Shu sabab qidiruv trackingi, majburiy ochish guardi va oldingi 8-band 10-testi qo'shilmaydi. Majburiy ochish sababi backendda ixtiyoriy bo'lib qoladi.

### VIP va emergency

`tb_vip_vehicles.note` erkin matn maydoni sifatida mavjud. Tez yordam belgilari shu maydonda saqlanishi mumkin; migratsiya va VIP API o'zgarishi kerak emas.

`session_source` kirishda exact plate bo'yicha yoziladi. `confirmExitCandidate()` chiqishda VIP jadvalini qayta tekshirmaydi. Kirish OCR xato bo'lsa regular yaratilgan sessiya keyin ham regular bo'lib qoladi.

Emergency backend qo'llab-quvvati, tarix, Telegram, WebSocket va public display oqimlari o'zgarmaydi.

### Rasmlar

Webhook rasmlari `uploads/parking-events` ichida saqlanadi. Mavjud storage cleanup faqat `uploads/parking`ni boshqaradi. Stale cleanup webhook yozuvlarini o'chirganda event rasmlari yetim qolishi mumkin. Ushbu ish doirasida rasm o'chirish qo'shilmaydi; yakuniy hisobotda alohida taklif beriladi.

## Env Konfiguratsiyasi

Quyidagi qiymatlar `src/config/env.ts` va `.env.example`ga qo'shiladi:

- `EXIT_MATCH_V2_ENABLED=false`
- `FORCED_OPEN_AVG_LOSS_SOM=10000`
- `STALE_SESSION_CLEANUP_ENABLED=false`
- `STALE_SESSION_CLEANUP_KEEP_DAYS=2`
- `STALE_SESSION_CLEANUP_MAX_PER_RUN=1000`
- `STALE_SESSION_CLEANUP_CRON=30 3 * * *`

Boolean qiymatlar `LED_ENABLED` kabi faqat literal `"true"` bilan yoqiladi. Musbat sonlar noto'g'ri yoki bo'sh bo'lsa default qiymatga tushadi.

## Plate Matching Moduli

`src/modules/exitCandidates/plateMatch.ts` tashqi holatga bog'liq bo'lmagan funksiyalarni eksport qiladi:

- `canonicalizePlate(raw)` qiymatni katta harfga o'tkazadi, alfanumerik bo'lmagan belgilarni olib tashlaydi va `O→0`, `I→1`, `B→8`, `S→5` xaritasini qo'llaydi.
- `plateDistance(a, b)` canonical qiymatlar orasidagi oddiy Levenshtein masofasini qaytaradi. Transposition alohida operatsiya hisoblanmaydi.
- `similarityPercent(a, b)` `100 - distance / max(length(a), length(b), 1) * 100` formulasini butun songa yaxlitlaydi va natijani 0–100 oralig'ida saqlaydi.

Null yoki canonical uzunligi uchdan kichik nomer match va qidiruv uchun yaroqsiz hisoblanadi.

## Candidate Yaratish

Flag o'chirilganda mavjud exact, fuzzy, cooldown, pending coalescing va card trigger kod yo'li o'zgarmaydi.

Flag yoqilganda sessiya matching ketma-ketligi:

1. Mavjud exact qidiruv o'z holicha ishlaydi, shu jumladan `awaiting_payment`ni aniqlash va skip qilish.
2. Exact topilmasa tashkilotning `status='active'`, `entered_at < camera_event_at` va plate mavjud sessiyalari olinadi.
3. Canonical distance 0 bo'lgan sessiyalar soni aynan bitta bo'lsa match qilinadi.
4. Distance 0 yagona bo'lmasa distance 1 bo'lgan sessiyalar soni aynan bitta bo'lsa match qilinadi.
5. Boshqa holatda `matched_session_id` null qoladi.

`session_source` matchingni cheklamaydi. Match operatorga pending candidate ichida taklif bo'lib qoladi; sessiya avtomatik yopilmaydi.

V2 resolver match turi va distance qiymatini ichki natijada saqlaydi. Bu metadata DBga yozilmaydi va migratsiya talab qilmaydi.

Mavjud cooldown va pending candidate coalescing fuzzy qoidalari ushbu ishda o'zgarmaydi. V2 faqat faol parking sessiyasini candidatega match qilishga qo'llanadi.

## Karta Avto-Boshlash

Flag o'chirilganda exact yoki mavjud fuzzy orqali topilgan sessiya uchun hozirgi avtomatik karta triggeri ishlashda davom etadi.

Flag yoqilganda candidate yaratilishidagi avtomatik karta triggeri faqat exact yoki canonical distance 0 match uchun ishlaydi. Distance 1 match candidate ichida ko'rsatiladi, lekin terminal operatsiyasi yaratilmaydi.

`GET /api/exit-candidates/next` ichidagi exact plate fallback va operator tanlagan sessiya bilan ishlaydigan mavjud oqimlar o'zgarmaydi.

## Operator Qidiruvi

Flag o'chirilganda endpoint javobi va mavjud qidiruv algoritmi o'zgarmaydi.

Flag yoqilganda:

- Bodyda yaroqli `plate` bo'lsa qo'lda kiritilgan plate ishlatiladi.
- Bodyda plate bo'lmasa candidate `detected_plate`, undan keyin `suggested_plate` avtomatik query bo'ladi.
- Tashkilotning barcha `active` sessiyalari canonical distance 0–2 bo'yicha xotirada filtrlab olinadi.
- Natijalar `similarity` kamayish tartibida, keyin `entered_at` va `id` kamayish tartibida saralanadi.
- Eng ko'pi o'nta natija qaytariladi.
- Mavjud `similarity_score` maydoni saqlanadi va V2 foiz qiymatini oladi.
- Yangi `similarity` maydoni ayni butun foiz qiymati bilan qo'shiladi.
- `active_sessions` va barcha mavjud result maydonlari o'zgarmaydi.

Endpoint hech qanday search-tracking yozuvi yaratmaydi. Majburiy ochish qidiruvsiz ruxsat etilgan holda qoladi.

## Exit Control Hisoboti

Yangi endpoint:

`GET /api/reports/exit-control?from=YYYY-MM-DD&to=YYYY-MM-DD&org_id=<id>`

Ruxsatlar:

- Owner va Operator o'z tashkiloti doirasida.
- Operator uchun `reports` permission talab qilinadi.
- Super Admin uchun `org_id` majburiy.
- Kassir va registrator rad etiladi.
- Mavjud `resolveOrgIdRequired()` boshqa tashkilot so'rovini 404 bilan rad etadi.

Validatsiya:

- `from` va `to` majburiy va tashkilot vaqt zonasida haqiqiy `YYYY-MM-DD` bo'lishi kerak.
- `from <= to`.
- Inclusive oraliq 93 kundan oshsa 400.
- Kelajakdagi `to` qiymati 400.

Candidate sana maydoni `camera_event_at` bo'lib, tashkilot vaqt zonasiga o'tkaziladi. UTC query chegaralari tashkilot vaqt zonasidagi `from 00:00:00` va `to + 1 day 00:00:00` orqali hisoblanadi. Kunlar `from`dan `to`gacha to'liq va o'sish tartibida qaytariladi; yozuvsiz kunlar nol qiymatlar bilan keladi.

Sessiya bog'lanishi `COALESCE(resolved_session_id, matched_session_id)` orqali aniqlanadi.

- `not_found_count`: coalesced session ID null bo'lgan barcha candidate soni.
- `forced_open_count`: `resolution_type='emergency_forced_open'` bo'lgan candidate soni.
- `forced_open_vip_or_subscription`: forced open ichida bog'langan sessiya source `vip` yoki `subscription` bo'lganlar.
- `forced_open_unknown_or_regular`: `forced_open_count - forced_open_vip_or_subscription`.
- `estimated_loss_som`: unknown yoki regular soni ko'paytirilgan `FORCED_OPEN_AVG_LOSS_SOM`.

Javob kontrakti:

```json
{
  "estimated": true,
  "avg_loss_som": 10000,
  "from": "2026-10-13",
  "to": "2026-10-14",
  "days": [
    {
      "date": "2026-10-13",
      "not_found_count": 20,
      "forced_open_count": 15,
      "forced_open_unknown_or_regular": 12,
      "forced_open_vip_or_subscription": 3,
      "estimated_loss_som": 120000
    }
  ],
  "totals": {
    "not_found_count": 20,
    "forced_open_count": 15,
    "forced_open_unknown_or_regular": 12,
    "forced_open_vip_or_subscription": 3,
    "estimated_loss_som": 120000
  }
}
```

Hisobot to'lov yaratmaydi va parking sessiyalarini o'zgartirmaydi.

## Stale Session Cleanup

Asosiy service `src/modules/maintenance/staleSessionsCleanup.service.ts`da bo'ladi. Cron adapter mavjud jobs patterniga mos alohida faylda bo'ladi va `server.ts` faqat flag true bo'lganda uni ro'yxatdan o'tkazadi.

Faol tashkilotlar `id` va `timezone` bilan ketma-ket aylanadi. `KEEP_DAYS` bugunni ham qo'shgan holda saqlanadigan kalendar kunlar sonidir. Har tashkilot uchun cutoff tashkilot vaqt zonasidagi bugungi kun boshidan `KEEP_DAYS - 1` kun ayirish orqali olinadi. Default 2 holatida kecha va bugun saqlanadi. Global `CURDATE()` ishlatilmaydi.

Har tashkilot alohida tranzaksiyada qayta ishlanadi:

1. `tb_parking_sessions`dan `org_id`, `status='active'`, `session_source='regular'`, `entered_at < cutoff` sessiyalar lock qilinadi.
2. Active statsionar plate, `tb_payments` yozuvi yoki terminal statusi `APPROVED`, `FIN_FAILED`, `ORPHANED` bo'lgan sessiyalar skip qilinadi.
3. Skip qilinganlar sabab bo'yicha hisoblanadi va WARN log yoziladi.
4. O'chiriladigan sessiyalar soni `MAX_PER_RUN`dan katta bo'lsa transaction hech narsani o'chirmaydi, ERROR log yoziladi va keyingi tashkilotga o'tiladi.
5. Qolgan sessiyalar uchun bog'liq yozuvlar tartib bilan o'chiriladi: exit candidates, entry candidates, webhook events, session activity logs, payment terminal operations, parking sessions.
6. Har delete sessionning shu transaction ichida hanuz `active` va `regular` ekanini subquery yoki join orqali qayta tekshiradi.
7. Parking session delete ham `id`, `org_id`, `status='active'`, `session_source='regular'` bilan guard qilinadi.
8. Xato transactionni rollback qiladi, ERROR log yozadi va boshqa tashkilotlarni to'xtatmaydi.

`tb_payment_transactions` va `tb_clinic_discounts` session foreign keylari `SET NULL`; ular TZda o'chirish ro'yxatiga kirmagani uchun saqlanadi. `tb_payments` mavjud sessiyalar cleanupdan skip qilinadi.

Run oxirida barcha tashkilotlar bo'yicha bitta summary log yoziladi. Summary nomzodlar, o'chirilgan sessiyalar, statsionar, payment va terminal sababli skiplar, limit sabab to'xtagan tashkilotlar, xatolar hamda har bir bog'liq jadvaldan o'chirilgan sonlarni o'z ichiga oladi.

Cron callback service xatosini ushlaydi va serverni yiqitmaydi.

## Test Strategiyasi

### Unit

- Canonical mapping, case, space va belgilar.
- Levenshtein va similarity foizi.
- Null va uchdan qisqa plate guardi.

### Exit Candidate Integration

- V2 distance 0 yagona sessiya match.
- V2 distance 1 yagona sessiya match.
- V2 distance 1 ikki sessiyada null.
- V2 distance 2 candidate match emas.
- V2 searchda distance 2 natija bor, `similarity` va mavjud maydonlar saqlangan.
- Qo'lda plate qidiruvi ishlaydi.
- Plate berilmaganda candidate plate avtomatik query bo'ladi.
- Flag false mavjud fuzzy matching va avto-karta oqimini saqlaydi.
- Flag true distance 1 avto-kartani boshlamaydi.
- Flag true exact va canonical distance 0 avto-kartani boshlaydi.
- Majburiy ochish qidiruvsiz ishlashda davom etadi.

### Reports Integration

- To'liq response shape va nol kunlar.
- Candidate camera vaqtining org timezone kuni.
- Resolved session matched sessiondan ustun.
- VIP va subscription lossga kirmaydi.
- Regular va noma'lum lossga kiradi.
- 93 kundan ortiq oraliq 400.
- Operator boshqa org uchun 404.
- Kassir va registrator 403.

### Cleanup Integration

- Eski active regular o'chadi.
- Cutoffdan keyingi va bugungi sessiya saqlanadi.
- Completed, awaiting_payment, VIP va subscription saqlanadi.
- Statsionar, paymentli va himoyalangan terminal statuslari saqlanadi.
- Max limit oshsa org bo'yicha hech narsa o'chmaydi.
- Ikki timezone cutoffi mustaqil.
- Bir org rollbacki boshqasiga ta'sir qilmaydi.
- Takroriy run idempotent.
- Flag false cronni ro'yxatdan o'tkazmaydi.
- Bog'liq jadvallar delete tartibi va hisoblari tekshiriladi.

### Regression

Avval tor unit va integration testlar, keyin to'liq `npm test`, `npm run typecheck`, `npm run typecheck:tests`, `npm run lint` va `npm run build` bajariladi.

## Xavfsizlik Chegaralari

- Flaglar false bo'lganda legacy matching, fuzzy card trigger va cron registration o'zgarmaydi.
- Cleanup faqat active regular sessiyalarni o'chiradi.
- Completed, awaiting_payment, VIP va subscription sessiyalar cleanup target bo'lmaydi.
- Mavjud API maydonlari olib tashlanmaydi yoki nomi o'zgartirilmaydi.
- VIP migratsiyasi yozilmaydi.
- Emergency backend oqimi o'zgarmaydi.
- Rasm fayllari ushbu ishda o'chirilmaydi.
