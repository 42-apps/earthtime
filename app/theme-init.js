/* Apply the saved theme before first paint to avoid a flash. Must be an
   external file referenced in <head> — the extension CSP forbids inline
   scripts. Kept tiny and dependency-free on purpose. */
try {
  if (localStorage.getItem('earthtime.theme.v1') === 'light') {
    document.documentElement.dataset.theme = 'light';
  }
} catch (e) {}
