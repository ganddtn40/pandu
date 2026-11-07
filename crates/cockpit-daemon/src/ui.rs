use axum::response::Html;

/// Phase 1 placeholder. The real glass UI is built in Phase 4 and embedded with
/// rust-embed; this page exists so the daemon is usable the moment it starts.
const PLACEHOLDER: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cockpit</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 32px;
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #f4f6fb;
    background:
      radial-gradient(1100px 700px at 15% -10%, #33415c 0%, transparent 60%),
      radial-gradient(900px 600px at 95% 10%, #2a4b52 0%, transparent 55%),
      #0b0f16;
  }
  main {
    width: min(680px, 100%);
    padding: 40px;
    border-radius: 28px;
    border: 1px solid rgba(255,255,255,.16);
    background: linear-gradient(150deg, rgba(255,255,255,.12), rgba(255,255,255,.04));
    box-shadow: 0 30px 80px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.22);
    backdrop-filter: blur(28px) saturate(140%);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,.16);
    background: rgba(255,255,255,.06);
    font-size: 13px;
    letter-spacing: .01em;
    color: #cdd6e6;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #5be3a5; box-shadow: 0 0 12px #5be3a5; }
  h1 { margin: 24px 0 12px; font-size: clamp(30px, 5vw, 44px); line-height: 1.08; letter-spacing: -.03em; font-weight: 600; }
  p { margin: 0 0 22px; color: #b9c3d4; max-width: 52ch; }
  ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
  li { display: flex; justify-content: space-between; gap: 16px; padding: 12px 16px; border-radius: 14px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); }
  code { font: 13px/1.4 ui-monospace, "SF Mono", Consolas, monospace; color: #e6edf7; }
  a { color: #9fd4ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .hint { margin-top: 22px; font-size: 13px; color: #8d99ad; }
</style>
</head>
<body>
<main>
  <span class="badge"><span class="dot"></span> Daemon ready</span>
  <h1>Cockpit is recording.</h1>
  <p>The local proxy, SQLite store, and live event bus are running. The glass workspace arrives in Phase 4; every API this page links to already works.</p>
  <ul>
    <li><span>Health</span><a href="/api/health">/api/health</a></li>
    <li><span>Overview</span><a href="/api/overview">/api/overview</a></li>
    <li><span>Flights</span><a href="/api/sessions">/api/sessions</a></li>
    <li><span>Live events</span><code>/api/live</code></li>
  </ul>
  <p class="hint">Point an agent at <code>http://127.0.0.1:4319/v1</code>, or POST <code>/api/demo/seed</code> to try demo flights.</p>
</main>
</body>
</html>
"#;

pub async fn index() -> Html<&'static str> {
    Html(PLACEHOLDER)
}
