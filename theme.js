// Light or dark: the user's choice (prefs.theme: "system", "light", "dark"), else the system's. Loaded in <head>
// before the page is drawn, so a dark choice never flashes light first. app.js changes it through self.setTheme.
(function () {
  const KEY = 'mns-transkript-prefs';
  let pref = 'system';
  try { pref = JSON.parse(localStorage.getItem(KEY) || '{}').theme || 'system'; } catch { /* private mode */ }
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const dark = pref === 'dark' || (pref === 'system' && mq.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    self.dispatchEvent(new Event('themechange'));
  };
  self.themePref = () => pref;
  self.isDark = () => document.documentElement.dataset.theme === 'dark';
  self.setTheme = (p) => { pref = p; apply(); };
  mq.addEventListener('change', () => { if (pref === 'system') apply(); });
  apply();
})();
