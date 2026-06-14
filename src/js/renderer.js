/* ===== 段子工作台 - 主渲染逻辑 ===== */

// ---- 状态 ----
let currentJoke = null;  // { topic, scripts, prompts, createdAt }
let currentAbortController = null;  // 用于取消请求
let currentFilename = null;  // 当前 joke 的本地文件名，避免重复保存

// ---- DOM 引用 ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const topicInput = $('#topicInput');
const btnGenerate = $('#btnGenerate');
const btnCancel = $('#btnCancel');
const btnSettings = $('#btnSettings');
const btnExport = $('#btnExport');
const btnCopyAll = $('#btnCopyAll');
const btnGenPrompts = $('#btnGenPrompts');
const loadingOverlay = $('#loadingOverlay');
const loadingText = $('#loadingText');
const progressBar = $('#progressBar');
const resultSection = $('#resultSection');
const emptyJokeState = $('#emptyJokeState');
const resultContent = $('#resultContent');
const resultTopic = $('#resultTopic');
const resultTime = $('#resultTime');
const scriptsGrid = $('#scriptsGrid');
const promptsGrid = $('#promptsGrid');
const promptsEmpty = $('#promptsEmpty');
const scriptCount = $('#scriptCount');
const promptCount = $('#promptCount');
const historyList = $('#historyList');
const toastContainer = $('#toastContainer');

// ---- DeepSeek API 调用 ----
async function callDeepSeek(messages, onChunk) {
    const config = await window.api.getApiConfig();
    if (!config.apiKey) {
        throw new Error('请先在设置中填写 DeepSeek API Key');
    }

    const baseUrl = config.baseUrl || 'https://api.deepseek.com';

    // AbortController 支持取消 + 超时 90 秒
    const controller = new AbortController();
    currentAbortController = controller;
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    let response;
    try {
        response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify({
                model: 'deepseek-v4-flash',  // 固定只使用此模型
                messages,
                stream: true,
                temperature: 0.9,
                max_tokens: 4096,
                response_format: { type: 'json_object' }  // 强制 JSON 输出
            }),
            signal: controller.signal
        });
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error('请求已取消（超时 90 秒或被手动中止）');
        }
        throw err;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        const errorText = await response.text();
        let msg = `API 请求失败 (${response.status})`;
        try {
            const err = JSON.parse(errorText);
            msg = err.error?.message || msg;
        } catch {}
        if (response.status === 401) msg = 'API Key 无效，请在设置中检查';
        throw new Error(msg);
    }

    // 流式读取
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;
            try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices?.[0];
                if (!choice) continue;
                // 只取 content，忽略 reasoning_content / thinking
                const delta = choice.delta?.content;
                if (delta) {
                    fullContent += delta;
                    if (onChunk) onChunk(fullContent);
                }
            } catch {}
        }
    }

    // 如果流式没拿到 content，尝试从非流式 fallback
    if (!fullContent.trim()) {
        console.warn('[DeepSeek] 流式响应未获取到 content，原始响应:', buffer.substring(0, 500));
    }

    return fullContent;
}

// ---- 生成笑话脚本 ----
async function generateScripts(topic, onChunk) {
    const systemPrompt = `你是脱口秀编剧。根据主题创作6条40秒笑话脚本（150-200字/条），围绕一对夫妻的日常生活。每条有铺垫-冲突-反转-爆点。

你必须且只能输出一个合法的 JSON 数组，不要输出任何 markdown、解释、前言或后记。格式如下：
[{"title":"标题","content":"正文"},...]`;

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `主题：${topic}。请直接输出 JSON 数组，6条笑话脚本。` }
    ];

    return await callDeepSeek(messages, onChunk);
}

// ---- 生成 Q 版卡通提示词 ----
async function generatePrompts(topic, scripts, onChunk) {
    const scriptSummary = scripts.map((s, i) =>
        `第${i+1}条「${s.title}」：${s.content.substring(0, 80)}...`
    ).join('\n');

    const systemPrompt = `你是AI绘画提示词工程师。根据笑话脚本为每条生成一张Q版卡通插画的英文提示词。

固定人设：
- 老公：chibi Chinese man, round face, short hair, casual T-shirt, exaggerated cute expression
- 老婆：chibi Chinese woman, round face, bangs long hair, cute dress, expressive face

每条提示词固定前缀 "chibi cartoon style, cute kawaii illustration," 和后缀 ", vibrant colors, clean lines, white background, sticker art style, high quality"。60-80个英文单词。

你必须且只能输出一个合法的 JSON 字符串数组，不要输出任何 markdown、解释、前言或后记。格式如下：
["prompt1","prompt2",...]`;

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `主题：${topic}\n脚本概要：\n${scriptSummary}\n请直接输出 JSON 数组，6条英文提示词。` }
    ];

    return await callDeepSeek(messages, onChunk);
}

