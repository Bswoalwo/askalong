/**
 * 随问 AskAlong · 设置页
 * 预设填充 / 保存到 chrome.storage.sync / 通过 Service Worker 测试连接。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  let statusTimer = null;

  /* ------------------------------ 预设下拉 ------------------------------ */

  const presetSel = $('preset');
  const CUSTOM = '__custom__';
  for (const [key, p] of Object.entries(AskAlong.PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    presetSel.appendChild(opt);
  }
  const optCustom = document.createElement('option');
  optCustom.value = CUSTOM;
  optCustom.textContent = '自定义(任意 OpenAI 兼容接口)';
  presetSel.appendChild(optCustom);

  presetSel.addEventListener('change', () => {
    const p = AskAlong.PRESETS[presetSel.value];
    if (p) {
      $('baseUrl').value = p.baseUrl;
      $('model').value = p.model;
      $('key-link').href = p.keyUrl;
      $('preset-tip').textContent = '已按预设填充接口地址与模型,填入 Key 即可';
    } else {
      $('preset-tip').textContent = '自定义模式下请自行填写接口地址与模型名';
    }
  });

  /* ------------------------------ 读取与保存 ------------------------------ */

  function currentPresetKey(settings) {
    for (const [key, p] of Object.entries(AskAlong.PRESETS)) {
      if (p.baseUrl === settings.baseUrl) return key;
    }
    return CUSTOM;
  }

  function fill(settings) {
    presetSel.value = currentPresetKey(settings);
    if (presetSel.value !== CUSTOM) {
      $('key-link').href = AskAlong.PRESETS[presetSel.value].keyUrl;
    }
    $('baseUrl').value = settings.baseUrl;
    $('apiKey').value = settings.apiKey;
    $('model').value = settings.model;
    $('temperature').value = settings.temperature;
    $('temp-val').textContent = Number(settings.temperature).toFixed(1);
    $('maxContextChars').value = settings.maxContextChars;
    $('ctx-val').textContent = fmtChars(settings.maxContextChars);
    $('showToolbar').checked = settings.showToolbar !== false;
  }

  function collect() {
    return {
      preset: presetSel.value === CUSTOM ? 'custom' : presetSel.value,
      baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim(),
      temperature: Number($('temperature').value),
      maxContextChars: Math.min(60000, Math.max(2000, Number($('maxContextChars').value) || 16000)),
      showToolbar: $('showToolbar').checked
    };
  }

  async function save() {
    const settings = collect();
    if (!/^https?:\/\//.test(settings.baseUrl)) {
      showStatus('接口地址必须以 http(s):// 开头', false);
      return false;
    }
    await chrome.storage.sync.set(settings);
    return true;
  }

  function fmtChars(n) {
    return n >= 10000 ? (n / 10000).toFixed(0) + 'k 字' : n + ' 字';
  }

  function showStatus(text, ok) {
    clearTimeout(statusTimer);
    statusEl.textContent = text;
    statusEl.className = 'status ' + (ok ? 'ok' : 'err');
    if (ok) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 3000);
  }

  /* ------------------------------ 测试连接 ------------------------------ */

  async function testConnection() {
    if (!(await save())) return;
    const s = collect();
    if (!s.apiKey && !/localhost|127\.0\.0\.1/.test(s.baseUrl)) {
      showStatus('请先填写 API Key(本地 Ollama 除外)', false);
      return;
    }
    showStatus('正在连接…', true);
    let finished = false;
    AskAlong.streamChat(
      {
        baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, temperature: 0.1,
        messages: [{ role: 'user', content: '请回复:连接成功' }]
      },
      {
        onDelta: () => {
          if (finished) return;
          finished = true;
          showStatus('✓ 连接成功,模型已响应', true);
        },
        onDone: () => {
          if (finished) return;
          finished = true;
          showStatus('✓ 连接成功(模型返回了空内容)', true);
        },
        onError: (err) => {
          if (finished) return;
          finished = true;
          showStatus('✗ ' + err, false);
        }
      }
    );
    // 15 秒超时兜底
    setTimeout(() => {
      if (!finished) { finished = true; showStatus('✗ 连接超时,请检查地址与网络', false); }
    }, 15000);
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  $('btn-save').addEventListener('click', async () => {
    showStatus(await save() ? '✓ 已保存' : '', true);
  });
  $('btn-test').addEventListener('click', testConnection);
  $('temperature').addEventListener('input', () => {
    $('temp-val').textContent = Number($('temperature').value).toFixed(1);
  });
  $('maxContextChars').addEventListener('input', () => {
    $('ctx-val').textContent = fmtChars(Number($('maxContextChars').value) || 0);
  });
  $('key-eye').addEventListener('click', () => {
    const el = $('apiKey');
    el.type = el.type === 'password' ? 'text' : 'password';
  });

  AskAlong.getSettings().then(fill);
})();
