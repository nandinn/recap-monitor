const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // Metas e Dados
    getMetaList: () => ipcRenderer.invoke('get-meta-list'),
    addGameToMeta: (game) => ipcRenderer.invoke('add-game-to-meta', game),
    removeGameFromMeta: (name) => ipcRenderer.invoke('remove-game-from-meta', name),
    setActiveGame: (name) => ipcRenderer.invoke('set-active-game', name),
    resetDailyMetas: () => ipcRenderer.invoke('reset-daily-metas'),
    importMetaList: (games) => ipcRenderer.invoke('import-meta-list', games),
    
    // Dados e Logs
    getDailyData: () => ipcRenderer.invoke('get-daily-data'),
    deleteVideoEntry: (ts) => ipcRenderer.invoke('delete-video-entry', ts),
    
    // Sistema
    selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
    openLogFile: () => ipcRenderer.invoke('open-log-file'),
    scanFolder: () => ipcRenderer.invoke('scan-folder'),
    exportData: () => ipcRenderer.invoke('export-data'),
    saveDiscordId: (id) => ipcRenderer.invoke('save-discord-id', id),

    // UPDATE DO SISTEMA (NOVO)
    restartAndUpdate: () => ipcRenderer.invoke('restart-and-update'),
    onUpdateReady: (callback) => ipcRenderer.on('update-ready', (_, value) => callback(value)),

    // Eventos (Listeners)
    onLoadData: (callback) => ipcRenderer.on('load-data', (_, value) => callback(value)),
    onMetaUpdate: (callback) => ipcRenderer.on('meta-update', (_, value) => callback(value)),
    onVideoProcessed: (callback) => ipcRenderer.on('video-processed', (_, value) => callback(value)),
    onLogMessage: (callback) => ipcRenderer.on('log-message', (_, value) => callback(value))
});