// ---- JSON 解析（超级鲁棒版）----
function parseJSON(text) {
    if (!text || typeof text !== 'string') return null;
    let cleaned = text.trim();

    // 1. 去除 markdown code block（```json ... ``` 或 ``` ... ```）
    cleaned = cleaned.replace(/^```(?:json|JSON)?\s*\n?/g, '').replace(/\n?```\s*$/g, '');
    cleaned = cleaned.trim();

    // 2. 尝试直接解析
    try {
        const result = JSON.parse(cleaned);
        if (Array.isArray(result)) return result;
        // 如果是对象包了一层，看有没有 data/scripts/jokes 字段
        if (typeof result === 'object' && result !== null) {
            for (const key of ['data', 'scripts', 'jokes', 'result', 'items', 'list']) {
                if (Array.isArray(result[key])) return result[key];
            }
        }
        return Array.isArray(result) ? result : null;
    } catch {}

    // 3. 找到最外层 [] 或 {} 的匹配
    const arrStart = cleaned.indexOf('[');
    const objStart = cleaned.indexOf('{');
    let jsonStr = cleaned;

    if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) {
        // 找匹配的 ]
        const arrEnd = findMatchingBracket(cleaned, arrStart, '[', ']');
        if (arrEnd > arrStart) {
            jsonStr = cleaned.substring(arrStart, arrEnd + 1);
        }
    } else if (objStart >= 0) {
        const objEnd = findMatchingBracket(cleaned, objStart, '{', '}');
        if (objEnd > objStart) {
            jsonStr = cleaned.substring(objStart, objEnd + 1);
        }
    }

    try {
        const result = JSON.parse(jsonStr);
        if (Array.isArray(result)) return result;
        if (typeof result === 'object' && result !== null) {
            for (const key of ['data', 'scripts', 'jokes', 'result', 'items', 'list']) {
                if (Array.isArray(result[key])) return result[key];
            }
        }
    } catch {}

    // 4. 修复常见 JSON 问题后重试
    let fixed = jsonStr
        .replace(/,\s*]/g, ']')           // 尾部逗号
        .replace(/,\s*}/g, '}')           // 对象尾部逗号
        .replace(/([\s,:{\[])'|'([\s,:}\]])/g, (m, before, after) => {
            return (before || '') + '"' + (after || '');
        })                                             // 仅替换 JSON 边界处的单引号
        .replace(/[\u2018\u2019]/g, "'")  // 中文引号 → 英文
        .replace(/[\u201c\u201d]/g, '"')  // 中文双引号 → 英文
        .replace(/\n/g, '\\n')            // 裸换行符
        .replace(/\r/g, '');              // 回车符

    // 重新尝试修复后的解析
    try {
        const result = JSON.parse(fixed);
        if (Array.isArray(result)) return result;
    } catch {}

    // 再试一次找到数组
    const fixArrStart = fixed.indexOf('[');
    const fixArrEnd = fixed.lastIndexOf(']');
    if (fixArrStart >= 0 && fixArrEnd > fixArrStart) {
        try {
            const result = JSON.parse(fixed.substring(fixArrStart, fixArrEnd + 1));
            if (Array.isArray(result)) return result;
        } catch {}
    }

    // 5. 最终兜底：手动提取 title/content 对
    console.warn('[DeepSeek] JSON 解析全部失败，原始内容前500字:', text.substring(0, 500));
    return null;
}

// 辅助：查找匹配括号
function findMatchingBracket(str, start, open, close) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === open) depth++;
        if (ch === close) depth--;
        if (depth === 0) return i;
    }
    return -1;
}

// ---- UI 更新 ----
function showLoading(text, progress) {
    loadingOverlay.classList.add('show');
    loadingText.textContent = text;
    if (progress !== undefined) {
        progressBar.style.width = `${progress}%`;
    }
}

function hideLoading() {
    loadingOverlay.classList.remove('show');
    progressBar.style.width = '0%';
}

function showToast(message, type = '') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function renderScripts(scripts) {
    scriptsGrid.innerHTML = '';
    scripts.forEach((script, i) => {
        const card = document.createElement('div');
        card.className = 'script-card';
        card.innerHTML = `
            <div class="card-header">
                <span class="card-number">第 ${i + 1} 条</span>
                <div class="card-actions">
                    <button class="card-btn btn-copy-script" data-index="${i}" title="复制">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                        复制
                    </button>
                </div>
            </div>
            <div class="card-title">${escapeHtml(script.title || '')}</div>
            <div class="card-content">${escapeHtml(script.content || '')}</div>
            <div class="card-footer">
                <span class="card-tag">~40秒</span>
                <span>${(script.content || '').length} 字</span>
            </div>
        `;
        scriptsGrid.appendChild(card);
    });

    // 绑定复制按钮
    $$('.btn-copy-script').forEach(btn => {
        btn.addEventListener('click', async () => {
            const idx = parseInt(btn.dataset.index);
            const s = scripts[idx];
            const text = `【${s.title}】\n${s.content}`;
            await window.api.copyText(text);
            showToast('已复制到剪贴板', 'success');
        });
    });
}

