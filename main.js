const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Electron Store - lazy import
let Store;
try {
    Store = require('electron-store');
} catch {
    // Fallback if electron-store fails
}

let mainWindow = null;
let settingsWindow = null;
let store = null;

// Data file path
const DATA_DIR = path.join(app.getPath('userData'), 'jokes');

function initStore() {
    if (Store) {
        store = new Store({
            name: 'config',
            defaults: { apiKey: '', baseUrl: 'https://api.deepseek.com' }
        });
    } else {
        // Manual fallback
        const configPath = path.join(app.getPath('userData'), 'config.json');
        store = {
            get(key) {
                try {
                    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    return data[key];
                } catch { return undefined; }
            },
            set(key, value) {
                let data = {};
                try { data = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
                data[key] = value;
                fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
            }
        };
    }
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 780,
        minWidth: 900,
        minHeight: 600,
        title: '段子工作台',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 18 },
        backgroundColor: '#06080F',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    mainWindow.on('closed', () => { mainWindow = null; });
}

function createSettingsWindow() {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 520,
        height: 440,
        resizable: false,
        title: '设置',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 18 },
        backgroundColor: '#06080F',
        parent: mainWindow,
        modal: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    settingsWindow.loadFile(path.join(__dirname, 'src', 'settings.html'));
    settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---- IPC Handlers ----
// 注意：依赖 store 的 handler 在 app.whenReady() 中 initStore() 之后注册

// Save joke data to local file
ipcMain.handle('save-joke', async (event, data) => {
    ensureDataDir();
    const filename = `joke_${Date.now()}.json`;
    const filepath = path.join(DATA_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    return { success: true, path: filepath, filename };
});

// Update an existing joke file (overwrite with new data)
ipcMain.handle('update-joke', async (event, filename, data) => {
    ensureDataDir();
    // 安全检查：防止路径穿越
    const basename = path.basename(filename);
    if (basename !== filename || filename.includes('..')) {
        return { success: false, error: 'Invalid filename' };
    }
    const filepath = path.join(DATA_DIR, basename);
    if (fs.existsSync(filepath)) {
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
        return { success: true, filename: basename };
    }
    // 如果文件不存在，创建新文件
    const newFilename = `joke_${Date.now()}.json`;
    const newPath = path.join(DATA_DIR, newFilename);
    fs.writeFileSync(newPath, JSON.stringify(data, null, 2), 'utf8');
    return { success: true, filename: newFilename };
});

// Load all saved jokes
ipcMain.handle('load-jokes', async () => {
    ensureDataDir();
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    const jokes = [];
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
            jokes.push({ ...data, _filename: file });
        } catch {}
    }
    return jokes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
});

// Delete a joke
ipcMain.handle('delete-joke', async (event, filename) => {
    ensureDataDir();
    // 安全检查：防止路径穿越
    const basename = path.basename(filename);
    if (basename !== filename || filename.includes('..')) {
        return false;
    }
    const filepath = path.join(DATA_DIR, basename);
    if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
        return true;
    }
    return false;
});

// Export to TXT
ipcMain.handle('export-txt', async (event, data) => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出 TXT',
        defaultPath: path.join(app.getPath('desktop'), `${data.topic || '段子'}_${new Date().toLocaleDateString('zh-CN')}.txt`),
        filters: [{ name: 'Text Files', extensions: ['txt'] }]
    });

    if (result.canceled) return { success: false };

    let content = `=== 段子工作台 ===\n`;
    content += `主题: ${data.topic}\n`;
    content += `生成时间: ${new Date(data.createdAt).toLocaleString('zh-CN')}\n`;
    content += `${'='.repeat(40)}\n\n`;

    if (data.scripts && data.scripts.length > 0) {
        content += `>>> 笑话脚本 <<<\n\n`;
        data.scripts.forEach((s, i) => {
            content += `【第 ${i + 1} 条】${s.title || ''}\n`;
            content += `${s.content}\n\n`;
        });
    }

    if (data.prompts && data.prompts.length > 0) {
        content += `${'='.repeat(40)}\n`;
        content += `>>> Q版卡通提示词 <<<\n\n`;
        data.prompts.forEach((p, i) => {
            content += `【提示词 ${i + 1}】\n${p}\n\n`;
        });
    }

    fs.writeFileSync(result.filePath, content, 'utf8');
    return { success: true, path: result.filePath };
});

// Copy to clipboard
ipcMain.handle('copy-text', async (event, text) => {
    clipboard.writeText(text);
    return true;
});

// Open settings
ipcMain.handle('open-settings', () => {
    createSettingsWindow();
    return true;
});

// ---- App Lifecycle ----

app.whenReady().then(() => {
    initStore();

    // 注册依赖 store 的 IPC handlers（必须在 initStore 之后）
    ipcMain.handle('store:get', (event, key) => store.get(key));
    ipcMain.handle('store:set', (event, key, value) => store.set(key, value));
    ipcMain.handle('get-api-config', () => ({
        apiKey: store.get('apiKey') || '',
        baseUrl: store.get('baseUrl') || 'https://api.deepseek.com'
    }));
    ipcMain.handle('save-api-key', (event, key) => {
        store.set('apiKey', key);
        return true;
    });

    // macOS menu
    const template = [
        {
            label: app.name,
            submenu: [
                { role: 'about', label: '关于 段子工作台' },
                { type: 'separator' },
                { label: '设置...', accelerator: 'Cmd+,', click: () => createSettingsWindow() },
                { type: 'separator' },
                { role: 'hide', label: '隐藏' },
                { role: 'hideOthers', label: '隐藏其他' },
                { role: 'unhide', label: '全部显示' },
                { type: 'separator' },
                { role: 'quit', label: '退出' }
            ]
        },
        {
            label: '编辑',
            submenu: [
                { role: 'undo', label: '撤销' },
                { role: 'redo', label: '重做' },
                { type: 'separator' },
                { role: 'cut', label: '剪切' },
                { role: 'copy', label: '复制' },
                { role: 'paste', label: '粘贴' },
                { role: 'selectAll', label: '全选' }
            ]
        },
        {
            label: '窗口',
            submenu: [
                { role: 'minimize', label: '最小化' },
                { role: 'close', label: '关闭' }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));

    createMainWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
