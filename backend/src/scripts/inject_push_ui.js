import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const indexPath = path.resolve(__dirname, '../../../frontend/index.html');
let html = fs.readFileSync(indexPath, 'utf8');

const nativeAlertsPanelHtml = `
<section class="panel" id="nativeAlertsPanel" aria-label="Native Mobile Push Alerts & Notification Sounds" style="border-left: 3px solid #238636; background: rgba(35, 134, 54, 0.04);">
  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
    <h2 class="metrics-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
      <span>🔔 Native Push Notifications</span>
      <span id="pushStatusBadge" style="font-size: 11px; padding: 2px 8px; border-radius: 12px; background: rgba(35, 134, 54, 0.2); color: #3fb950; font-weight: 600;">Active</span>
    </h2>
    <label style="position: relative; display: inline-flex; align-items: center; cursor: pointer; gap: 8px;">
      <input type="checkbox" id="togglePushAlerts" checked style="accent-color: #238636; width: 18px; height: 18px; cursor: pointer;">
      <span style="font-size: 12px; font-weight: 600; color: #c9d1d9;">Enabled</span>
    </label>
  </div>
  <p class="rs-note" style="margin-bottom: 14px; line-height: 1.45;">
    Standalone Android notification engine with native hardware sound channels. Receives 24/7 strangle alerts, IV spikes, and risk barrier triggers without needing any third-party app.
  </p>

  <div style="margin-bottom: 14px;">
    <label class="field" style="display: block; margin-bottom: 8px;">
      <span style="font-size: 12px; color: var(--text-muted, #8b949e); margin-bottom: 6px; display: block;">Notification Sound Tone</span>
      <div style="display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;">
        <select id="pushSoundSelect" style="width: 100%; padding: 8px 12px; border-radius: 6px; background: rgba(22, 27, 34, 0.9); border: 1px solid rgba(48, 54, 61, 0.8); color: #c9d1d9; font-size: 13px;">
          <option value="chime">🔔 Chime (Clean Bell Tone)</option>
          <option value="radar">📡 Radar (Urgent Options Alert)</option>
          <option value="urgent">⚡ Urgent Pulse (High Priority)</option>
          <option value="cash">💰 Cash Register (Profit / Fill)</option>
          <option value="default">🎵 Android System Default</option>
        </select>
        <button id="btnPlaySoundPreview" class="btn" type="button" style="padding: 8px 14px; white-space: nowrap; font-size: 12px;" title="Listen to sound preview">
          ▶ Test Tone
        </button>
      </div>
    </label>
  </div>

  <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: space-between; border-top: 1px solid rgba(48, 54, 61, 0.4); padding-top: 10px;">
    <div style="display: flex; gap: 8px;">
      <button id="btnTriggerTestPush" class="btn primary" type="button" style="font-size: 12px; padding: 6px 14px;">
        🚀 Send Test Alert
      </button>
      <button id="btnRequestPushPerm" class="btn" type="button" style="font-size: 12px; padding: 6px 14px;">
        🛡 Permissions
      </button>
    </div>
    <span id="pushDeviceTokenStatus" style="font-size: 11px; color: #8b949e;">Local & FCM Dispatch Ready</span>
  </div>
</section>
`;

if (!html.includes('id="nativeAlertsPanel"')) {
  html = html.replace(
    '</section>\n<section class="panel" id="resetPanel"',
    '</section>\n' + nativeAlertsPanelHtml + '\n<section class="panel" id="resetPanel"'
  );
  console.log('Injected nativeAlertsPanel into pgSettings.');
}

if (!html.includes('src="/src/push-manager.ts"')) {
  html = html.replace(
    '</head>',
    '<script type="module" src="/src/push-manager.ts"></script>\n</head>'
  );
  console.log('Injected push-manager.ts script into <head>.');
}

fs.writeFileSync(indexPath, html, 'utf8');
console.log('Successfully updated frontend/index.html with Native Push Notifications & Sound Settings!');