function renderPrompts(prompts) {
    promptsGrid.innerHTML = '';
    promptsEmpty.style.display = prompts.length > 0 ? 'none' : 'block';

    prompts.forEach((prompt, i) => {
        const card = document.createElement('div');
        card.className = 'prompt-card';
        card.innerHTML = `
            <div class="prompt-header">
                <span class="prompt-number">提示词 ${i + 1}</span>
                <div class="card-actions">
                    <button class="card-btn btn-copy-prompt" data-index="${i}" title="复制">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                        复制
                    </button>
                </div>
            </div>
            <div class="prompt-text">${escapeHtml(prompt)}</div>
        `;
        promptsGrid.appendChild(card);
    });

    // 绑定复制按钮
    $$('.btn-copy-prompt').forEach(btn => {
        btn.addEventListener('click', async () => {
            const idx = parseInt(btn.dataset.index);
            await window.api.copyText(prompts[idx]);
            showToast('已复制提示词', 'success');
        });
    });
}

async function loadHistory() {
    const jokes = await window.api.loadJokes();
    historyList.innerHTML = '';

    if (jokes.length === 0) {
        historyList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📭</div>
                <p>暂无历史记录，快去生成段子吧！</p>
            </div>`;
        return;
    }

    jokes.forEach(joke => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
            <div class="history-info">
                <div class="history-topic">${escapeHtml(joke.topic || '未命名')}</div>
                <div class="history-meta">
                    ${joke.createdAt ? new Date(joke.createdAt).toLocaleString('zh-CN') : ''}
                    · ${joke.scripts?.length || 0} 条脚本
                    · ${joke.prompts?.length || 0} 条提示词
                </div>
            </div>
            <div class="history-actions">
                <button class="card-btn btn-load-history" title="加载">📂 加载</button>
                <button class="btn-delete btn-delete-history" title="删除" data-filename="${escapeHtml(joke._filename)}">🗑️</button>
            </div>
        `;
        historyList.appendChild(item);
    });

    // 绑定加载按钮
    $$('.btn-load-history').forEach((btn, i) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const joke = jokes[i];
            currentJoke = joke;
            currentFilename = joke._filename;
            displayJoke(joke);
            // 切回脚本 tab
            switchTab('scripts');
            showToast('已加载历史记录', 'success');
        });
    });

    // 绑定删除按钮
    $$('.btn-delete-history').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const filename = btn.dataset.filename;
            if (confirm('确定删除这条记录吗？')) {
                await window.api.deleteJoke(filename);
                showToast('已删除', 'success');
                loadHistory();
            }
        });
    });
}

function displayJoke(joke) {
    // 切换到内容视图
    emptyJokeState.style.display = 'none';
    resultContent.style.display = 'block';

    resultTopic.textContent = joke.topic;
    resultTime.textContent = joke.createdAt
        ? new Date(joke.createdAt).toLocaleString('zh-CN')
        : '';

    if (joke.scripts?.length) {
        scriptCount.textContent = joke.scripts.length;
        renderScripts(joke.scripts);
    }

    if (joke.prompts?.length) {
        promptCount.textContent = joke.prompts.length;
        renderPrompts(joke.prompts);
    } else {
        promptCount.textContent = '0';
        promptsGrid.innerHTML = '';
        promptsEmpty.style.display = 'block';
    }
}

function showEmptyState() {
    emptyJokeState.style.display = 'block';
    resultContent.style.display = 'none';
}

