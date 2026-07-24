# Super Admin parolini qo'lda tiklash

Agar yagona Super Admin login/parolini unutsa, tizimda "parolni
unutdim" funksiyasi yo'q (email tizimi yo'q — bu ataylab shunday,
xavfsizlik nuqtai nazaridan). Yagona yechim — serverga to'g'ridan-
to'g'ri kirib, database orqali parolni qo'lda yangilash.

## Nima uchun bunday

Bu — ataylab qilingan xavfsizlik chorasi: faqat serverga
jismoniy/SSH kirish huquqiga ega shaxs (loyiha egasi) Super Admin
parolini tiklay oladi. Bu eng yuqori darajadagi ruxsat bo'lgani
uchun, uni email/SMS orqali tiklash imkoniyati ataylab yo'q
qilingan — aks holda bu eng zaif nuqtaga aylanardi.

## Qadamlar

### 1. Serverga SSH orqali ulaning

```bash
ssh root@SIZNING_SERVER_IP
```

### 2. Yangi parolni hash qiling

Loyiha papkasida (s-backend), Node.js orqali:

```bash
cd /var/www/s-backend
node -e "console.log(require('bcrypt').hashSync('yangi_parolingiz', 10))"
```

Bu buyruq ekranga uzun, shifrlangan qatorni chiqaradi — masalan:
```
$2b$10$abcdefghijklmnopqrstuv.wxyzABCDEFGHIJKLMNOPQRSTUVWXYZ
```

Shu qatorni to'liq nusxalab oling.

### 3. MySQL ga kiring

```bash
mysql -u <db_user> -p
```

Parolni so'raganda, `.env` faylidagi `DB_PASSWORD` ni kiriting.

### 4. Bazani tanlang

```sql
USE stoyanka_db;
```

### 5. Parolni yangilang

2-qadamda olingan hash qiymatini qo'ying:

```sql
UPDATE tb_users
SET password = '$2b$10$abcdefghijklmnopqrstuv.wxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
WHERE login = 'admin' AND role = 'super_admin';
```

### 6. Tekshiring

```sql
SELECT id, login, role FROM tb_users WHERE role = 'super_admin';
```

Bu — o'zgartirilgan foydalanuvchi haqiqatan `super_admin`
ekanligini tasdiqlaydi.

### 7. Chiqing va sinab ko'ring

```sql
EXIT;
```

Endi `admin` / `yangi_parolingiz` bilan tizimga kirishga urinib
ko'ring.

## Muhim eslatmalar

- Bcrypt hash yaratishda ishlatilgan versiya loyihada
  o'rnatilgan `bcrypt` paketining o'zi bo'lishi shart —
  boshqa onlayn "bcrypt generator" saytlaridan foydalanmang,
  ular boshqa "salt rounds" bilan ishlashi mumkin.
- Parolni tiklagandan keyin, agar operator hisoblari uchun ham
  shunga o'xshash ehtiyoj tug'ilsa — buni Admin panel orqali
  ("Parolni tiklash" tugmasi) amalga oshirish mumkin, faqat
  Super Admin uchun bu qo'lda usul kerak bo'ladi.
- Bu amaliyotni kamdan-kam, faqat zarurat tug'ilganda
  qo'llang — har safar database ga to'g'ridan-to'g'ri kirish
  xavf tug'diradi, ehtiyot bo'ling.
