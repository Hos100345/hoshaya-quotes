// Service worker — הושעיה אמן בלונים
// העלה את המספר בכל שינוי שצריך לנקות מטמון ישן.
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;

// רק נכסים שמשתנים לעיתים רחוקות. ה-HTML עצמו לא נכנס לכאן בכוונה.
const ASSETS = [
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // צד שלישי — דרייב, Supabase, ה-Worker, גופנים: אף פעם לא דרך המטמון שלנו.
  if (url.origin !== self.location.origin) return;

  // ניווט: רשת קודם. אחרת פריסה חדשה הייתה מוגשת מגרסה ישנה —
  // בדיוק התקלה שרדפה אותנו בבילדים של Pages.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put('./', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./').then(r => r || Response.error()))
    );
    return;
  }

  // נכסים סטטיים: מטמון קודם, ורענון ברקע.
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
