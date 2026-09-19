function partitionFor(accountId, prefix = 'goofish-messaging') {
  return `persist:${prefix}-${accountId}`;
}

function hostMatches(rawUrl, hosts) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch (_) {
    return false;
  }
}

function registerWindowShortcuts(window) {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const primary = Boolean(input.control || input.meta);
    const extra = Boolean(input.alt || input.shift);
    if (key === 'r' && primary && !extra) {
      event.preventDefault();
      window.webContents.reload();
    } else if (key === 'f12' && !primary && !extra) {
      event.preventDefault();
      window.webContents.toggleDevTools();
    }
  });
}

function installSinglePopupHandler(parentWindow, options = {}) {
  const parentWebContents = parentWindow.webContents;
  let popupWindow = null;
  let opening = false;
  let openingTimer = null;
  let disposed = false;
  let focusScheduled = false;

  const clearOpening = () => {
    opening = false;
    if (openingTimer) clearTimeout(openingTimer);
    openingTimer = null;
  };

  const destroyPopup = () => {
    const popup = popupWindow;
    popupWindow = null;
    clearOpening();
    if (popup && !popup.isDestroyed()) popup.destroy();
  };

  const windowOpenHandler = ({ url }) => {
    if (disposed || !options.isAllowed?.(url)) return { action: 'deny' };
    if (popupWindow && !popupWindow.isDestroyed()) {
      if (!focusScheduled) {
        focusScheduled = true;
        setImmediate(() => {
          focusScheduled = false;
          if (disposed || !popupWindow || popupWindow.isDestroyed()) return;
          popupWindow.setSkipTaskbar?.(true);
          popupWindow.show?.();
          popupWindow.focus?.();
        });
      }
      return { action: 'deny' };
    }
    if (opening) return { action: 'deny' };
    opening = true;
    openingTimer = setTimeout(clearOpening, 5_000);
    return {
      action: 'allow',
      overrideBrowserWindowOptions: options.browserWindowOptions,
    };
  };

  const didCreateWindow = (window) => {
    if (disposed) {
      if (!window.isDestroyed()) window.destroy();
      return;
    }
    if (popupWindow && popupWindow !== window && !popupWindow.isDestroyed()) {
      if (!window.isDestroyed()) window.destroy();
      return;
    }
    popupWindow = window;
    clearOpening();
    window.setSkipTaskbar?.(true);
    window.once('closed', () => {
      if (popupWindow === window) popupWindow = null;
      clearOpening();
    });
  };

  parentWebContents.setWindowOpenHandler(windowOpenHandler);
  parentWebContents.on('did-create-window', didCreateWindow);

  return {
    get window() { return popupWindow; },
    dispose() {
      if (disposed) return;
      disposed = true;
      focusScheduled = false;
      if (!parentWebContents.isDestroyed?.()) {
        parentWebContents.removeListener('did-create-window', didCreateWindow);
        parentWebContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      }
      destroyPopup();
    },
  };
}

module.exports = {
  hostMatches,
  installSinglePopupHandler,
  partitionFor,
  registerWindowShortcuts,
};
