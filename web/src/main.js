import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { applyStoredAccent, applyStoredTheme } from './lib/theme.js'

// Paint the saved accent and theme before the first render (no flash).
applyStoredAccent()
applyStoredTheme()

const app = mount(App, {
  target: document.getElementById('app'),
})

export default app