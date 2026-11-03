import { render } from 'preact';
import { App } from './App.js';
import { SettingsApp } from './Settings.js';

// One bundle for the chat and the settings page: the host says which one this is.
const root = document.getElementById('root');
if (root) {
  const View = root.dataset['view'] === 'settings' ? SettingsApp : App;
  render(<View />, root);
}
