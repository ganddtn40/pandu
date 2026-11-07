const STORAGE_KEY = 'cockpit.desktop.daemonUrl.v1';
const DEFAULT_URL = 'http://127.0.0.1:4319';
const HEALTH_TIMEOUT_MS = 2_500;
const HEALTH_POLL_MS = 15_000;

export function normalizeDaemonUrl(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isCockpitHealth(payload) {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    payload.service === 'cockpit-daemon' &&
    payload.ok === true
  );
}

export async function probeDaemon(baseUrl, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/api/health`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The daemon answered HTTP ${response.status}.`);
  const payload = await response.json();
  if (!isCockpitHealth(payload)) {
    throw new Error('That address is not a Cockpit daemon.');
  }
  return payload;
}

function init() {
  const form = document.getElementById('connect-form');
  const input = document.getElementById('daemon-url');
  const connectButton = document.getElementById('connect-button');
  const pairButton = document.getElementById('pair-button');
  const errorBox = document.getElementById('launcher-error');
  const launcher = document.getElementById('launcher');
  const dashboard = document.getElementById('dashboard');
  const frame = document.getElementById('dashboard-frame');
  const dashboardUrl = document.getElementById('dashboard-url');
  const reloadButton = document.getElementById('reload-button');
  const homeButton = document.getElementById('home-button');
  const connection = document.getElementById('connection');
  const connectionLabel = document.getElementById('connection-label');

  if (
    !form ||
    !input ||
    !connectButton ||
    !pairButton ||
    !errorBox ||
    !launcher ||
    !dashboard ||
    !frame ||
    !dashboardUrl ||
    !reloadButton ||
    !homeButton ||
    !connection ||
    !connectionLabel
  ) {
    return;
  }

  let connectedUrl = null;
  let pollTimer = undefined;

  const setConnection = (state, label) => {
    connection.dataset.state = state;
    connectionLabel.textContent = label;
  };

  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
  };

  const clearError = () => {
    errorBox.textContent = '';
    errorBox.hidden = true;
  };

  const stopPolling = () => {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const poll = async () => {
    if (!connectedUrl) return;
    try {
      await probeDaemon(connectedUrl);
      setConnection('live', 'Daemon reachable');
    } catch {
      setConnection('down', 'Daemon unreachable');
    }
  };

  const startPolling = () => {
    stopPolling();
    pollTimer = window.setInterval(() => void poll(), HEALTH_POLL_MS);
  };

  const showLauncher = () => {
    stopPolling();
    connectedUrl = null;
    frame.src = 'about:blank';
    dashboard.hidden = true;
    launcher.hidden = false;
    setConnection('idle', 'Not connected');
    input.value = input.value.trim() || DEFAULT_URL;
    input.focus();
    input.select();
  };

  const openDashboard = async (baseUrl, path = '/', options = {}) => {
    connectButton.disabled = true;
    connectButton.textContent = 'Checking…';
    clearError();

    try {
      await probeDaemon(baseUrl);
      connectedUrl = baseUrl;
      try {
        window.localStorage.setItem(STORAGE_KEY, baseUrl);
      } catch {
        // Private mode or a locked-down webview: the app still works this session.
      }
      frame.src = `${baseUrl}${path}`;
      dashboardUrl.textContent = `${baseUrl}${path === '/' ? '' : path}`;
      launcher.hidden = true;
      dashboard.hidden = false;
      setConnection('live', 'Daemon reachable');
      startPolling();
    } catch (error) {
      setConnection('down', 'Daemon unreachable');
      const message =
        error instanceof Error && error.message === 'That address is not a Cockpit daemon.'
          ? error.message
          : `Cockpit could not reach a daemon at ${baseUrl}.`;
      showError(
        options.silent
          ? `${message} Start it with \`cockpit start\` when you are ready.`
          : `${message} Start it with \`cockpit start\`, then check the address and try again.`,
      );
    } finally {
      connectButton.disabled = false;
      connectButton.textContent = 'Open dashboard';
    }
  };

  const currentUrl = () => normalizeDaemonUrl(input.value);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const baseUrl = currentUrl();
    if (!baseUrl) {
      showError('Enter a valid http or https daemon URL.');
      input.focus();
      return;
    }
    void openDashboard(baseUrl);
  });

  pairButton.addEventListener('click', () => {
    const baseUrl = currentUrl();
    if (!baseUrl) {
      showError('Enter a valid http or https daemon URL.');
      input.focus();
      return;
    }
    void openDashboard(baseUrl, '/pair');
  });

  reloadButton.addEventListener('click', () => {
    if (!connectedUrl) return;
    const target = frame.src;
    frame.src = 'about:blank';
    window.setTimeout(() => {
      frame.src = target;
    }, 50);
  });

  homeButton.addEventListener('click', showLauncher);

  input.addEventListener('input', () => {
    clearError();
    pairButton.disabled = currentUrl() === null;
  });

  let stored;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_URL;
  } catch {
    stored = DEFAULT_URL;
  }
  input.value = normalizeDaemonUrl(stored) ?? DEFAULT_URL;
  pairButton.disabled = currentUrl() === null;

  void openDashboard(input.value, '/', { silent: true });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
