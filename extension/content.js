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

    // Some sites reuse the exact same [name] across multiple UNRELATED radio groups (seen on
    // ShareTrip: trip-type, fare-type, and cabin-class radios all literally named "radio-group")
    // — a document-wide query would then merge them into one nonsensical combined option list.
    // Real groups are always tightly nested together in practice, so the smallest ancestor that
    // contains more than one same-name match is the true group; climbing further would only start
    // sweeping in an unrelated group further up the tree.
    const findGroupScope = (el, name) => {
      let scope = el.parentElement;
      for (let i = 0; i < 8 && scope; i++) {
        if (scope.querySelectorAll(`input[name="${CSS.escape(name)}"]`).length > 1) return scope;
        scope = scope.parentElement;
      }
      return document;
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
        if (wrapLabel) {
          optionInput = wrapLabel.querySelector('input[type="radio"], input[type="checkbox"]');
          // Very common pattern (Bootstrap custom-control, Material, plain HTML): the real
          // <input> is NOT inside the label — the label references it by id via for="...", and the
          // native input is visually hidden behind a styled box. Without this, clicking such a
          // checkbox/radio is recorded as a meaningless generic click and never replays (this is
          // why Rokomari's "Gift Wrap" and similar ticks weren't captured).
          if (!optionInput && wrapLabel.htmlFor) {
            const ref = document.getElementById(wrapLabel.htmlFor);
            if (ref && ref.tagName === 'INPUT' && (ref.type === 'radio' || ref.type === 'checkbox')) optionInput = ref;
          }
        }
      }

      if (optionInput && optionInput.name) {
        const groupScope = findGroupScope(optionInput, optionInput.name);
        const groupEls = Array.from(groupScope.querySelectorAll(`input[name="${CSS.escape(optionInput.name)}"]`));
        if (groupEls.length > 1) {
          // The raw [name] attribute is often generic or even reused across unrelated groups on
          // the same page — not even guaranteed unique — so summarize the group by its own
          // option text instead, which is always meaningfully distinct.
          const optLabels = groupEls.map(el => getOptionLabel(el)).filter(Boolean);
          const groupLabel = optLabels.slice(0, 3).join(' / ').slice(0, 60) || optionInput.name;
          send({
            type: 'choice',
            groupName: groupLabel,
            options: groupEls.map(el => ({ selector: generateOptionSelector(el), label: getOptionLabel(el), value: el.value })),
            selectedSelector: generateOptionSelector(optionInput),
            selectedLabel: getOptionLabel(optionInput),
            label: groupLabel,
          });
          return;
        }
      }

      if (optionInput && optionInput.type === 'checkbox') {
        const ts = generateOptionSelector(optionInput);
        send({ type: 'toggle', selector: ts, matchIndex: getMatchIndex(optionInput, ts), newState: optionInput.checked, label: getOptionLabel(optionInput) });
        return;
      }

      // Accessible ARIA radio groups (role="radio" inside role="radiogroup") — a common pattern
      // for custom-styled radio buttons (Google Forms among many others) that native
      // input[type=radio] detection above doesn't see at all. data-value (when present) is a
      // clean option label; aria-label is often noisy (a full sentence with a duplicated
      // description appended after a comma), so prefer data-value and trim aria-label at the
      // first comma as a fallback.
      const ariaRadioEl = e.target.closest('[role="radio"]');
      if (ariaRadioEl && !optionInput) {
        const group = ariaRadioEl.closest('[role="radiogroup"]') || ariaRadioEl.parentElement;
        const getAriaRadioLabel = (el) => {
          const dv = el.getAttribute('data-value');
          if (dv) return dv.trim().slice(0, 60);
          const al = el.getAttribute('aria-label');
          if (al) return al.split(',')[0].trim().slice(0, 60);
          return el.textContent.trim().slice(0, 60);
        };
        const radios = group ? Array.from(group.querySelectorAll('[role="radio"]')) : [ariaRadioEl];
        if (radios.length > 1) {
          const options = [...new Set(radios.map(getAriaRadioLabel))].filter(Boolean);
          if (options.length > 1) {
            send({
              type: 'choice',
              mode: 'text',
              groupName: group?.getAttribute('aria-label') || 'Option',
              options: options.map(label => ({ label })),
              selectedLabel: getAriaRadioLabel(ariaRadioEl),
              label: group?.getAttribute('aria-label') || 'Option',
            });
            return;
          }
        }
      }

      // Calendar date-cell pick — accessible date pickers commonly label each day cell with a
      // full, parseable date in aria-label (e.g. "Wednesday, August 5, 2026"), a far more
      // reliable signal than DOM position: which cell holds "the 5th" shifts every month, and
      // which month is even showing depends on today's date. Recorded as a portable calendar
      // date instead of a DOM position/selector.
      const DATE_LABEL_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i;
      const dateLabelEl = e.target.closest('[aria-label]');
      if (dateLabelEl && !optionInput) {
        const m = (dateLabelEl.getAttribute('aria-label') || '').match(DATE_LABEL_RE);
        if (m) {
          const iso = new Date(`${m[1]} ${m[2]}, ${m[3]}`).toISOString().slice(0, 10);
          if (!isNaN(new Date(iso))) {
            send({ type: 'date', value: iso, label: 'Date' });
            return;
          }
        }
      }

      // ARIA combobox / typeahead suggestion pick (role="combobox" input with
      // aria-expanded/aria-controls driving a live, dynamically-generated option list) — common
      // for location/search-as-you-type fields. The options only exist because of what was just
      // typed, so hardcoding them at record time breaks replay for a different requested value.
      // Recorded as "typed into field X, picked a suggestion" — replay re-types the requested
      // value fresh and clicks whatever suggestion comes back live.
      const optionRoleEl = e.target.closest('[role="option"]');
      if (optionRoleEl && !optionInput) {
        const comboEl = document.querySelector('[role="combobox"][aria-expanded="true"]');
        if (comboEl) {
          const cs = generateSelector(comboEl);
          send({
            type: 'autocomplete',
            selector: cs,
            matchIndex: getMatchIndex(comboEl, cs),
            value: comboEl.value || '',
            selectedLabel: optionRoleEl.textContent.trim().slice(0, 80),
            label: getLabel(comboEl),
          });
          return;
        }
      }

      // Numeric stepper / quantity selector (e.g. traveller-count pickers, ticket/quantity
      // pickers) — a clicked button sitting in a strict 3-sibling row [button, number, button].
      // No ARIA convention exists for this at all (unlike radio/checkbox/combobox/date — these
      // +/- icon buttons carry no aria-label), but the exact 3-child shape is itself a common,
      // reliable structural signal for quantity pickers across many frameworks/sites, and strict
      // enough not to misfire on unrelated things like pagination bars (which have more than 3
      // children: prev, several page numbers, next). Checked BEFORE the generic list/option
      // detector below, which would otherwise misinterpret a stepper's whole row-list as a
      // static multi-choice pick — recording a confusing new "choice" variable on every click
      // instead of recognizing it as one count that goes up or down.
      if (!optionInput) {
        const btnEl = e.target.closest('button');
        const sibs = btnEl && btnEl.parentElement ? Array.from(btnEl.parentElement.children) : [];
        if (btnEl && sibs.length === 3) {
          const idx = sibs.indexOf(btnEl);
          const numEl = sibs[1] !== btnEl && /^\d+$/.test((sibs[1].textContent || '').trim()) ? sibs[1] : null;
          const otherBtn = numEl && idx !== 1 ? sibs.find(s => s.tagName === 'BUTTON' && s !== btnEl) : null;
          if (numEl && otherBtn) {
            const before = parseInt(numEl.textContent.trim(), 10);
            const rowEl = btnEl.closest('li, tr, [role="row"]') || btnEl.parentElement.parentElement;
            const rowLabel = ((rowEl && rowEl.querySelector('p,span,label')) ? rowEl.querySelector('p,span,label').textContent : getLabel(btnEl)).trim().slice(0, 40);
            const btnSel = generateSelector(btnEl), otherSel = generateSelector(otherBtn), numSel = generateSelector(numEl);
            const btnMi = getMatchIndex(btnEl, btnSel), otherMi = getMatchIndex(otherBtn, otherSel), numMi = getMatchIndex(numEl, numSel);
            setTimeout(() => {
              const allNum = document.querySelectorAll(numSel);
              const afterEl = allNum[Math.min(numMi, allNum.length - 1)];
              const after = afterEl ? parseInt(afterEl.textContent.trim(), 10) : NaN;
              if (!isNaN(before) && !isNaN(after) && before !== after) {
                send({
                  type: 'stepper',
                  label: rowLabel || 'Count',
                  incSelector: after > before ? btnSel : otherSel,
                  incMatchIndex: after > before ? btnMi : otherMi,
                  decSelector: after > before ? otherSel : btnSel,
                  decMatchIndex: after > before ? otherMi : btnMi,
                  countSelector: numSel,
                  countMatchIndex: numMi,
                  value: after,
                });
              }
            }, 250);
            return;
          }
        }
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

      // Accessible ARIA checkboxes (role="checkbox") — the same custom-widget pattern as the
      // ARIA radio group above (Google Forms' "Checkboxes" question type, among others), which
      // native input[type=checkbox] detection can't see at all. Unlike radios these are
      // independent multi-select toggles, not a mutually-exclusive group, so each is its own
      // toggle step. There's no real selector to replay against, so it's matched by label text
      // at replay time the same way ARIA-radio text-mode options are. aria-checked is read after
      // a short delay since custom widgets (React state updates) may not reflect the new state
      // synchronously inside this capture-phase listener.
      const ariaCheckboxEl = e.target.closest('[role="checkbox"]');
      if (ariaCheckboxEl && !optionInput) {
        const dv = ariaCheckboxEl.getAttribute('data-value');
        const al = ariaCheckboxEl.getAttribute('aria-label');
        const label = (dv || (al ? al.split(',')[0] : '') || ariaCheckboxEl.textContent).trim().slice(0, 60);
        setTimeout(() => {
          send({ type: 'toggle', mode: 'text', label: label || 'Option', newState: ariaCheckboxEl.getAttribute('aria-checked') === 'true' });
        }, 50);
        return;
      }

      // Clicks often land on a tiny icon inside a real control — an <svg>/<path>/<use>/<i> that
      // has no stable identity of its own (selector "path", matchIndex 108...), so it can never be
      // re-found at replay and the click misses (this is exactly what broke ShareTrip's Search
      // button, making the whole run fall back to the recorded default URL). Retarget to the
      // nearest genuinely clickable ancestor (button/link/[role=button]/submit) so we record a
      // selector that actually points at the control the user meant to press.
      let clickTarget = e.target;
      if (/^(svg|path|use|i|img|span)$/i.test(clickTarget.tagName)) {
        const real = clickTarget.closest('button, a, [role="button"], [type="submit"], input[type="submit"]');
        if (real) clickTarget = real;
      }
      const sel = generateSelector(clickTarget);
      send({ type: 'click', selector: sel, matchIndex: getMatchIndex(clickTarget, sel), tag: clickTarget.tagName.toLowerCase(), label: getLabel(clickTarget) });
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
      // Read now — focusout only fires when you've genuinely left the field (unlike 'click',
      // which can also fire from a framework's own internal interactions mid-typing), so typing
      // is already done and the value is safe to capture immediately. Also read again shortly
      // after in case a React-style form reformats/validates the value right after blur.
      snapshotAll();
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

  const disarm = () => { active = false; removeIndicator(); };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.kind === 'activate') { arm(); sendResponse({ ok: true }); }
    if (msg && msg.kind === 'deactivate') { disarm(); sendResponse({ ok: true }); }
  });

  // Stay continuously in sync with the background recording state instead of relying on a single
  // check at page load. That one-shot check was fragile: on a heavy SPA (or right after an initial
  // redirect) it could race the moment recording is turned on and miss it entirely, leaving the
  // page un-armed so NOTHING but navigation events got captured for the whole session. Polling the
  // background state every couple of seconds is cheap (a tiny message) and guarantees the content
  // script arms within ~2s no matter which activate/getState message was missed — recording is an
  // interactive, seconds-between-clicks activity, so this sync speed is more than fast enough.
  const syncState = () => {
    try {
      chrome.runtime.sendMessage({ kind: 'getState' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.active) { if (!active) arm(); }
        else if (active) disarm();
      });
    } catch (_) {}
  };
  syncState();
  setInterval(syncState, 2000);
})();
