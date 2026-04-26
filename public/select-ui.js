let activeSelect = null;
let globalListenersBound = false;

export function enhanceSelects(root = document) {
  root.querySelectorAll('select').forEach((select) => {
    if (select.dataset.customSelect === 'ready') return;
    const originalClassName = select.className;
    select.dataset.customSelect = 'ready';
    select.classList.add('native-select-hidden');

    const custom = document.createElement('div');
    custom.className = `custom-select ${originalClassName || ''}`.trim();
    if (select.disabled) custom.classList.add('is-disabled');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'custom-select-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.disabled = select.disabled;

    const label = document.createElement('span');
    label.className = 'custom-select-value';
    const chevron = document.createElement('span');
    chevron.className = 'custom-select-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '';
    button.append(label, chevron);

    const menu = document.createElement('div');
    menu.className = 'custom-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;

    custom.append(button, menu);
    select.insertAdjacentElement('afterend', custom);

    const api = { select, custom, button, label, menu };
    customSelectOptions(api);
    syncCustomSelect(api);

    button.addEventListener('click', () => toggleCustomSelect(api));
    button.addEventListener('keydown', (event) => handleSelectKeydown(event, api));
    select.addEventListener('change', () => syncCustomSelect(api));
  });

  bindGlobalSelectListeners();
}

function customSelectOptions(api) {
  api.menu.innerHTML = '';
  Array.from(api.select.options).forEach((option) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'custom-select-option';
    item.setAttribute('role', 'option');
    item.dataset.value = option.value;
    item.textContent = option.textContent;
    item.disabled = option.disabled;
    item.addEventListener('click', () => chooseOption(api, option.value));
    api.menu.appendChild(item);
  });
}

function syncCustomSelect(api) {
  const selected = api.select.selectedOptions[0] || api.select.options[0];
  api.label.textContent = selected?.textContent || '';
  api.menu.querySelectorAll('.custom-select-option').forEach((item) => {
    const isSelected = item.dataset.value === api.select.value;
    item.classList.toggle('selected', isSelected);
    item.setAttribute('aria-selected', String(isSelected));
  });
}

function chooseOption(api, value) {
  if (api.select.value !== value) {
    api.select.value = value;
    api.select.dispatchEvent(new Event('input', { bubbles: true }));
    api.select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  syncCustomSelect(api);
  closeCustomSelect(api);
  api.button.focus();
}

function toggleCustomSelect(api) {
  if (api.button.disabled) return;
  if (activeSelect === api) {
    closeCustomSelect(api);
    return;
  }
  if (activeSelect) closeCustomSelect(activeSelect);
  activeSelect = api;
  api.custom.classList.add('open');
  api.button.setAttribute('aria-expanded', 'true');
  api.menu.hidden = false;
}

function closeCustomSelect(api) {
  api.custom.classList.remove('open');
  api.button.setAttribute('aria-expanded', 'false');
  api.menu.hidden = true;
  if (activeSelect === api) activeSelect = null;
}

function handleSelectKeydown(event, api) {
  if (event.key === 'Escape') {
    closeCustomSelect(api);
    return;
  }
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  toggleCustomSelect(api);
}

function bindGlobalSelectListeners() {
  if (globalListenersBound) return;
  globalListenersBound = true;
  document.addEventListener('click', (event) => {
    if (!activeSelect || activeSelect.custom.contains(event.target)) return;
    closeCustomSelect(activeSelect);
  });
}
