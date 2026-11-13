<script>
  import { onMount, onDestroy } from 'svelte';
  import hljs from 'highlight.js/lib/core';
  import javascript from 'highlight.js/lib/languages/javascript';
  import typescript from 'highlight.js/lib/languages/typescript';
  import json from 'highlight.js/lib/languages/json';
  import xml from 'highlight.js/lib/languages/xml';
  import css from 'highlight.js/lib/languages/css';
  import yaml from 'highlight.js/lib/languages/yaml';
  import ini from 'highlight.js/lib/languages/ini';
  import properties from 'highlight.js/lib/languages/properties';
  import bash from 'highlight.js/lib/languages/bash';
  import plaintext from 'highlight.js/lib/languages/plaintext';
  import markdown from 'highlight.js/lib/languages/markdown';
  import java from 'highlight.js/lib/languages/java';
  import 'highlight.js/styles/github-dark.css';
  import codeInput, { registerTemplate } from '@webcoder49/code-input';
  import Hljs from '@webcoder49/code-input/templates/hljs.mjs';
  import '@webcoder49/code-input/code-input.css';
  import Button from './ui/Button.svelte';
  import Icon from './ui/Icon.svelte';

  const LANGUAGES = { javascript, typescript, json, xml, css, yaml, ini, properties, bash, plaintext, markdown, java };
  // highlight.js language definitions are loosely typed; cast once at the boundary.
  const HLJS = /** @type {any} */ (hljs);
  for (const [name, lang] of Object.entries(LANGUAGES)) {
    try { HLJS.registerLanguage(name, lang); } catch { /* already registered */ }
  }
  for (const [alias, target] of Object.entries({ html: "xml", yml: "yaml", toml: "ini", conf: "properties", sh: "bash" })) {
    try { HLJS.registerLanguage(alias, LANGUAGES[target]); } catch { /* noop */ }
  }

  // Defensive: code-input/hljs can emit `language-undefined` during init/updates.
  try {
    if (typeof HLJS.highlightElement === "function" && !HLJS.__smpPatched) {
      const original = HLJS.highlightElement.bind(HLJS);
      HLJS.highlightElement = (el, ...rest) => {
        try {
          if (el && typeof el.getAttribute === "function") {
            let cls = String(el.className || "");
            if (/\blanguage-(undefined|null)\b/.test(cls)) {
              cls = cls.replace(/\blanguage-(undefined|null)\b/g, " ").replace(/\s+/g, " ").trim();
              const match = cls.match(/\blanguage-([a-z0-9_+-]+)\b/i);
              const lang = match && match[1] && HLJS.getLanguage(match[1]) ? match[1] : "plaintext";
              el.setAttribute("data-language", lang);
              if (!/\blanguage-[a-z0-9_+-]+\b/i.test(cls)) cls = `${cls} language-${lang}`.trim();
              el.className = cls;
            }
          }
        } catch { /* keep original behavior */ }
        return original(el, ...rest);
      };
      HLJS.__smpPatched = true;
    }
  } catch { /* noop */ }

  try {
    const used = /** @type {any} */ (codeInput)?.usedTemplates || /** @type {any} */ (globalThis).codeInput?.usedTemplates;
    if (!used?.["hljs-smp"]) registerTemplate("hljs-smp", new Hljs(HLJS, []));
  } catch {
    try { registerTemplate("hljs-smp", new Hljs(HLJS, [])); } catch { /* noop */ }
  }

  let { value = $bindable(""), filename = "", onSave = null, onClose = null, dirty = undefined } = $props();

  let ciEl = $state(null);
  let gutterEl = $state(null);
  let mode = $state("auto");
  let lang = $state("plaintext");
  let detected = $state("plaintext");
  let langs = $state(["plaintext", "javascript", "typescript", "json", "html", "xml", "css", "yaml", "ini", "properties", "bash", "java", "markdown"]);
  let useEditor = $state(true);

  const EXT_MAP = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    json: "json", jsonc: "json", html: "html", htm: "html", xml: "xml", svg: "xml", css: "css", scss: "css", less: "css",
    yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "properties", properties: "properties",
    sh: "bash", bash: "bash", bat: "plaintext", ps1: "plaintext", cmd: "plaintext",
    md: "markdown", txt: "plaintext", log: "plaintext", java: "java", mcfunction: "plaintext", mcmeta: "json", lang: "properties",
  };
  const NORM = { shell: "bash", yml: "yaml", toml: "ini", conf: "properties" };

  const extOf = (name = "") => { const i = name.lastIndexOf("."); return i >= 0 ? name.slice(i + 1).toLowerCase() : ""; };
  const normalizeLang = (l) => { if (!l || l === "undefined") return "plaintext"; const x = String(l).toLowerCase(); return NORM[x] || x; };

  function detectFromExt(name) { return EXT_MAP[extOf(name)] || null; }
  function detectFromText(text) {
    try {
      const r = HLJS.highlightAuto(String(text || ""), Object.keys(LANGUAGES));
      return normalizeLang(r?.language || "plaintext");
    } catch { return "plaintext"; }
  }
  function computeAuto(text) {
    const byExt = detectFromExt(filename);
    if (byExt) return normalizeLang(byExt);
    return detectFromText(text) || "plaintext";
  }
  function effectiveLang(text) {
    if (mode === "off") return "plaintext";
    if (mode === "manual") return normalizeLang(lang || "plaintext");
    return normalizeLang(computeAuto(text ?? ""));
  }

  function updateLines(text) {
    if (!gutterEl) return;
    const t = String(text ?? value ?? "");
    const count = (t.match(/\n/g)?.length || 0) + 1;
    let out = "";
    for (let i = 1; i <= count; i++) out += `${i}\n`;
    gutterEl.textContent = out;
  }

  function syncScroll() {
    if (!gutterEl || !ciEl) return;
    const ta = ciEl.textareaElement;
    if (ta) gutterEl.scrollTop = ta.scrollTop;
    else gutterEl.scrollTop = ciEl.scrollTop || 0;
  }

  function applyLanguage(text = value ?? "") {
    if (!ciEl) return;
    const resolved = normalizeLang(effectiveLang(text));
    lang = resolved;
    if (mode === "auto") detected = normalizeLang(computeAuto(text));
    try {
      ciEl.setAttribute("language", resolved);
      ciEl.setAttribute("lang", resolved);
      if (ciEl.value !== (text ?? "")) ciEl.value = text ?? "";
    } catch { /* noop */ }
  }

  let lastPropValue = value;
  $effect(() => {
    const v = value ?? "";
    if (!ciEl) { lastPropValue = v; return; }
    if (v === lastPropValue) return;
    lastPropValue = v;
    try { if (ciEl.value !== v) ciEl.value = v; } catch { /* noop */ }
    if (mode === "auto") detected = computeAuto(v);
    updateLines(v);
    applyLanguage(v);
  });

  function onInput(e) {
    const t = e?.target?.value ?? ciEl?.value ?? "";
    if (t !== value) { lastPropValue = t; value = t; }
    updateLines(t);
    syncScroll();
  }

  function onKeyDown(e) {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart ?? 0;
      const end = ta.selectionEnd ?? 0;
      const next = `${String(ta.value).slice(0, start)}  ${String(ta.value).slice(end)}`;
      value = next;
      requestAnimationFrame(() => ta.setSelectionRange(start + 2, start + 2));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty === false) return;
      onSave?.();
    }
  }

  function bindInner() {
    if (!ciEl) return;
    const ta = ciEl.textareaElement;
    if (!ta) return;
    ta.addEventListener("scroll", syncScroll);
    ta.addEventListener("keydown", onKeyDown);
    ta.addEventListener("input", () => requestAnimationFrame(syncScroll));
  }

  onMount(() => {
    try {
      const registered = HLJS.listLanguages?.() || [];
      langs = Array.from(new Set(["plaintext", ...langs, ...registered])).sort();
      detected = computeAuto(value ?? "");
      lang = effectiveLang(value ?? "");
      if (ciEl) {
        ciEl.setAttribute("template", "hljs-smp");
        ciEl.value = value ?? "";
        applyLanguage(value ?? "");
        updateLines(value ?? "");
        ciEl.addEventListener("input", onInput);
        ciEl.addEventListener("code-input_load", () => { bindInner(); applyLanguage(value ?? ""); syncScroll(); });
        setTimeout(() => { bindInner(); applyLanguage(value ?? ""); updateLines(value ?? ""); syncScroll(); }, 0);
      } else {
        useEditor = false;
      }
    } catch {
      useEditor = false;
    }
  });

  onDestroy(() => {
    try {
      if (ciEl) {
        ciEl.removeEventListener("input", onInput);
        const ta = ciEl.textareaElement;
        if (ta) {
          ta.removeEventListener("scroll", syncScroll);
          ta.removeEventListener("keydown", onKeyDown);
        }
      }
    } catch { /* noop */ }
  });

  function setMode(m) { mode = m; applyLanguage(value ?? ""); updateLines(value ?? ""); }
  function setLang(l) { lang = normalizeLang(l); if (mode !== "manual") mode = "manual"; applyLanguage(value ?? ""); }
