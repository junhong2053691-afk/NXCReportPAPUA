const form = document.getElementById("login-form");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const passwordToggle = document.getElementById("password-toggle");
const submitButton = document.getElementById("login-submit");
const errorElement = document.getElementById("error");

const captchaModal = document.getElementById("captcha-modal");
const captchaStage = document.getElementById("captcha-stage");
const captchaImage = document.getElementById("captcha-img");
const captchaHint = document.getElementById("captcha-hint");
const captchaTrack = document.getElementById("captcha-track");
const captchaFill = document.getElementById("captcha-fill");
const captchaThumb = document.getElementById("captcha-thumb");
const captchaClose = document.getElementById("captcha-close");
const captchaRefresh = document.getElementById("captcha-refresh");

const HINT_DEFAULT = "拖动滑块，让手指朝上"; // 拖动滑块，让手指朝上
const KEY_STEP_DEG = 3;

let captchaId = "";
let rotation = 0;
let dragging = null; // { pointerId, startX, startRotation }
let busy = false; // 取图或提交中：滑块不响应
let loadSeq = 0;

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
  submitButton.querySelector(".btn-label").textContent = on ? "正在登录..." : "登录";
}

function showError(message) {
  errorElement.textContent = message;
  errorElement.hidden = false;
}

passwordToggle.addEventListener("click", function () {
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  passwordToggle.setAttribute("aria-pressed", String(show));
  passwordToggle.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
  passwordToggle.innerHTML = '<i data-lucide="' + (show ? "eye-off" : "eye") + '"></i><span class="icon-fallback" aria-hidden="true">' + (show ? "Hide" : "Show") + "</span>";
  renderLoginIcons();
  passwordInput.focus();
});

// ---- 旋转验证弹窗 ----

function trackRange() {
  return Math.max(1, captchaTrack.clientWidth - captchaThumb.offsetWidth);
}

function setRotation(deg) {
  rotation = Math.min(360, Math.max(0, deg));
  const x = (rotation / 360) * trackRange();
  captchaThumb.style.transform = "translateX(" + x + "px)";
  captchaFill.style.width = x + captchaThumb.offsetWidth / 2 + "px";
  captchaImage.style.transform = "rotate(" + rotation + "deg)";
  captchaThumb.setAttribute("aria-valuenow", String(Math.round(rotation)));
}

function setHint(text, state) {
  captchaHint.textContent = text;
  captchaHint.classList.toggle("is-error", state === "error");
  captchaHint.classList.toggle("is-ok", state === "ok");
}

function setBusy(on) {
  busy = on;
  captchaStage.classList.toggle("is-loading", on);
  captchaThumb.disabled = on;
  captchaRefresh.disabled = on;
}

// 服务端每道题只认一次（对错都作废），所以每次失败后都要重新取。
async function loadCaptcha() {
  const seq = ++loadSeq;
  captchaId = "";
  setBusy(true);
  setRotation(0);
  captchaStage.classList.remove("is-failed");
  try {
    const response = await fetch("/api/auth/captcha", { cache: "no-store" });
    const data = await response.json().catch(function () { return {}; });
    if (seq !== loadSeq) return;
    if (!response.ok || !data.id || !data.image) {
      throw new Error(data.error || "图片加载失败，请换一张"); // 图片加载失败，请换一张
    }
    captchaImage.src = data.image;
    captchaId = data.id;
    setHint(HINT_DEFAULT);
    setBusy(false);
    captchaThumb.focus();
  } catch (error) {
    if (seq !== loadSeq) return;
    captchaImage.removeAttribute("src");
    setHint(error.message, "error");
    setBusy(false);
    captchaThumb.disabled = true;
  }
}

function isCaptchaOpen() {
  return captchaModal.classList.contains("show");
}

function openCaptcha() {
  captchaModal.classList.add("show");
  captchaModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  loadCaptcha();
}

function closeCaptcha() {
  loadSeq += 1; // 作废还在路上的取图
  dragging = null;
  captchaId = "";
  captchaModal.classList.remove("show");
  captchaModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  setBusy(false);
}

