const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Store operations
    getConfig: (key) => ipcRenderer.invoke('store:get', key),
    setConfig: (key, value) => ipcRenderer.invoke('store:set', key, value),

    // API config
    getApiConfig: () => ipcRenderer.invoke('get-api-config'),
    saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),

    // Joke data operations
    saveJoke: (data) => ipcRenderer.invoke('save-joke', data),
    updateJoke: (filename, data) => ipcRenderer.invoke('update-joke', filename, data),
    loadJokes: () => ipcRenderer.invoke('load-jokes'),
    deleteJoke: (filename) => ipcRenderer.invoke('delete-joke', filename),

    // Export and clipboard
    exportTxt: (data) => ipcRenderer.invoke('export-txt', data),
    copyText: (text) => ipcRenderer.invoke('copy-text', text),

    // Settings window
    openSettings: () => ipcRenderer.invoke('open-settings')
});