</script>

<div class="ce">
  <div class="ce-bar">
    <div class="ce-left">
      <span class="muted" style="font-size:.72rem">Language</span>
      <select class="input ce-select" value={mode} onchange={(e) => setMode(e.currentTarget.value)} title="Highlight mode">
        <option value="auto">Auto{detected && mode === "auto" ? ` (${detected})` : ""}</option>
        <option value="manual">Manual</option>
        <option value="off">No highlighting</option>
      </select>
      <select class="input ce-select" value={lang} onchange={(e) => setLang(e.currentTarget.value)} disabled={mode === "off"} title="Language">
        {#each langs as l}<option value={l}>{l}</option>{/each}
      </select>
    </div>
    <div class="ce-right">
      {#if onClose}<Button size="sm" variant="outline" onclick={onClose}><Icon name="x" size={13} /> Close</Button>{/if}
      {#if onSave}<Button size="sm" variant="primary" disabled={dirty === false} idle={dirty === false} onclick={onSave}><Icon name="save" size={13} /> Save (Ctrl+S)</Button>{/if}
    </div>
  </div>
  {#if useEditor}
    <div class="ce-wrap">
      <pre class="ce-gutter" bind:this={gutterEl} aria-hidden="true"></pre>
      <code-input bind:this={ciEl} class="ce-host hljs" template="hljs-smp" spellcheck="false"></code-input>
    </div>
  {:else}
    <textarea class="fm-editor" bind:value spellcheck="false" onkeydown={onKeyDown}></textarea>
  {/if}
</div>