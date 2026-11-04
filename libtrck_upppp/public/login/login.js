'use strict';

const existingUser = getStoredUser();
if (getToken() && existingUser) {
  window.location.href = existingUser.role === 'librarian' ? '/librarian/dashboard.html' : '/student/dashboard.html';
}

const form = document.getElementById('loginForm');
const button = document.getElementById('loginButton');
const message = document.getElementById('loginMessage');

// Keep the login form intentionally blank. This avoids the old demo/autofill look.
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
function clearLoginFields() {
  usernameInput.value = '';
  passwordInput.value = '';
}
clearLoginFields();
window.addEventListener('pageshow', clearLoginFields);
window.setTimeout(clearLoginFields, 80);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  message.classList.remove('success');
  button.disabled = true;
  button.textContent = 'Logging in...';

  try {
    const data = await apiFetch('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: usernameInput.value.trim(),
        password: passwordInput.value
      })
    });
    saveSession(data.token, data.user);
    window.location.href = data.user.role === 'librarian' ? '/librarian/dashboard.html' : '/student/dashboard.html';
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Log in';
  }
});