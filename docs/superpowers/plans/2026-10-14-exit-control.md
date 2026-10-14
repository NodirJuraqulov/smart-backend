# Exit Control V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flag bilan boshqariladigan xavfsiz exit plate matching, operator qidiruvi, karta guardi, exit-control hisoboti va timezone-aware stale session cleanupini qo'shish.

**Architecture:** Legacy matching va karta oqimi flag false holatida alohida kod yo'li sifatida saqlanadi. V2 matching sof modul va ichki match metadata orqali ishlaydi; report mavjud reports qatlamiga, cleanup esa maintenance service va cron adapterga qo'shiladi.

**Tech Stack:** TypeScript, Express, Knex, MySQL, Luxon, node-cron, Vitest, Supertest.

**Spec:** `docs/superpowers/specs/2026-10-14-exit-control-design.md`

## Global Constraints

- Birinchi TZ talablari specdan ustun; tasdiqlangan aniqlashtirishlar TZni yangilaydi.
- `EXIT_MATCH_V2_ENABLED=false` holatida legacy exact, fuzzy, candidate, card, LED, Telegram, kamera va shlagbaum oqimlari o'zgarmaydi.
- `STALE_SESSION_CLEANUP_ENABLED=false` holatida cron ro'yxatdan o'tmaydi.
- Cleanup faqat `status='active'` va `session_source='regular'` sessiyalarni o'chiradi.
- Completed, awaiting_payment, VIP, subscription, statsionar, paymentli va himoyalangan terminal operatsiyali sessiyalar o'chirilmaydi.
- Yangi API maydonlari faqat qo'shimcha bo'ladi.
- VIP uchun migratsiya yozilmaydi; mavjud `note` ishlatiladi.
- `uploads/parking-events` rasmlari o'chirilmaydi.
- Product va test kodi commentsiz yoziladi.
- Commit va push bajarilmaydi.

## Review Focus

- V2 exact `awaiting_payment` sessiya legacy kabi candidate yaratmasdan skip qilishi kerak; Task 2 testi buni qoplaydi.
- Kamera va sessiya vaqti teng yoki sessiya keyin kirgan bo'lsa canonical match bo'lmasligi kerak; Task 2 boundary testi buni qoplaydi.
- Report timezone konversiyasi UTC kun chegarasiga tushmagan candidate uchun ham to'g'ri bo'lishi kerak; Task 3 non-UTC boundary testi buni qoplaydi.
- Cleanup paytida sessiya statusi guarddan oldin o'zgarsa bog'liq yozuvlar o'chmasligi kerak; Task 4 rollback/guard testi buni qoplaydi.
- Noto'g'ri yoki manfiy numeric env qiymatlari xavfsiz defaultlarga tushishi kerak; Task 1 env testi buni qoplaydi.

---

### Task 1: Env va sof plate matching

