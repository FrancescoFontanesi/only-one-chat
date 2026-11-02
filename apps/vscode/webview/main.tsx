import { render } from 'preact';
import { App } from './App.js';
import { MonitorApp } from './Monitor.js';
import { RolesApp } from './Roles.js';
import { SettingsApp } from './Settings.js';
import { UsageApp } from './Usage.js';

// One bundle for the chat and the side views: the host says which one this is.
const root = document.getElementById('root');
if (root) {
  const kind = root.dataset['view'];
  const View =
    kind === 'usage'
      ? UsageApp
      : kind === 'roles'
        ? RolesApp
        : kind === 'settings'
          ? SettingsApp
          : kind === 'monitor'
            ? MonitorApp
            : App;
  render(<View />, root);
}
