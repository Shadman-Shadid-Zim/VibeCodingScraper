// Shadman's API Recorder — content script.
// Dormant on every page until the background worker confirms this tab is being recorded.
// Capture logic mirrors the platform's built-in recorder: fills, choice groups (radio/checkbox
// and app-style text menus), single-checkbox toggles, sliders, and clicks — with matchIndex
// disambiguation and a settle window so AJAX widget defaults aren't recorded as user edits.
(() => {
  if (window.__sapiContentLoaded) return;
  window.__sapiContentLoaded = true;

  let armed = false;
  let active = false; // background can deactivate without a reload

  const send = (action) => {
    if (!active) return;
    try { chrome.runtime.sendMessage({ kind: 'action', action }, () => void chrome.runtime.lastError); } catch (_) {}
  };

  // ── Recording indicator ────────────────────────────────────────────────────
  const showIndicator = () => {
    if (document.getElementById('__sapi_rec_ind')) return;
    const d = document.createElement('div');
    d.id = '__sapi_rec_ind';
    d.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483647;background:#1e1b4b;color:#fff;padding:7px 14px;border-radius:20px;font:12px Arial,sans-serif;display:flex;align-items:center;gap:8px;box-shadow:0 2px 12px rgba(0,0,0,.45);pointer-events:none;';
    d.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block;animation:__sapiBlink 1s infinite"></span>Recording — stop via the extension icon<style>@keyframes __sapiBlink{0%,100%{opacity:1}50%{opacity:.2}}</style>';
    (document.body || document.documentElement).appendChild(d);
  };
  const removeIndicator = () => document.getElementById('__sapi_rec_ind')?.remove();

  // ── Capture logic ──────────────────────────────────────────────────────────
  const attach = () => {
    const generateSelector = (el) => {
      if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${el.id}`;
      if (el.name) return `[name="${el.name}"]`;
      const tag = el.tagName.toLowerCase();
      if (el.placeholder) return `${tag}[placeholder="${el.placeholder}"]`;
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.split(' ').find(c => /^[a-zA-Z][\w-]*$/.test(c));
        if (cls) return `${tag}.${cls}`;
      }
      return tag;
    };

    const generateOptionSelector = (el) => {
      if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${el.id}`;
      if (el.name && el.value) return `input[name="${el.name}"][value="${el.value.replace(/"/g, '\\"')}"]`;
      return generateSelector(el);
    };

    const getLabel = (el) =>
      el.getAttribute('aria-label') || el.placeholder || el.name || el.id ||
      (el.textContent || '').trim().substring(0, 30) || el.tagName.toLowerCase();

    const getOptionLabel = (el) => {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return lab.textContent.trim().slice(0, 60);
      }
      const wrapLabel = el.closest('label');
      if (wrapLabel) return wrapLabel.textContent.trim().slice(0, 60);
      return getLabel(el);
    };

    const getMatchIndex = (el, sel) => {
      try {
        const m = document.querySelectorAll(sel);
        if (m.length > 1) return Math.max(0, Array.from(m).indexOf(el));
      } catch (_) {}
      return 0;
    };

    const FIELD_SELECTOR = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]';
    const getVal = el => (el.value !== undefined && el.value !== null) ? el.value : (el.textContent || '').trim();
    const fieldSnapshot = new Map();
    const settleUntil = Date.now() + 1800;

    document.querySelectorAll(FIELD_SELECTOR).forEach(el => {
      const val = getVal(el);
      if (val) { const s = generateSelector(el); fieldSnapshot.set(s + '|' + getMatchIndex(el, s), val); }
    });

    const snapshotAll = () => {
      const settling = Date.now() < settleUntil;
      document.querySelectorAll(FIELD_SELECTOR).forEach(el => {
        // Invisible fields are analytics/tracking forms the site fills in the background — never user input
        if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
        const val = getVal(el);
        if (!val || val.length > 300) return;
        const sel = generateSelector(el);
        const mi = getMatchIndex(el, sel);
        const key = sel + '|' + mi;
        if (fieldSnapshot.get(key) === val) return;
        fieldSnapshot.set(key, val);
        if (settling) return;
        send({ type: 'fill', selector: sel, matchIndex: mi, value: val, label: getLabel(el), inputType: el.type || 'text', tag: el.tagName.toLowerCase(), autocomplete: true });
      });
    };

    document.addEventListener('click', (e) => {
      if (!active) return;
      if (e.target.closest('#__sapi_rec_ind')) return;

      let optionInput = null;
      if (e.target.tagName === 'INPUT' && (e.target.type === 'radio' || e.target.type === 'checkbox')) {
        optionInput = e.target;
      } else {
        const wrapLabel = e.target.closest('label');
        if (wrapLabel) optionInput = wrapLabel.querySelector('input[type="radio"], input[type="checkbox"]');
      }

      if (optionInput && optionInput.name) {
        const groupEls = Array.from(document.querySelectorAll(`input[name="${CSS.escape(optionInput.name)}"]`));
        if (groupEls.length > 1) {
          send({
            type: 'choice',
            groupName: optionInput.name,
            options: groupEls.map(el => ({ selector: generateOptionSelector(el), label: getOptionLabel(el), value: el.value })),
            selectedSelector: generateOptionSelector(optionInput),
            selectedLabel: getOptionLabel(optionInput),
            label: optionInput.name,
          });
          return;
        }
      }

      if (optionInput && optionInput.type === 'checkbox') {
        const ts = generateOptionSelector(optionInput);
        send({ type: 'toggle', selector: ts, matchIndex: getMatchIndex(optionInput, ts), newState: optionInput.checked, label: getOptionLabel(optionInput) });
        return;
      }

      const optionEl = e.target.closest('li, [role="option"], [role="menuitem"]');
      if (optionEl && !optionInput) {
        const container = optionEl.parentElement;
        const getItemLabel = (el) => {
          const lab = el.querySelector('label');
          return (lab ? lab.textContent : el.textContent).trim().slice(0, 60);
        };
        if (container && container.children.length > 1) {
          const options = [...new Set(Array.from(container.children).map(getItemLabel))].filter(t => t && t.length < 60);
          if (options.length > 1) {
            send({
              type: 'choice',
              mode: 'text',
              groupName: 'Option',
              options: options.map(label => ({ label })),
              selectedLabel: getItemLabel(optionEl),
              label: 'Option',
            });
            return;
          }
        }
      }

      const sel = generateSelector(e.target);
      send({ type: 'click', selector: sel, matchIndex: getMatchIndex(e.target, sel), tag: e.target.tagName.toLowerCase(), label: getLabel(e.target) });
      setTimeout(snapshotAll, 600);
    }, true);

    document.addEventListener('change', (e) => {
      if (!active) return;
      const el = e.target;
      if (Date.now() < settleUntil) return;
      if (el.tagName === 'INPUT' && el.type === 'range') {
        const s = generateSelector(el);
        send({ type: 'slider', selector: s, matchIndex: getMatchIndex(el, s), value: el.value, min: el.min || '0', max: el.max || '100', label: getLabel(el) });
      }
    }, true);

    const sliderDebounce = new Map();
    const recordSliderChange = (el) => {
      if (Date.now() < settleUntil) return;
      const val = el.getAttribute('aria-valuenow');
      if (val == null) return;
      const s = generateSelector(el);
      send({
        type: 'slider', selector: s, matchIndex: getMatchIndex(el, s), value: val,
        min: el.getAttribute('aria-valuemin') || '0', max: el.getAttribute('aria-valuemax') || '100',
        label: el.getAttribute('aria-label') || getLabel(el),
      });
    };
    new MutationObserver((mutations) => {
      if (!active) return;
      const touched = new Set();
      for (const m of mutations) {
        if (m.attributeName === 'aria-valuenow' && m.target.getAttribute('role') === 'slider' && !touched.has(m.target)) {
          touched.add(m.target);
          const el = m.target;
          const key = generateSelector(el) + '|' + getMatchIndex(el, generateSelector(el));
          clearTimeout(sliderDebounce.get(key));
          sliderDebounce.set(key, setTimeout(() => recordSliderChange(el), 500));
        }
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['aria-valuenow'], subtree: true });

    document.addEventListener('focusout', (e) => {
      if (!active) return;
      const el = e.target;
      if (!['INPUT', 'TEXTAREA'].includes(el.tagName) && !el.isContentEditable) return;
      setTimeout(snapshotAll, 300);
    }, true);

    document.addEventListener('keydown', (e) => {
      if (!active) return;
      if (e.key === 'Tab' || e.key === 'Enter') setTimeout(snapshotAll, 300);
    }, true);
  };

  const arm = () => {
    active = true;
    showIndicator();
    if (!armed) { armed = true; attach(); }
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.kind === 'activate') { arm(); sendResponse({ ok: true }); }
    if (msg && msg.kind === 'deactivate') { active = false; removeIndicator(); sendResponse({ ok: true }); }
  });

  // On page load, ask whether this tab is mid-recording (survives navigations)
  try {
    chrome.runtime.sendMessage({ kind: 'getState' }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.active) arm();
    });
  } catch (_) {}
})();
