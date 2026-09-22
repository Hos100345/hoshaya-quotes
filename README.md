# הושעיה אמן בלונים — מערכת ניהול

אפליקציה חד-קובצית (`index.html`) — קטלוג עיצובים, העלאת תמונות, הצעות מחיר, רישום לקוחות וניהול מלאי.

**חי ב:** https://hos100345.github.io/hoshaya-quotes/ (GitHub Pages מ-`main`)

## מבנה
- `index.html` — האפליקציה כולה. ללא build step, ללא framework.
- `worker.js` — Cloudflare Worker. מחזיק את מפתחות Gemini ו-Morning בצד שרת ומספק CORS.

## Worker — נקודות קצה
| נתיב | שימוש באפליקציה |
|---|---|
| `POST /gemini` | ניתוח שיחת וואטסאפ, ייבוא רשימת מלאי |
| `POST /gemini-vision` | זיהוי קטגוריה אוטומטי לתמונה שמועלית לקטלוג |
| `POST /gemini-audio` | תמלול הקלטת שיחה → הצעת מחיר |
| `POST /morning` | הפקת דרישת תשלום |

⚠️ **ה-Worker לא נפרס מגיט.** שינוי ב-`worker.js` דורש deploy ידני ב-Cloudflare.
Secrets נדרשים שם: `GEMINI_KEY`, `MORNING_ID`, `MORNING_SECRET`.

## מלאי — Supabase הוא מקור האמת
המלאי נקרא ונכתב מול `inventory.items` בפרויקט `sccivxenkyzxolpraexf`.
**localStorage לא משמש למלאי.** כל פלוס/מינוס, הוספה, עריכה וייבוא נכתבים לשרת.

- כניסה: Supabase Auth, קישור למייל. הגישה נעולה ב-RLS על `hoshaya@gmail.com` בלבד.
- קטגוריות: לטקס / מיילר / טוויסטינג / הליום / אביזרים / אחר — נאכף ב-CHECK על הטבלה.
- כל שינוי כמות נרשם אוטומטית ב-`inventory.movements` ע"י טריגר.
  האפליקציה כותבת `updated_by='אפליקציה'`, והטריגר לוקח משם את `source`.
- הקטלוג (תמונות) עדיין ב-localStorage — הוא לא חלק מהמעבר הזה.

"📥 ייבוא" מקבל רשימה חופשית (AI מסדר) או JSON מוכן, ותמיד מציג אישור לפני שכותב לשרת.
"📤 העתק את המלאי הנוכחי" מייצא JSON שאפשר לשלוח ולקבל בחזרה מעודכן.