**Files:**
- Create: `src/modules/exitCandidates/plateMatch.ts`
- Create: `tests/unit/plateMatch.test.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `tests/unit/env.test.ts`

**Interfaces:**
- Produces: `canonicalizePlate(raw: string): string`
- Produces: `plateDistance(left: string, right: string): number`
- Produces: `similarityPercent(left: string, right: string): number`
- Produces: `env.exitMatchV2Enabled: boolean`
- Produces: `env.forcedOpenAvgLossSom: number`
- Produces: `env.staleSessionCleanup.{enabled,keepDays,maxPerRun,cron}`

- [ ] **Step 1: Plate utility failing testlarini yozish**

`tests/unit/plateMatch.test.ts`da quyidagilarni assert qilish:

- `canonicalizePlate(" 01o iB-s ") === "010185"`.
- Kichik harf, bo'shliq va belgilar olib tashlanadi.
- `plateDistance()` insertion, deletion va substitution uchun to'g'ri Levenshtein qiymatini beradi.
- Transposition bitta emas, ikki edit hisoblanadi.
- `similarityPercent("01A123BC", "01A123BD") === 88`.
- Teng canonical qiymat uchun 100 qaytadi.

- [ ] **Step 2: Plate utility testlari RED ekanini tekshirish**

Run: `npx vitest run tests/unit/plateMatch.test.ts`

Expected: modul yoki eksportlar topilmagani sabab FAIL.

- [ ] **Step 3: Sof plate matching funksiyalarini yozish**

`src/modules/exitCandidates/plateMatch.ts`da O/0, I/1, B/8, S/5 mapping, oddiy Levenshtein matrix va butun 0–100 similarity qiymatini implement qilish.

- [ ] **Step 4: Plate utility testlarini GREEN qilish**

Run: `npx vitest run tests/unit/plateMatch.test.ts`

Expected: barcha testlar PASS.

- [ ] **Step 5: Env failing testlarini yozish**

`tests/unit/env.test.ts`da yangi envlar yo'q holatda defaultlar false, 10000, 2, 1000 va `30 3 * * *` ekanini; literal `true` yoqishini; zero, manfiy va `NaN` numeric qiymatlar defaultga tushishini assert qilish.

- [ ] **Step 6: Env testlarini RED ekanini tekshirish**

Run: `npx vitest run tests/unit/env.test.ts`

Expected: yangi env propertylar mavjud emasligi sabab FAIL.

- [ ] **Step 7: Env konfiguratsiyasi va `.env.example`ni yozish**

`src/config/env.ts`da musbat integer parser yordamida yangi propertylarni qo'shish. `.env.example`da barcha oltita yangi qiymatni defaultlari bilan ko'rsatish.

- [ ] **Step 8: Task 1 testlarini GREEN qilish**

Run: `npx vitest run tests/unit/plateMatch.test.ts tests/unit/env.test.ts`

Expected: barcha testlar PASS.

### Task 2: V2 candidate matching, qidiruv va karta guardi

**Files:**
- Modify: `src/modules/exitCandidates/exitCandidates.service.ts`
- Modify: `tests/integration/exitCandidateFuzzyMatch.test.ts`
- Modify: `tests/integration/exitCandidates.test.ts`
- Modify: `tests/integration/cardPayments.test.ts`

**Interfaces:**
- Consumes: Task 1 `canonicalizePlate`, `plateDistance`, `similarityPercent`, `env.exitMatchV2Enabled`
- Produces: ichki `ExitSessionMatch` metadata `{ session, distance, kind }`
- Produces: V2 search resultga additive `similarity: number`

- [ ] **Step 1: V2 matching failing testlarini yozish**

`tests/integration/exitCandidateFuzzyMatch.test.ts`da flag true bilan:

- canonical distance 0 yagona active sessiya match bo'ladi.
- distance 1 yagona active sessiya match bo'ladi.
- distance 1 ikkita sessiyada `matched_session_id` null.
- distance 2 `matched_session_id` null.
- null va uchdan qisqa detected plate match qilmaydi.
- `entered_at === camera_event_at` va undan keyingi sessiyalar match qilmaydi.
- exact `awaiting_payment` sessiya legacy kabi `already_awaiting_payment` bilan skip bo'ladi.

- [ ] **Step 2: V2 matching testlarini RED ekanini tekshirish**

Run: `npx vitest run tests/integration/exitCandidateFuzzyMatch.test.ts`

Expected: canonical V2 holatlari yoki env branch yo'qligi sabab yangi testlar FAIL.

- [ ] **Step 3: V2 session resolverni implement qilish**

`exitCandidates.service.ts`da exact legacy querydan keyin flag true bo'lsa `active`, `entered_at < cameraEventAt`, non-null plate sessiyalarni olish; unique distance 0, keyin unique distance 1 tanlash. Flag false bo'lsa mavjud `findFuzzyActiveSession()` chaqirig'ini o'zgartirmaslik.

- [ ] **Step 4: V2 matching testlarini GREEN qilish**

Run: `npx vitest run tests/integration/exitCandidateFuzzyMatch.test.ts`

Expected: barcha testlar PASS.

- [ ] **Step 5: Search failing testlarini yozish**

`tests/integration/exitCandidates.test.ts`da flag true bilan:

- body plate yo'q bo'lsa candidate detected plate avtomatik query bo'ladi.
- detected plate yo'q bo'lsa suggested plate ishlatiladi.
- qo'lda kiritilgan plate candidate platedan ustun turadi.
- canonical distance 0–2 natijalar ichida bo'ladi, distance 3 bo'lmaydi.
- natija similarity kamayish tartibida va maksimal 10 ta.
- `similarity` butun foiz, `similarity_score` va barcha eski maydonlar saqlangan.
- qidiruvsiz `force-open` 200 bo'lib qoladi.

- [ ] **Step 6: Search testlarini RED ekanini tekshirish**

Run: `npx vitest run tests/integration/exitCandidates.test.ts`

Expected: avtomatik query yoki `similarity` yo'qligi sabab yangi testlar FAIL.

- [ ] **Step 7: V2 search branchini implement qilish**

Flag true holatda query tanlash, canonical distance 0–2 filter, similarity/entered_at/id sort va top-10ni implement qilish. Flag false branchdagi mavjud `similarityScore()` va response shape kodini saqlash.

- [ ] **Step 8: Search testlarini GREEN qilish**

Run: `npx vitest run tests/integration/exitCandidates.test.ts`

Expected: barcha testlar PASS.

- [ ] **Step 9: Card guard failing testlarini yozish**

`tests/integration/cardPayments.test.ts`da:

- flag false legacy distance 1 fuzzy match uchun avtomatik terminal operation yaratadi.
- flag true distance 1 match candidate yaratadi, ammo terminal operation yaratmaydi.
- flag true exact match terminal operation yaratadi.
- flag true canonical distance 0 terminal operation yaratadi.
- `/next` exact fallback xatti-harakati o'zgarmaydi.

- [ ] **Step 10: Card guard testlarini RED ekanini tekshirish**

Run: `npx vitest run tests/integration/cardPayments.test.ts`

Expected: distance metadata card triggerga yetkazilmagani sabab distance 1 guard testi FAIL.

- [ ] **Step 11: Card trigger distance guardini implement qilish**

Candidate transaction natijasida V2 match distance metadata qaytarish. Flag true va distance 1 holatida `autoStartCardPaymentForCandidate()`ni chaqirmaslik; flag false yoki distance 0 holatida mavjud chaqiriqni saqlash.

- [ ] **Step 12: Task 2 testlarini GREEN qilish**

Run: `npx vitest run tests/integration/exitCandidateFuzzyMatch.test.ts tests/integration/exitCandidates.test.ts tests/integration/cardPayments.test.ts`

Expected: barcha testlar PASS.

### Task 3: Exit-control report API

**Files:**
- Modify: `src/modules/reports/reports.service.ts`
- Modify: `src/modules/reports/reports.controller.ts`
- Modify: `src/modules/reports/reports.routes.ts`
- Create: `tests/integration/exitControlReport.test.ts`

**Interfaces:**
- Consumes: `env.forcedOpenAvgLossSom`, `resolveOrgIdRequired()` va organization timezone
- Produces: `getExitControlReport(actor, requestedOrgId, from, to)`
- Produces: `GET /api/reports/exit-control?from=YYYY-MM-DD&to=YYYY-MM-DD&org_id=<id>`

- [ ] **Step 1: Report contract va hisob failing testlarini yozish**

`tests/integration/exitControlReport.test.ts`da:

- Response aynan `estimated`, `avg_loss_som`, `from`, `to`, `days`, `totals` top-level maydonlariga ega.
- Kunlar from-to inclusive, o'sish tartibida va bo'sh kunlar nol qiymatlar bilan keladi.
- `COALESCE(resolved_session_id, matched_session_id)` null bo'lsa not found hisoblanadi.
- Resolved session matched sessiondan ustun turadi.
- `emergency_forced_open` forced countga kiradi; ordinary `forced_open` kirmaydi.
- VIP va subscription forced open lossga kirmaydi.
- Regular va noma'lum forced open lossga kiradi.
- Har kun va totals loss `count * 10000` bo'ladi.

- [ ] **Step 2: Report timezone va authorization failing testlarini yozish**

Quyidagilarni assert qilish:

- Asia/Tashkent midnight boundarydagi UTC candidate tegishli lokal kunga tushadi.
- 93 kun ruxsat, 94 kun 400.
- Noto'g'ri yoki incomplete date query 400.
- Operator boshqa org uchun 404.
- Reports permission yo'q operator 403.
- Owner va Super Admin ruxsat oladi.
- Kassir va registrator 403.

- [ ] **Step 3: Report testlarini RED ekanini tekshirish**

Run: `npx vitest run tests/integration/exitControlReport.test.ts`

Expected: route 404 yoki service eksporti mavjud emasligi sabab FAIL.

- [ ] **Step 4: Report service va exact response shape ni implement qilish**

Luxon bilan org timezone date range va UTC query chegaralarini hisoblash. Candidate va `COALESCE` session source ma'lumotlarini bitta bounded query bilan olish, JSda lokal sana bo'yicha bucket qilish va exact contractni yig'ish.

- [ ] **Step 5: Controller va route authorizationni implement qilish**

Controller `from`, `to`, optional `org_id`ni parse qiladi. Route `isAuth`, `isSuperAdminOrOperatorOrOwner`, `checkPermission("reports")` va `asyncHandler` bilan ulanadi.

- [ ] **Step 6: Report testlarini GREEN qilish**

Run: `npx vitest run tests/integration/exitControlReport.test.ts tests/integration/reportAuthorization.test.ts tests/integration/reportRanges.test.ts`

Expected: barcha testlar PASS.

- [ ] **Step 7: Report query EXPLAIN olish**

Current configured DBda report bounded queryining `EXPLAIN` natijasini olish. Yangi index qo'shmaslik; full scan yoki filesort xavfini yakuniy hisobotda alohida qaror sifatida qayd etish.

### Task 4: Stale session cleanup va cron

**Files:**
- Create: `src/modules/maintenance/staleSessionsCleanup.service.ts`
- Create: `src/jobs/staleSessionsCleanupJob.ts`
- Modify: `src/server.ts`
- Create: `tests/integration/staleSessionsCleanup.test.ts`
- Create: `tests/unit/staleSessionsCleanupJob.test.ts`

**Interfaces:**
- Consumes: `env.staleSessionCleanup`, `getOrgTodayRange()`, `findActiveInpatientVehicleForExit()` qoidalari
- Produces: `runStaleSessionsCleanup(): Promise<StaleSessionsCleanupSummary>`
- Produces: `scheduleStaleSessionsCleanupJob(): void`

- [ ] **Step 1: Cleanup eligibility failing testlarini yozish**

`tests/integration/staleSessionsCleanup.test.ts`da default keep-days 2 bilan:

- Cutoffdan oldingi active regular sessiya o'chadi.
- Kecha va bugungi sessiyalar saqlanadi.
- Completed, awaiting_payment, VIP va subscription saqlanadi.
- Boshqa org sessiyasi tegilmaydi.
- Ikki timezone cutoffi mustaqil ishlaydi.

- [ ] **Step 2: Protected session failing testlarini yozish**

Quyidagilarni assert qilish:

- Active statsionar plate saqlanadi.
- `tb_payments` yozuvi bor sessiya saqlanadi.
- Terminal `APPROVED`, `FIN_FAILED`, `ORPHANED` statuslari alohida saqlanadi.
- Boshqa terminal statusi cleanupga to'sqinlik qilmaydi.

- [ ] **Step 3: Delete order va transaction failing testlarini yozish**

Quyidagilarni assert qilish:

- Exit candidate matched yoki resolved relation orqali o'chadi.
- Entry candidate resolved relation orqali o'chadi.
- Webhook event session relation orqali o'chadi.
- Session activity log va terminal operation o'chadi.
- `tb_payment_transactions` va `tb_clinic_discounts` yozuvlari saqlanib session IDlari null bo'ladi.
- Deletable son maxdan oshsa org uchun hech narsa o'chmaydi.
- Bir orgdagi majburiy xato rollback qiladi, keyingi org cleanup davom etadi.
- Birinchi run o'chirgandan keyin ikkinchi run nol o'chiradi.
- Status guard buzilgan target va uning bog'liq yozuvlari saqlanadi.

- [ ] **Step 4: Cleanup testlarini RED ekanini tekshirish**

Run: `npx vitest run tests/integration/staleSessionsCleanup.test.ts`

Expected: service moduli mavjud emasligi sabab FAIL.

- [ ] **Step 5: Cleanup service candidate va protection phase ni implement qilish**

Faol tashkilotlarni olish, `getOrgTodayRange(timezone).start`dan `keepDays - 1` kalendar kun ayirib cutoff yasash, har org transactionida active regular rowsni lock qilish va statsionar/payment/terminal protection setlarini yig'ish.

- [ ] **Step 6: Cleanup delete phase va summary logni implement qilish**

Max guarddan keyin TZ tartibida barcha dependent delete querylarga active regular session existence guardini qo'shish. Per-org rollback isolation, WARN/ERROR loglar va bitta yakuniy summary logni implement qilish.

- [ ] **Step 7: Cleanup integration testlarini GREEN qilish**

Run: `npx vitest run tests/integration/staleSessionsCleanup.test.ts`

Expected: barcha testlar PASS.

- [ ] **Step 8: Cron registration failing testlarini yozish**

`tests/unit/staleSessionsCleanupJob.test.ts`da:

- enabled false bo'lsa `cron.schedule` chaqirilmaydi.
- enabled true bo'lsa configured expression bilan bir marta schedule qilinadi.
- Callback service rejectionini yutadi va `console.error` yozadi.

- [ ] **Step 9: Cron testlarini RED ekanini tekshirish**

Run: `npx vitest run tests/unit/staleSessionsCleanupJob.test.ts`

Expected: job moduli mavjud emasligi sabab FAIL.

- [ ] **Step 10: Cron adapter va server registrationni implement qilish**

`scheduleStaleSessionsCleanupJob()` env false bo'lsa darhol qaytadi; true bo'lsa cron expression bilan callbackni try/catch ichida schedule qiladi. `server.ts` mavjud job registration qatorlari yonida funksiyani chaqiradi.

- [ ] **Step 11: Task 4 testlarini GREEN qilish**

Run: `npx vitest run tests/integration/staleSessionsCleanup.test.ts tests/unit/staleSessionsCleanupJob.test.ts`

Expected: barcha testlar PASS.

### Task 5: To'liq regressiya va yakuniy audit

**Files:**
- Verify: barcha o'zgargan source va test fayllari
- Verify: `docs/superpowers/specs/2026-10-14-exit-control-design.md`
- Verify: `docs/superpowers/plans/2026-10-14-exit-control.md`

**Interfaces:**
- Consumes: Task 1–4 deliverablelari
- Produces: birinchi TZ formatidagi yakuniy hisobot

- [ ] **Step 1: Tor test suite ni qayta bajarish**

Run: `npx vitest run tests/unit/plateMatch.test.ts tests/unit/env.test.ts tests/integration/exitCandidateFuzzyMatch.test.ts tests/integration/exitCandidates.test.ts tests/integration/cardPayments.test.ts tests/integration/exitControlReport.test.ts tests/integration/staleSessionsCleanup.test.ts tests/unit/staleSessionsCleanupJob.test.ts`

Expected: barcha testlar PASS.

- [ ] **Step 2: To'liq test suite ni bajarish**

Run: `npm test`

Expected: barcha mavjud cash, online, card, kamera, LED, Telegram va cron testlari PASS.

- [ ] **Step 3: TypeScript va build tekshiruvlari**

Run: `npm run typecheck`

Run: `npm run typecheck:tests`

Run: `npm run build`

Expected: har biri exit code 0.

- [ ] **Step 4: Lint va diff tekshiruvlari**

Run: `npm run lint`

Run: `git diff --check`

Run: `git status --short`

Run: `git diff --stat`

Expected: lint va diff check exit code 0; faqat rejalashtirilgan fayllar o'zgargan.

- [ ] **Step 5: Requirement-by-requirement audit**

Birinchi TZ bandlari, aniqlashtirishlar, safety boundaries va test ro'yxatini diff va test evidence bilan solishtirish. Bajarilmagan bandlarni sabab bilan ajratish.

- [ ] **Step 6: Fresh whole-change code review**

Subagent mavjud bo'lsa `superpowers:requesting-code-review` bilan butun diffni tekshirtirish. Subagent mavjud bo'lmasa review package asosida alohida self-review o'tkazish va cheklovni yakuniy hisobotda aytish.

- [ ] **Step 7: Yakuniy hisobotni yozish**

Hisobot bo'limlari: 0-band topilmalari va 0.5 SQL natijasi, bajarilgan/bajarilmagan bandlar, API kontraktlari, fayllar, har test PASS/FAIL, TypeScript/build/lint, `git diff --stat`, muhim/o'rta/kichik xavflar. Flag false fuzzy auto-card xatti-harakati va `uploads/parking-events` orphan taklifi aniq yoziladi.
