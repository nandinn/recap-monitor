const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const chokidar = require('chokidar');
const Store = require('electron-store');
const ffprobe = require('ffprobe-static');
const { autoUpdater } = require('electron-updater'); // <--- NOVO

// --- FIREBASE ---
const { initializeApp } = require("firebase/app");
const { getFirestore, doc, setDoc, deleteDoc, getDoc } = require("firebase/firestore");

const firebaseConfig = {
  apiKey: "AIzaSyBu4avArTe1osa31bgnQgVwOabEdAfVAY4",
  authDomain: "recap-monitor.firebaseapp.com",
  projectId: "recap-monitor",
  storageBucket: "recap-monitor.firebasestorage.app",
  messagingSenderId: "341016683998",
  appId: "1:341016683998:web:81392a4b25147b1e6fa94f",
  measurementId: "G-G5WV1F6Z3Q"
};

const firebaseApp = initializeApp(firebaseConfig);
const dbFirestore = getFirestore(firebaseApp);

// --- STORE ---
const store = new Store();

let watcher = null;
let tray = null;
let mainWindow = null;
let isQuitting = false;
const MAX_PROCESS_RETRIES = 720; 

// Caminhos
const documentsPath = app.getPath('documents');
const appFolder = path.join(documentsPath, 'RecapMonitor');
const logFilePath = path.join(appFolder, 'recap_monitor_log.csv');

if (!fs.existsSync(appFolder)) {
  try { fs.mkdirSync(appFolder, { recursive: true }); } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 1024, minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true,
    },
    icon: path.join(__dirname, 'icon.png'),
    frame: true,
    backgroundColor: '#0f172a'
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile('index.html');

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      new Notification({ title: 'Recap Monitor', body: 'Rodando em segundo plano.', icon: path.join(__dirname, 'icon.png') }).show();
      return false;
    }
  });
  
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('load-data', {
      monitoringPath: store.get('monitoringPath'),
      stats: getStats(),
      logs: store.get('logs', []).slice(-20).reverse(),
      discordId: store.get('discordId', ''),
      recentVideos: store.get('videos', []).slice(-5).reverse(),
      metaList: store.get('metaList', []),
      activeGame: store.get('activeGame', null)
    });
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Sair', click: () => { isQuitting = true; app.quit(); }}
  ]);
  tray.setToolTip('Recap Monitor');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow.show());
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  const monitoringPath = store.get('monitoringPath');
  if (monitoringPath && fs.existsSync(monitoringPath)) startMonitoring(monitoringPath);
  
  // --- AUTO UPDATER ---
  if (app.isPackaged) { // Só verifica se estiver compilado (.exe)
      autoUpdater.checkForUpdatesAndNotify();
  }
});

// --- EVENTOS DE UPDATE ---
autoUpdater.on('update-available', () => {
    logMessage('Nova atualização disponível. Baixando...', 'info');
});

autoUpdater.on('update-downloaded', () => {
    logMessage('Atualização baixada. Reinicie para aplicar.', 'success');
    notifyAllWindows('update-ready', null); // Avisa o front-end
});

