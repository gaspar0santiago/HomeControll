(function () {
  const DASHBOARD_URL = 'http://192.168.68.57:3000/';

  function addHomeButton() {
    if (document.getElementById('dashboard-home-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'dashboard-home-btn';
    btn.innerHTML = '&#8962; Go back to Home';
    btn.title = 'Back to Home';
    btn.addEventListener('click', () => {
      window.location.href = DASHBOARD_URL;
    });

    document.body.appendChild(btn);
  }

  addHomeButton();

  // Spotify is a SPA, re-add the button if it gets removed on navigation
  const observer = new MutationObserver(() => addHomeButton());
  observer.observe(document.body, { childList: true, subtree: false });
})();
