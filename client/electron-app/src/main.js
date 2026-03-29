const { app, BrowserWindow } = require("electron");
const path = require("path");

let mainWindow;

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 700,
    minHeight: 500,
    title: "LLM Proxy Client",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer.html"));

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
