// Service worker : rend l'app installable, affiche les notifications push du serveur, ouvre l'app au clic.
// Les données ne sont jamais mises en cache (toujours en direct depuis le serveur).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Pulse", {
    body: d.body || "", icon: "icon-192.png", badge: "icon-192.png", tag: d.tag, renotify: !!d.tag, vibrate: [40, 60, 40], data: { url: d.url || "./" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow(e.notification.data?.url || "./");
    })
  );
});
