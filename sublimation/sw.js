// שירות מינימלי כדי שהדפדפן יאפשר התקנה. לא שומר נתונים ולא מטמון של המלאי.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',()=>{});
