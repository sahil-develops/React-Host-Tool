const { app, BrowserWindow, ipcMain } = require('electron');
const { exec } = require('child_process');
const detect = require('detect-port');
const ngrok = require('ngrok');
const path = require('path');
const fs = require('fs');
const https = require('https');
const express = require('express');
const httpProxy = require('http-proxy');
const selfsigned = require('selfsigned');

class ReactHostTool {
  constructor() {
    this.mainWindow = null;
    this.localhostUrl = ''; // Store the user-provided localhost URL
    this.proxyPort = 3001;
    this.ngrokUrl = null;
    this.dockerContainerId = null;
  }

  async initialize() {
    try {
      this.mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
        },
      });

      this.mainWindow.loadFile('src/index.html');

      if (process.env.NODE_ENV === 'development') {
        this.mainWindow.webContents.openDevTools();
      }

      this.setupEventListeners();
    } catch (error) {
      this.sendStatus('error', `Initialization error: ${error.message}`);
    }
  }

  setupEventListeners() {
    ipcMain.on('start-process', async (event, localhostUrl) => {
      this.localhostUrl = localhostUrl; // Capture the user-entered localhost URL
      await this.startProcess();
    });
  }

  async startProcess() {
    try {
      // Step 1: Check Docker Status
      this.sendStatus('info', 'Checking Docker Status...', 'step1');
      const dockerRunning = await this.checkDockerStatus();
      if (!dockerRunning) return;
      this.sendStatus('success', 'Docker is running and accessible', 'step1');

      // Step 2: Check React Server
      this.sendStatus('info', 'Checking React Server...', 'step2');
      const reactRunning = await this.checkReactServer();
      if (!reactRunning) return;
      this.sendStatus('success', 'React development server is running', 'step2');

      // Step 3: Start Docker Container
      this.sendStatus('info', 'Starting Docker Container...', 'step3');
      await this.setupDockerContainer();
      this.sendStatus('success', 'Docker container is running', 'step3');

      // Step 4: Set up Ngrok
      this.sendStatus('info', 'Setting up Ngrok...', 'step4');
      await this.setupNgrok();
      this.sendStatus('success', `Ngrok tunnel established at: ${this.ngrokUrl}`, 'step4');

      // Step 5: Completed
      this.sendStatus('success', `Application hosted successfully at: ${this.ngrokUrl}`, 'step5');
    } catch (error) {
      this.sendStatus('error', `Process error: ${error.message}`);
    }
  }

  sendStatus(type, message, step = null) {
    if (this.mainWindow) {
      this.mainWindow.webContents.send('status-update', {
        type,
        message,
        step,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async checkDockerStatus() {
    try {
      await this.executeCommand('docker info');
      this.sendStatus('success', 'Docker is running and accessible');
      return true;
    } catch (error) {
      this.sendStatus('error', 'Docker is not running. Please start Docker Desktop');
      return false;
    }
  }

  async checkReactServer() {
    try {
      const isReactRunning = await this.checkPort(this.localhostUrl);
      if (isReactRunning) {
        this.sendStatus('success', 'React development server is running');
        return true;
      } else {
        this.sendStatus('error', 'React development server not detected');
        return false;
      }
    } catch (error) {
      this.sendStatus('error', `Error checking React server: ${error.message}`);
      return false;
    }
  }

  async setupDockerContainer() {
    try {
      this.sendStatus('info', 'Setting up Docker container...');

      const dockerfile = `
        FROM node:16
        WORKDIR /app
        COPY package*.json ./
        RUN npm install
        COPY . .
        EXPOSE 3000
        CMD ["npm", "start"]
      `;

      fs.writeFileSync('Dockerfile', dockerfile);
      this.sendStatus('info', 'Created Dockerfile');

      await this.executeCommand('docker build -t react-app .');
      this.sendStatus('info', 'Built Docker image');

      const { stdout } = await this.executeCommand('docker run -d -p 3003:3000 react-app');
      this.dockerContainerId = stdout.trim();
      this.sendStatus('success', 'Docker container running');
    } catch (error) {
      throw new Error(`Docker setup failed: ${error.message}`);
    }
  }

  async setupNgrok() {
    try {
      this.sendStatus('info', 'Setting up Ngrok tunnel...');
      await ngrok.authtoken('2oYa9n1ShdRec  K2vfYeck5rgYNq_2x9qaoGe5bLN3LEXR6JkF'); // Replace with your actual Ngrok auth token

      this.ngrokUrl = await ngrok.connect({
        addr: this.localhostUrl, // Use the user-provided localhost URL
        proto: 'http',
        region: 'us',
        host_header: 'rewrite', // Allows Ngrok to rewrite the host header
      });

      this.sendStatus('success', `Ngrok tunnel established at: ${this.ngrokUrl}`);
    } catch (error) {
      throw new Error(`Ngrok setup failed: ${error.message}`);
    }
  }

  async executeCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) reject(error);
        resolve({ stdout, stderr });
      });
    });
  }

  async checkPort(localhostUrl) {
    try {
      const url = new URL(localhostUrl);
      const port = url.port || 80; // Get the port from the URL, default to 80
      const _port = await detect(port);
      return _port !== port;
    } catch (error) {
      throw new Error(`Port check failed: ${error.message}`);
    }
  }

  async cleanup() {
    try {
      this.sendStatus('info', 'Cleaning up...');

      if (this.dockerContainerId) {
        await this.executeCommand(`docker stop ${this.dockerContainerId}`);
        await this.executeCommand(`docker rm ${this.dockerContainerId}`);
        this.dockerContainerId = null;
        this.sendStatus('info', 'Docker container stopped and removed');
      }

      if (this.ngrokUrl) {
        await ngrok.disconnect();
        this.ngrokUrl = null;
        this.sendStatus('info', 'Ngrok tunnel disconnected');
      }

      this.sendStatus('success', 'Cleanup completed successfully');
    } catch (error) {
      this.sendStatus('error', `Cleanup error: ${error.message}`);
    }
  }
}

// App lifecycle management
let reactHost;

app.on('ready', () => {
  reactHost = new ReactHostTool();
  reactHost.initialize();
});

app.on('window-all-closed', async () => {
  if (reactHost) {
    await reactHost.cleanup();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    reactHost = new ReactHostTool();
    reactHost.initialize();
  }
});
