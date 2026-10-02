/*
 * Sign-in screen: the show / hide button on the password. The form itself needs no script (it posts to /login);
 * the button is hidden in the markup and appears only once this file has run.
 */
(function () {
  'use strict';
  var input = document.getElementById('lg-password');
  var eye = document.getElementById('lg-eye');
  if (!input || !eye) return;
  eye.hidden = false;
  eye.addEventListener('click', function () {
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', show ? 'true' : 'false');
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    eye.title = show ? 'Hide password' : 'Show password';
    input.focus();
  });
})();