async function submitLogin() {
  if (busy || !captchaId) return;
  setBusy(true);
  setSubmitting(true);
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: usernameInput.value.trim(),
        password: passwordInput.value,
        captchaId: captchaId,
        captchaAngle: Math.round(rotation * 10) / 10,
      }),
    });
    const data = await response.json().catch(function () { return {}; });
    if (response.ok) {
      setHint("验证通过", "ok"); // 验证通过
      window.location.href = "/";
      return;
    }
    if (data.captcha) {
      // 角度不对：留在弹窗里，抖一下再换一张。
      setHint(data.error || "验证失败，请再试一次", "error");
      captchaStage.classList.add("is-failed");
      setTimeout(function () {
        if (!isCaptchaOpen()) return;
        loadCaptcha().then(function () {
          setHint(data.error || "验证失败，请再试一次", "error");
        });
      }, 700);
      return;
    }
    throw new Error(data.error || "登录失败");
  } catch (error) {
    closeCaptcha();
    showError(error.message || "登录失败，请重试");
    passwordInput.focus();
    passwordInput.select();
  } finally {
    // 成功时保持 busy 直到跳转；验证失败由 loadCaptcha 解锁；其他错误 closeCaptcha 已解锁。
    setSubmitting(false);
  }
}

captchaTrack.addEventListener("pointerdown", function (event) {
  if (busy || !captchaId || event.button > 0) return;
  event.preventDefault();
  // 点在轨道上（不是滑块）时，滑块先跳到手指下面再开始拖。
  if (event.target !== captchaThumb && !captchaThumb.contains(event.target)) {
    const rect = captchaTrack.getBoundingClientRect();
    const x = event.clientX - rect.left - captchaThumb.offsetWidth / 2;
    setRotation((x / trackRange()) * 360);
  }
  dragging = { pointerId: event.pointerId, startX: event.clientX, startRotation: rotation };
  captchaTrack.setPointerCapture(event.pointerId);
  captchaTrack.classList.add("is-dragging");
  captchaThumb.focus();
});

captchaTrack.addEventListener("pointermove", function (event) {
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  const dx = event.clientX - dragging.startX;
  setRotation(dragging.startRotation + (dx / trackRange()) * 360);
});

function endDrag(event, submit) {
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  dragging = null;
  captchaTrack.classList.remove("is-dragging");
  if (captchaTrack.hasPointerCapture(event.pointerId)) captchaTrack.releasePointerCapture(event.pointerId);
  if (submit && rotation > 0) submitLogin();
}

captchaTrack.addEventListener("pointerup", function (event) { endDrag(event, true); });
captchaTrack.addEventListener("pointercancel", function (event) { endDrag(event, false); });

captchaThumb.addEventListener("keydown", function (event) {
  if (busy) return;
  const steps = {
    ArrowRight: KEY_STEP_DEG,
    ArrowUp: KEY_STEP_DEG,
    ArrowLeft: -KEY_STEP_DEG,
    ArrowDown: -KEY_STEP_DEG,
    PageUp: 30,
    PageDown: -30,
  };
  if (event.key in steps) {
    event.preventDefault();
    setRotation(rotation + steps[event.key]);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    setRotation(event.key === "Home" ? 0 : 360);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (rotation > 0) submitLogin();
  }
});

captchaRefresh.addEventListener("click", function () {
  if (!busy) loadCaptcha();
});
captchaClose.addEventListener("click", function () {
  closeCaptcha();
  submitButton.focus();
});

captchaModal.addEventListener("keydown", function (event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeCaptcha();
    submitButton.focus();
    return;
  }
  // 焦点留在弹窗里：Tab 在关闭 / 滑块 / 换一张之间循环。
  if (event.key === "Tab") {
    const items = [captchaClose, captchaThumb, captchaRefresh].filter(function (el) { return !el.disabled; });
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = event.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
    event.preventDefault();
    items[next].focus();
  }
});

// 窗口宽度变了（手机横竖屏）滑块位置按比例重算。
window.addEventListener("resize", function () {
  if (isCaptchaOpen()) setRotation(rotation);
});

form.addEventListener("submit", function (event) {
  event.preventDefault();
  errorElement.hidden = true;

  if (!usernameInput.value.trim()) {
    showError("请输入账号 ID");
    usernameInput.focus();
    return;
  }
  if (!passwordInput.value) {
    showError("请输入密码");
    passwordInput.focus();
    return;
  }
  openCaptcha();
});

renderLoginIcons();
