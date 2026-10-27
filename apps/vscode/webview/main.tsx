import { render } from 'preact';
import { App } from './App.js';
import { UsageApp } from './Usage.js';

// One bundle for both webviews: the host says which one this is.
const root = document.getElementById('root');
if (root) render(root.dataset['view'] === 'usage' ? <UsageApp /> : <App />, root);