function switchTab(tabName) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel${capitalize(tabName)}`));
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ---- 事件绑定 ----

// 生成段子
btnGenerate.addEventListener('click', async () => {
    const topic = topicInput.value.trim();
    if (!topic) {
        showToast('请输入一个主题', 'error');
        topicInput.focus();
        return;
    }

    try {
        // Step 1: 生成脚本
        showLoading('AI 正在创作 6 条笑话脚本...', 10);
        btnGenerate.disabled = true;

        const scriptsText = await generateScripts(topic, (content) => {
            const progress = Math.min(10 + (content.length / 20), 60);
            progressBar.style.width = `${progress}%`;
        });

        progressBar.style.width = '65%';
        loadingText.textContent = '正在解析脚本...';

        console.log('[DeepSeek] 脚本原始响应:', scriptsText);

        if (!scriptsText.trim()) {
            throw new Error('AI 未返回任何内容，请检查网络或重试');
        }

        const scripts = parseJSON(scriptsText);
        if (!scripts || !Array.isArray(scripts) || scripts.length === 0) {
            console.error('[DeepSeek] JSON 解析失败，原始内容:', scriptsText.substring(0, 1000));
            throw new Error('AI 返回格式异常，请重试（已记录到控制台）');
        }

        currentJoke = {
            topic,
            scripts: scripts.slice(0, 6),
            prompts: [],
            createdAt: Date.now()
        };

        progressBar.style.width = '80%';

        // 保存到本地
        const result = await window.api.saveJoke(currentJoke);
        currentFilename = result.filename;

        // 显示结果
        displayJoke(currentJoke);
        switchTab('scripts');

        progressBar.style.width = '100%';
        showToast(`成功生成 ${currentJoke.scripts.length} 条笑话脚本！`, 'success');

    } catch (err) {
        showToast(err.message, 'error');
        console.error(err);
    } finally {
        hideLoading();
        btnGenerate.disabled = false;
    }
});

// 回车生成
topicInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        btnGenerate.click();
    }
});

// 生成 Q 版提示词
btnGenPrompts.addEventListener('click', async () => {
    if (!currentJoke?.scripts?.length) {
        showToast('请先生成笑话脚本', 'error');
        return;
    }

    try {
        showLoading('AI 正在生成 Q 版卡通提示词...', 20);
        btnGenPrompts.disabled = true;

        const promptsText = await generatePrompts(currentJoke.topic, currentJoke.scripts, (content) => {
            const progress = Math.min(20 + (content.length / 15), 85);
            progressBar.style.width = `${progress}%`;
        });

        progressBar.style.width = '90%';
        loadingText.textContent = '正在解析提示词...';

        const prompts = parseJSON(promptsText);
        if (!prompts || !Array.isArray(prompts) || prompts.length === 0) {
            throw new Error('AI 返回的内容无法解析为提示词，请重试');
        }

        currentJoke.prompts = prompts.slice(0, 6);
        promptCount.textContent = currentJoke.prompts.length;
        renderPrompts(currentJoke.prompts);

        // 更新已有保存（避免重复文件）
        if (currentFilename) {
            const result = await window.api.updateJoke(currentFilename, currentJoke);
            if (result.filename) currentFilename = result.filename;
        } else {
            const result = await window.api.saveJoke(currentJoke);
            currentFilename = result.filename;
        }

        progressBar.style.width = '100%';
        switchTab('prompts');
        showToast(`成功生成 ${currentJoke.prompts.length} 条卡通提示词！`, 'success');

    } catch (err) {
        showToast(err.message, 'error');
        console.error(err);
    } finally {
        hideLoading();
        btnGenPrompts.disabled = false;
    }
});

// Tab 切换
$$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        switchTab(tab.dataset.tab);
        if (tab.dataset.tab === 'history') loadHistory();
    });
});

// 导出 TXT
btnExport.addEventListener('click', async () => {
    if (!currentJoke) {
        showToast('没有可导出的内容', 'error');
        return;
    }
    const result = await window.api.exportTxt(currentJoke);
    if (result.success) {
        showToast('导出成功！', 'success');
    }
});

// 复制全部
btnCopyAll.addEventListener('click', async () => {
    if (!currentJoke) return;

    let text = `主题：${currentJoke.topic}\n\n`;
    text += `=== 笑话脚本 ===\n\n`;
    currentJoke.scripts.forEach((s, i) => {
        text += `【第 ${i+1} 条】${s.title}\n${s.content}\n\n`;
    });

    if (currentJoke.prompts?.length) {
        text += `=== Q版卡通提示词 ===\n\n`;
        currentJoke.prompts.forEach((p, i) => {
            text += `【提示词 ${i+1}】\n${p}\n\n`;
        });
    }

    await window.api.copyText(text);
    showToast('已复制全部内容到剪贴板', 'success');
});

// 打开设置
btnSettings.addEventListener('click', () => {
    window.api.openSettings();
});

// 取消生成
btnCancel.addEventListener('click', () => {
    if (currentAbortController) {
        currentAbortController.abort();
        showToast('已取消生成', 'error');
    }
});

// ---- 启动初始化 ----
async function initApp() {
    try {
        const jokes = await window.api.loadJokes();
        if (jokes.length > 0) {
            // 自动加载最新的一条
            const latest = jokes[0];
            currentJoke = latest;
            currentFilename = latest._filename;
            displayJoke(latest);
            switchTab('scripts');
        } else {
            showEmptyState();
        }
    } catch (err) {
        console.error('[init] 加载历史失败:', err);
        showEmptyState();
    }

    // 绑定空状态的主题标签
    $$('.empty-hint-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            topicInput.value = chip.dataset.topic;
            topicInput.focus();
            topicInput.dispatchEvent(new Event('input'));
        });
    });
}

initApp();
