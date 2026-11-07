const form = document.getElementById("login-form");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const passwordToggle = document.getElementById("password-toggle");
const submitButton = document.getElementById("login-submit");
const errorElement = document.getElementById("error");

function renderLoginIcons() {
  if (!window.lucide || typeof window.lucide.createIcons !== "function") return;
  try {
    window.lucide.createIcons({
      attrs: { "stroke-width": 1.8, "aria-hidden": "true" },
      nameAttr: "data-lucide",
    });
    // Same contract as app.js renderIcons: hides the text fallbacks ("Show").
    document.documentElement.classList.add("lucide-ready");
  } catch (e) {
    document.documentElement.classList.remove("lucide-ready");
  }
}

function setSubmitting(on) {
  submitButton.disabled = on;
  form.setAttribute("aria-busy", on ? "true" : "false");
  submitButton.classList.toggle("is-loading", on);
  submitButton.querySelector(".btn-label").textContent = on ? "\u6b63\u5728\u767b\u5f55..." : "\u767b\u5f55";
}

function showError(message) {
  errorElement.textContent = message;
  errorElement.hidden = false;
}

passwordToggle.addEventListener("click", function () {
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  passwordToggle.setAttribute("aria-pressed", String(show));
  passwordToggle.setAttribute("aria-label", show ? "\u9690\u85cf\u5bc6\u7801" : "\u663e\u793a\u5bc6\u7801");
  passwordToggle.innerHTML = '<i data-lucide="' + (show ? "eye-off" : "eye") + '"></i><span class="icon-fallback" aria-hidden="true">' + (show ? "Hide" : "Show") + "</span>";
  renderLoginIcons();
  passwordInput.focus();
});

form.addEventListener("submit", async function (event) {
  event.preventDefault();
  errorElement.hidden = true;

  if (!usernameInput.value.trim()) {
    showError("\u8bf7\u8f93\u5165\u8d26\u53f7 ID");
    usernameInput.focus();
    return;
  }
  if (!passwordInput.value) {
    showError("\u8bf7\u8f93\u5165\u5bc6\u7801");
    passwordInput.focus();
    return;
  }

  setSubmitting(true);
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: usernameInput.value.trim(),
        password: passwordInput.value,
      }),
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || "\u767b\u5f55\u5931\u8d25");
    window.location.href = "/";
  } catch (error) {
    showError(error.message || "\u767b\u5f55\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5");
    passwordInput.focus();
    passwordInput.select();
  } finally {
    setSubmitting(false);
  }
});

renderLoginIcons();
