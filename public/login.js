// Page de connexion : si deja authentifie -> redirige vers l'app ; sinon login.
(async () => {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (r.ok) {
      location.replace('/');
      return;
    }
  } catch {}
})();

const form = document.getElementById('form-login');
const err = document.getElementById('login-err');
const btn = document.getElementById('login-submit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: form.email.value.trim(), password: form.password.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Connexion impossible.');
    location.replace('/');
  } catch (e2) {
    err.textContent = e2.message;
    btn.disabled = false;
  }
});
