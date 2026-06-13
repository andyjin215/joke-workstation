/* ===== 段子工作台 - 设置页逻辑 ===== */

const $ = (sel) => document.querySelector(sel);

const apiKeyInput = $('#apiKeyInput');
const baseUrlInput = $('#baseUrlInput');
const btnTogglePw = $('#btnTogglePw');
const btnSave = $('#btnSave');
const btnTest = $('#btnTest');
const keyStatus = $('#keyStatus');

// 加载已有配置
async function loadConfig() {
  const config = await window.api.getApiConfig();
  if (config.apiKey) {
    apiKeyInput.value = config.apiKey;
    keyStatus.textContent = '✓ 已配置 API Key';
    keyStatus.className = 'form-hint success';
  }
}

// 保存
btnSave.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    keyStatus.textContent = '✗ 请输入 API Key';
    keyStatus.className = 'form-hint error';
    return;
  }
  if (!key.startsWith('sk-')) {
    keyStatus.textContent = '⚠ API Key 通常以 sk- 开头，请确认';
    keyStatus.className = 'form-hint error';
    return;
  }

  await window.api.saveApiKey(key);
  keyStatus.textContent = '✓ 保存成功';
  keyStatus.className = 'form-hint success';
});

// 测试连接
btnTest.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    keyStatus.textContent = '✗ 请先输入 API Key';
    keyStatus.className = 'form-hint error';
    return;
  }

  btnTest.disabled = true;
  keyStatus.textContent = '🔄 正在测试连接...';
  keyStatus.className = 'form-hint';

  try {
    const config = await window.api.getApiConfig();
    const baseUrl = config.baseUrl || 'https://api.deepseek.com';

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '你好，请用一句话回复。' }],
        max_tokens: 20
      })
    });

    if (response.ok) {
      const data = await response.json().catch(() => null);
      const modelUsed = data?.model || 'unknown';
      const reply = data?.choices?.[0]?.message?.content || '';
      console.log('[DeepSeek] 测试连接成功，模型:', modelUsed, '回复:', reply);
      keyStatus.textContent = `✓ 连接成功！模型 ${modelUsed} 可用`;
      keyStatus.className = 'form-hint success';
    } else {
      const data = await response.json().catch(() => ({}));
      const msg = data.error?.message || `HTTP ${response.status}`;
      keyStatus.textContent = `✗ 连接失败: ${msg}`;
      keyStatus.className = 'form-hint error';
    }
  } catch (err) {
    keyStatus.textContent = `✗ 网络错误: ${err.message}`;
    keyStatus.className = 'form-hint error';
  } finally {
    btnTest.disabled = false;
  }
});

// 密码可见切换
btnTogglePw.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

// 初始化
loadConfig();
