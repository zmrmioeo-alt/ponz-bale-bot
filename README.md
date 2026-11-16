# بات پونز برای بله

نسخه فعلی بات روی **Supabase Edge Functions** اجرا می‌شود؛ برای اجرای آن به Render یا سرور Python جداگانه نیاز نیست.

## معماری
- دریافت پیام‌های بله از طریق webhook
- پردازش پیام‌ها در Edge Function با نام `ponz-bale-webhook`
- ذخیره کاربران، حضور و غیاب، موارد انضباطی و نشست‌ها در PostgreSQL پروژه Supabase
- کنترل دسترسی مدیر اصلی، مسئول ثبت و عضو
- جلوگیری از پردازش دوباره updateهای تکراری

## راه‌اندازی
1. پروژه Supabase: https://supabase.com/dashboard/project/mqdpffnuvvtretxtxfwc
2. در بخش Edge Function Secrets این دو مقدار را اضافه کنید:
   - `BALE_BOT_TOKEN`: توکن محرمانه بات بله
   - `BALE_WEBHOOK_SECRET`: یک رشته تصادفی و طولانی که فقط نزد مدیر بات بماند
3. تابع `ponz-bale-webhook` را با متد POST و بدنه زیر از بخش Test در داشبورد فراخوانی کنید. هدر `x-ponz-setup-secret` باید دقیقاً برابر مقدار `BALE_WEBHOOK_SECRET` باشد:
   ```json
   {"action":"register_webhook"}
   ```
4. پاسخ موفق باید شامل `"registered": true` باشد.
5. در بله به بات پیام `/start` بدهید.

آدرس تابع:
`https://mqdpffnuvvtretxtxfwc.supabase.co/functions/v1/ponz-bale-webhook`

## نکات امنیتی
- توکن بات و کلیدهای Supabase را در GitHub یا چت قرار ندهید.
- تابع برای دریافت webhook، بررسی secret انجام می‌دهد؛ JWT بررسی نمی‌شود چون درخواست از سمت بله می‌آید.
- RLS جداول خاموش نشده است؛ تابع با کلید سروری Supabase به جداول دسترسی دارد.
- شناسه عددی بله پس از اولین پیام کاربر ثبت می‌شود. چهار نام کاربری اولیه مدیر در کد bootstrap تعریف شده‌اند:
  `me_god_me`, `alireza_xri`, `taha1291mani`, `kian_sa`.

## فایل‌های قدیمی
`main.py` نسخه قدیمی polling است و دیگر نقطه اجرای فعال بات نیست. نسخه فعال در `supabase/functions/ponz-bale-webhook/index.ts` قرار دارد.
