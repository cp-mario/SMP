import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { applyStoredAccent } from './lib/theme.js'

// Paint the saved accent before the first render (no purple flash).
applyStoredAccent()

const app = mount(App, {
  target: document.getElementById('app'),
})

export default app