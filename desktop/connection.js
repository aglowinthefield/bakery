const form = document.querySelector("form");
const address = document.querySelector("#address");
const allowHttp = document.querySelector("#allow-http");
const button = document.querySelector("button");
const error = document.querySelector("#error");
const status = document.querySelector("#status");

function showError(message) {
  error.textContent = String(message);
  error.hidden = false;
}

function busy(value) {
  address.disabled = value;
  allowHttp.disabled = value;
  button.disabled = value;
  button.textContent = value ? "Connecting…" : "Connect";
}

async function initialize() {
  if (!window.__TAURI__?.core?.invoke) {
    showError("Open this screen in the Bakery desktop app.");
    status.textContent = "";
    return;
  }
  try {
    address.value = await window.__TAURI__.core.invoke("saved_server");
    allowHttp.checked = address.value.startsWith("http://");
  } catch (cause) {
    showError(cause);
  } finally {
    busy(false);
    status.textContent = "";
    address.focus();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  error.hidden = true;
  status.textContent = "Checking your server…";
  busy(true);
  try {
    await window.__TAURI__.core.invoke("connect", {
      address: address.value.trim(),
      allowHttp: allowHttp.checked,
    });
    status.textContent =
      "Bakery is open in its own window. You can return here to change servers.";
  } catch (cause) {
    status.textContent = "";
    showError(cause);
  } finally {
    busy(false);
  }
});

initialize();