ipcMain.handle('restart-and-update', () => {
    autoUpdater.quitAndInstall();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// --- MONITORAMENTO ---
function startMonitoring(folderPath) {
  if (watcher) watcher.close();
  logMessage(`Monitorando: ${folderPath}`);
  const normalizedPath = path.resolve(folderPath).replace(/\\/g, '/');
  watcher = chokidar.watch(`${normalizedPath}/**/video.mp4`, {
    persistent: true, ignoreInitial: true, 
    awaitWriteFinish: { stabilityThreshold: 15000, pollInterval: 100 }
  });
  watcher.on('add', (filePath) => {
    const normalizedFile = path.resolve(filePath);
    logMessage(`Detectado: ${normalizedFile}`);
    processVideo(normalizedFile);
  });
}

function processVideo(filePath) {
  const normalizedPath = path.resolve(filePath);
  const processed = store.get('processedFiles', {});
  if (processed[normalizedPath]) return;
  
  const activeGame = store.get('activeGame');
  if (!activeGame) {
    logMessage(`Ignorado: Nenhum jogo selecionado na aba Metas.`, 'warn');
    return;
  }
  logMessage(`Processando para: ${activeGame}...`);
  attemptToProcessVideo(normalizedPath, MAX_PROCESS_RETRIES);
}

function attemptToProcessVideo(filePath, retriesLeft) {
  if (retriesLeft <= 0) return logMessage(`Falha ao processar ${filePath}`, 'error');
  const ffprobeArgs = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
  execFile(ffprobe.path, ffprobeArgs, (error, stdout, stderr) => {
    if (error) {
      if (stderr && stderr.includes('moov atom not found')) {
        logMessage(`Aguardando arquivo fechar... (${retriesLeft})`, 'warn');
        setTimeout(() => attemptToProcessVideo(filePath, retriesLeft - 1), 2000);
      } else {
        logMessage(`Erro FFmpeg: ${error.message}`, 'error');
      }
      return;
    }
    const duration = parseFloat(stdout.trim());
    if (!isNaN(duration)) onProcessSuccess(filePath, duration);
  });
}

async function onProcessSuccess(filePath, duration) {
  const normalizedPath = path.resolve(filePath);
  const activeGameName = store.get('activeGame');
  if (!activeGameName) return; 
  const processedCheck = store.get('processedFiles', {});
  if (processedCheck[normalizedPath]) return;

  const videoData = {
    path: normalizedPath, duration: duration, timestamp: new Date().toISOString(), gameName: activeGameName 
  };

  const discordId = store.get('discordId');
  let metaList = store.get('metaList', []);
  const gameIndex = metaList.findIndex(g => g.name === activeGameName);
  
  if (gameIndex !== -1) {
    metaList[gameIndex].currentSeconds += duration;
    if (metaList[gameIndex].currentSeconds >= (metaList[gameIndex].targetMinutes * 60)) {
      metaList[gameIndex].completed = true;
    }
    store.set('metaList', metaList);
    notifyAllWindows('meta-update', { metaList, activeGame: activeGameName });
  }

  const videos = store.get('videos', []);
  videos.push(videoData);
  store.set('videos', videos);
  appendToCSV(videoData);
  
  const processed = store.get('processedFiles', {});
  processed[normalizedPath] = true;
  store.set('processedFiles', processed);
  store.set('stats', getStats()); 

  if (discordId) {
      try {
          const docId = videoData.timestamp.replace(/[:.]/g, '');
          await setDoc(doc(dbFirestore, "users", discordId, "videos", docId), {
              gameName: videoData.gameName, duration: videoData.duration, timestamp: videoData.timestamp, updatedAt: new Date().toISOString(), filePath: normalizedPath 
          });
          logMessage('Sincronizado com Firebase!', 'info');
      } catch (err) { logMessage(`Erro Firebase: ${err.message}`, 'error'); }
  }

  notifyAllWindows('video-processed', { video: videoData, stats: getStats(), recentVideos: store.get('videos', []).slice(-5).reverse() });
  
  if (metaList[gameIndex] && metaList[gameIndex].completed) {
      new Notification({ title: "Meta Atingida! 🎉", body: `Você completou o tempo de ${activeGameName}.`, icon: path.join(__dirname, 'icon.png') }).show();
  } else {
      new Notification({ title: "Recap Monitor", body: `+${duration.toFixed(0)}s em ${activeGameName}`, icon: path.join(__dirname, 'icon.png') }).show();
  }
}

function createCSVRow(data) {
  const h = Math.floor(data.duration / 3600);
  const m = Math.floor((data.duration % 3600) / 60);
  const s = Math.floor(data.duration % 60);
  const durFmt = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  const game = `"${data.gameName.replace(/"/g, '""')}"`;
  return `${data.timestamp},${game},${durFmt},${data.duration.toFixed(2)},${(data.duration/3600).toFixed(4)},"${data.path}"\n`;
}
function appendToCSV(data) {
  try { 
      if (!fs.existsSync(logFilePath)) fs.writeFileSync(logFilePath, "Timestamp,Jogo,Duracao_Fmt,Duracao_Seg,Duracao_Horas,Caminho\n", 'utf-8');
      fs.appendFileSync(logFilePath, createCSVRow(data), 'utf-8'); 
  } catch(e){}
}
function rebuildCSV(videos) {
  let content = "Timestamp,Jogo,Duracao_Fmt,Duracao_Seg,Duracao_Horas,Caminho\n";
  videos.forEach(v => content += createCSVRow(v));
  try { fs.writeFileSync(logFilePath, content, 'utf-8'); } catch(e){}
}

function getStats() {
  const videos = store.get('videos', []);
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0,0,0,0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  let weekly = 0, monthly = 0;
  for (const v of videos) {
    const d = new Date(v.timestamp);
    if (d >= startOfWeek) weekly += v.duration;
    if (d >= startOfMonth) monthly += v.duration;
  }
  return { totalWeekly: weekly, totalMonthly: monthly };
}

ipcMain.handle('get-meta-list', () => ({ metaList: store.get('metaList', []), activeGame: store.get('activeGame', null) }));
ipcMain.handle('add-game-to-meta', (e, { name, targetMinutes }) => {
  const list = store.get('metaList', []);
  if (!list.some(g => g.name === name)) {
    list.push({ name, targetMinutes, currentSeconds: 0, completed: false });
    store.set('metaList', list);
  }
  return { metaList: list, activeGame: store.get('activeGame') };
});
ipcMain.handle('remove-game-from-meta', (e, gameName) => {
  let list = store.get('metaList', []);
  list = list.filter(g => g.name !== gameName);
  store.set('metaList', list);
  if (store.get('activeGame') === gameName) store.set('activeGame', null);
  return { metaList: list, activeGame: store.get('activeGame') };
});
ipcMain.handle('set-active-game', (e, gameName) => {
  const list = store.get('metaList', []);
  const game = list.find(g => g.name === gameName);
  if (store.get('activeGame') === gameName) {
    store.set('activeGame', null);
    logMessage('Gravação pausada.');
  } else if (game) {
    store.set('activeGame', gameName);
    logMessage(`Jogo Ativo: ${gameName}`);
  }
  return { metaList: list, activeGame: store.get('activeGame') };
});
ipcMain.handle('reset-daily-metas', () => {
  let list = store.get('metaList', []);
  list = list.map(g => ({ ...g, currentSeconds: 0, completed: false }));
  store.set('metaList', list);
  store.set('activeGame', null);
  logMessage('Metas diárias resetadas.');
  return { metaList: list, activeGame: null };
});
ipcMain.handle('import-meta-list', (e, gamesRaw) => {
  const newList = gamesRaw.map(g => ({ name: g.name, targetMinutes: parseInt(g.target) || 60, currentSeconds: 0, completed: false }));
  store.set('metaList', newList);
  store.set('activeGame', null);
  logMessage(`Lista importada com ${newList.length} jogos.`);
  return { metaList: newList, activeGame: null };
});
ipcMain.handle('dialog:openDirectory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (!canceled && filePaths[0]) {
    store.set('monitoringPath', filePaths[0]); 
    startMonitoring(filePaths[0]); 
    return filePaths[0];
  }
  return null;
});
ipcMain.handle('open-log-file', () => fs.existsSync(logFilePath) ? shell.showItemInFolder(logFilePath) : shell.openPath(appFolder));
ipcMain.handle('save-discord-id', (e, id) => { store.set('discordId', id); logMessage('ID Discord salvo.', 'info'); });

