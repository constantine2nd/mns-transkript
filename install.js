// "Instaliraj": Chrome and Edge announce that the page can be installed as an app with beforeinstallprompt,
// possibly before the app's module code runs. This plain script loads first and keeps that event until the
// button uses it. Safari has no such event: the iPhone/iPad adds apps from Share → Add to Home Screen, so a
// hint is shown there instead. Firefox on the desktop cannot install web apps at all.
(function () {
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  self.pwaInstall = { event: null, standalone: standalone() };
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // our own button asks instead of the browser's mini bar
    self.pwaInstall.event = e;
    window.dispatchEvent(new Event('pwa-installable'));
  });
  window.addEventListener('appinstalled', () => {
    self.pwaInstall.event = null;
    self.pwaInstall.standalone = true;
    window.dispatchEvent(new Event('pwa-installed'));
  });
})();
