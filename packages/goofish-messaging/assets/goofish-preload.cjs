const { contextBridge, ipcRenderer } = require('electron');

contextBridge.executeInMainWorld({
  func: () => {
    const captureSymbol = Symbol.for('idle-fish:engine-manager');
    if (window[captureSymbol]) return;

    const capturedRequires = [];
    const capturedManagers = [];
    const wrappedFactories = new WeakSet();
    const wrappedRuntimes = new WeakSet();
    let rawPush = Array.prototype.push;

    const captureRequire = (require) => {
      if (typeof require === 'function' && !capturedRequires.includes(require)) capturedRequires.push(require);
    };

    const captureManager = (candidate) => {
      if (!candidate) return;
      let manager;
      if (typeof candidate === 'object' && typeof candidate.getSessionService === 'function' && typeof candidate.getMessageService === 'function') {
        manager = candidate;
      } else if (
        typeof candidate === 'function' &&
        typeof candidate.getInstance === 'function' &&
        typeof candidate.prototype?.getSessionService === 'function' &&
        typeof candidate.prototype?.getMessageService === 'function' &&
        (typeof candidate.prototype?.registerDataChangeLisnter === 'function' ||
          typeof candidate.prototype?.registerDataChangeListener === 'function')
      ) {
        try { manager = candidate.getInstance(); } catch (_) {}
      }
      if (manager && !capturedManagers.includes(manager)) capturedManagers.push(manager);
    };

    const inspectExports = (exports) => {
      captureManager(exports);
      if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return;
      for (const value of Object.values(exports)) captureManager(value);
    };

    const wrapFactory = (factory) => {
      if (typeof factory !== 'function' || wrappedFactories.has(factory)) return factory;
      const wrapped = function idleFishModuleCapture(module, exports, require) {
        captureRequire(require);
        const result = factory.apply(this, arguments);
        try { inspectExports(module?.exports); } catch (_) {}
        return result;
      };
      wrappedFactories.add(wrapped);
      return wrapped;
    };

    const wrapEntry = (entry) => {
      if (!Array.isArray(entry)) return entry;
      if (entry[1] && typeof entry[1] === 'object') {
        for (const moduleId of Object.keys(entry[1])) entry[1][moduleId] = wrapFactory(entry[1][moduleId]);
      }
      if (typeof entry[2] === 'function' && !wrappedRuntimes.has(entry[2])) {
        const runtime = entry[2];
        const wrapped = function idleFishRuntimeCapture(require) {
          captureRequire(require);
          return runtime.apply(this, arguments);
        };
        wrappedRuntimes.add(wrapped);
        entry[2] = wrapped;
      }
      return entry;
    };

    const storage = [];
    const chunkProxy = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'push') {
          const pushImplementation = rawPush;
          return (...entries) => Reflect.apply(pushImplementation, target, entries.map(wrapEntry));
        }
        return Reflect.get(target, property, receiver);
      },
      set(target, property, value, receiver) {
        if (property === 'push' && typeof value === 'function') {
          rawPush = value;
          return true;
        }
        return Reflect.set(target, property, value, receiver);
      },
    });

    Object.defineProperty(window, 'webpackChunk_ice_lite_scaffold', {
      configurable: true,
      get: () => chunkProxy,
      set: (value) => {
        if (value === chunkProxy || !Array.isArray(value)) return;
        value.forEach((entry) => chunkProxy.push(entry));
      },
    });

    Object.defineProperty(window, captureSymbol, {
      configurable: false,
      enumerable: false,
      value: () => {
        let best;
        let bestScore = -1;
        for (const manager of capturedManagers) {
          try {
            let store;
            try { store = manager.getStore?.(); } catch (_) {}
            const score = (manager._engine ? 100 : 0) + (store ? 50 : 0) + (manager.userId ? 20 : 0) + (manager.isConnectAvailable?.() ? 10 : 0);
            if (score > bestScore) {
              best = manager;
              bestScore = score;
            }
          } catch (_) {}
        }
        if (best) return best;
        for (const require of capturedRequires) {
          try {
            const module = require(7844);
            inspectExports(module);
          } catch (_) {}
        }
        return capturedManagers[0];
      },
    });
  },
});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.source !== 'idle-fish-bridge' || !data.type) return;
  ipcRenderer.send('goofish:event', data);
});

ipcRenderer.on('goofish:command', (_event, command) => {
  window.postMessage({ source: 'idle-fish-host', ...command }, '*');
});