ipcMain.handle('delete-video-entry', async (e, ts) => {
  const videos = store.get('videos', []);
  const idx = videos.findIndex(v => v.timestamp === ts);
  if (idx === -1) return { stats: getStats(), recentVideos: [] };
  const deleted = videos.splice(idx, 1)[0];
  store.set('videos', videos); 
  
  let metaList = store.get('metaList', []);
  const gameIndex = metaList.findIndex(g => g.name === deleted.gameName);
  if (gameIndex !== -1) {
      metaList[gameIndex].currentSeconds = Math.max(0, metaList[gameIndex].currentSeconds - deleted.duration);
      if (metaList[gameIndex].currentSeconds < (metaList[gameIndex].targetMinutes * 60)) metaList[gameIndex].completed = false;
      store.set('metaList', metaList);
      notifyAllWindows('meta-update', { metaList, activeGame: store.get('activeGame') });
  }
  
  const discordId = store.get('discordId');
  if (discordId) {
      try {
          const docId = ts.replace(/[:.]/g, '');
          await deleteDoc(doc(dbFirestore, "users", discordId, "videos", docId));
          logMessage('Removido do Firebase.', 'info');
      } catch (err) { logMessage(`Erro delete Firebase: ${err.message}`, 'error'); }
  }
  rebuildCSV(videos);
  return { stats: getStats(), recentVideos: store.get('videos', []).slice(-5).reverse() };
});

ipcMain.handle('get-daily-data', () => {
  const videos = store.get('videos', []);
  return videos.reduce((acc, v) => {
    const d = new Date(v.timestamp).toISOString().split('T')[0]; 
    if (!acc[d]) acc[d] = { totalSeconds: 0, entries: [] };
    acc[d].totalSeconds += v.duration;
    acc[d].entries.push(v);
    return acc;
  }, {});
});

ipcMain.handle('scan-folder', async () => {
    const dir = store.get('monitoringPath');
    if (!dir || !fs.existsSync(dir)) return { success: false, message: 'Pasta inválida.' };
    logMessage('Escaneando...', 'info');
    let added = 0;
    const scan = (d) => {
        try { fs.readdirSync(d).forEach(f => {
            const full = path.join(d, f);
            if (fs.statSync(full).isDirectory()) scan(full);
            else if (f === 'video.mp4') {
                 if (!store.get('processedFiles', {})[path.resolve(full)]) {
                    processVideo(full); added++;
                 }
            }
        }); } catch(e){}
    };
    scan(dir);
    return { success: true, message: added ? `Encontrados ${added} novos.` : 'Tudo em dia.' };
});

function logMessage(msg, level = 'info') {
  const logs = store.get('logs', []);
  logs.push({ level, message: msg, timestamp: new Date().toISOString() });
  store.set('logs', logs.slice(-100)); 
  notifyAllWindows('log-message', { level, message: msg });
}

function notifyAllWindows(chan, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(chan, data);
}