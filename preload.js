/**
 * preload.js — Electron context bridge
 * Exposes safe IPC methods to renderer (HTML screens)
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('FP', {

  /* navigate to another screen */
  navigate: (screen, data = {}) =>
    ipcRenderer.invoke('navigate', { screen, data }),

  /* get current session data */
  getSession: () => ipcRenderer.invoke('get-session'),

  /* reset idle timer on user interaction */
  resetIdle: () => ipcRenderer.invoke('reset-idle'),

  /* GCash payment */
  gcash: {
    createQR:    (amount, sessionId) => ipcRenderer.invoke('gcash-create-qr', { amount, sessionId }),
    checkStatus: (referenceId)       => ipcRenderer.invoke('gcash-check-status', { referenceId }),
  },

  /* camera */
  camera: {
    capture:        (args) => ipcRenderer.invoke('camera-capture', args),
    captureWebcam:  (args) => ipcRenderer.invoke('camera-capture-webcam', args),
    startPreview:   ()     => ipcRenderer.invoke('camera-preview-start'),
    stopPreview:    ()     => ipcRenderer.invoke('camera-preview-stop'),
  },

  /* printer */
  printer: {
    print:     (args) => ipcRenderer.invoke('print-strip', args),
    getStatus: ()     => ipcRenderer.invoke('printer-status'),
  },

  /* receipt */
  sendReceipt: (type, contact, session) =>
    ipcRenderer.invoke('send-receipt', { type, contact, session }),

  /* listen for GCash payment confirmation pushed from main */
  onPaymentConfirmed: (callback) =>
    ipcRenderer.on('payment-confirmed', (_, data) => callback(data)),

  /* log errors to main */
  logError: (msg) => ipcRenderer.send('log-error', msg),

  /* watchdog: reboot the app cleanly (watchdog will restart it) */
  reboot: () => ipcRenderer.invoke('reboot-app'),
});