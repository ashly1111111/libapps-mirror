// Copyright 2019 The Chromium OS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {definePrefs, loadPowerlineWebFonts, loadWebFont, normalizeCSSFontFamily,
  watchBackgroundColor} from './terminal_common.js';

export const terminal = {};

/** @type {!lib.PreferenceManager} */
window.preferenceManager;

/**
 * The Terminal command.
 *
 * This class defines a command that can be run in an hterm.Terminal instance.
 * The Terminal command uses the terminalPrivate extension API to create and
 * use the vmshell process on a Chrome OS machine.
 *
 * @param {{
     commandName: string,
 *   args: !Array<string>,
 * }} argv The argument object passed in from the Terminal.
 * @constructor
 */
terminal.Command = function(argv) {
  this.commandName = argv.commandName;
  this.argv_ = argv;
  this.io = null;
  this.keyboard_ = null;
  // We pass this ID to chrome to use for startup text which is sent before the
  // vsh process is created and we receive an ID from openTerminalProcess.
  this.id_ = Math.random().toString().substring(2);
  argv.args.push(`--startup_id=${this.id_}`);
  this.isFirstOutput = false;
};

/**
 * Return a formatted message in the current locale.
 *
 * @param {string} name The name of the message to return.
 * @param {!Array=} args The message arguments, if required.
 * @return {string} The localized & formatted message.
 */
terminal.msg = function(name, args) {
  return hterm.messageManager.get(name, args);
};

/**
 * Create a new window to the options page for customizing preferences.
 */
terminal.openOptionsPage = function() {
  chrome.terminalPrivate.openOptionsPage(() => {});
};

/**
 * Either send a ^N or open a new tabbed terminal window.
 *
 * @this {!hterm.Keyboard.KeyMap}
 * @param {!KeyboardEvent} e The event to process.
 * @param {!hterm.Keyboard.KeyDef} k
 * @return {!hterm.Keyboard.KeyDefFunction|string} Key action or sequence.
 */
terminal.onCtrlN = function(e, k) {
  if (e.shiftKey || this.keyboard.terminal.passCtrlN) {
    return function(e, k) {
      chrome.terminalPrivate.openWindow(() => {});
      return hterm.Keyboard.KeyActions.CANCEL;
    };
  }

  return '\x0e';
};

/**
 * Static initializer.
 *
 * This constructs a new hterm.Terminal instance and instructs it to run
 * the Terminal command.
 *
 * @param {!Element} element The element that is to be decorated.
 * @return {!hterm.Terminal} The new hterm.Terminal instance.
 */
terminal.init = function(element) {
  const params = new URLSearchParams(document.location.search);
  const term = new hterm.Terminal();

  term.decorate(element);
  const runTerminal = function() {
    term.keyboard.bindings.addBinding('Ctrl+Shift+P', function() {
      terminal.openOptionsPage();
      return hterm.Keyboard.KeyActions.CANCEL;
    });

    term.onOpenOptionsPage = terminal.openOptionsPage;
    term.keyboard.keyMap.keyDefs[78].control = terminal.onCtrlN;
    term.setCursorPosition(0, 0);
    term.setCursorVisible(true);
    term.runCommandClass(
        terminal.Command, 'vmshell', params.getAll('args[]'));

    term.command.keyboard_ = term.keyboard;
  };
  term.onTerminalReady = function() {
    const prefs = term.getPrefs();
    definePrefs(prefs);
    watchBackgroundColor(prefs, /* updateBody= */ true);
    terminal.watchLocalStorageBackgroundImage(term);

    loadPowerlineWebFonts(term.getDocument());
    const onFontFamilyChanged = async (cssFontFamily) => {
      const fontFamily = normalizeCSSFontFamily(cssFontFamily);
      // If the user changes font quickly enough, we might have a pending
      // loadWebFont() task, but it should be harmless. Potentially, we can
      // implement a cancellable promise so that we can cancel it.
      try {
        await loadWebFont(term.getDocument(), fontFamily);
      } catch (error) {
        /* eslint-disable-next-line no-new */
        new Notification(
            terminal.msg('TERMINAL_FONT_UNAVAILABLE', [fontFamily]),
            {
              body: terminal.msg('TERMINAL_TRY_AGAIN_WITH_INTERNET'),
              tag: 'TERMINAL_FONT_UNAVAILABLE',
            },
        );
      }
    };
    onFontFamilyChanged(prefs.get('font-family'));
    prefs.addObserver('font-family', onFontFamilyChanged);

    chrome.terminalPrivate.onA11yStatusChanged.addListener(
        (enabled) => term.setAccessibilityEnabled(enabled));
    chrome.terminalPrivate.getA11yStatus((enabled) => {
      term.setAccessibilityEnabled(enabled);
      runTerminal();
    });
  };

  term.contextMenu.setItems([
    {name: terminal.msg('TERMINAL_CLEAR_MENU_LABEL'),
     action: function() { term.wipeContents(); }},
    {name: terminal.msg('TERMINAL_RESET_MENU_LABEL'),
     action: function() { term.reset(); }},
    {name: terminal.msg('TERMINAL_TITLE_SETTINGS'),
     action: function() { terminal.openOptionsPage(); }},
  ]);

  return term;
};

/**
 * Called when an event from the vmshell process is detected.
 *
 * @param {string} id Id of the process the event came from.
 * @param {string} type Type of the event.
 *             'stdout': Process output detected.
 *             'exit': Process has exited.
 * @param {string} text Text that was detected on process output.
 */
terminal.Command.prototype.onProcessOutput_ = function(id, type, text) {
  if (id !== this.id_) {
    return;
  }

  // When terminal starts, the first message may be type 'exit' if the process
  // fails to start.  In this case, we don't want to close the tab since we
  // can display an error message to the user.
  if (type == 'exit' && !this.isFirstOutput_) {
    this.exit(0);
    return;
  }
  this.io.print(text);
  this.isFirstOutput_ = false;
};

/**
 * Start the terminal command.
 *
 * This is invoked by the terminal as a result of terminal.runCommandClass().
 */
terminal.Command.prototype.run = function() {
  this.io = this.argv_.io.push();

  if (!chrome.terminalPrivate) {
    this.io.println(
        'Launching terminal failed: chrome.terminalPrivate not found');
    this.exit(1);
    return;
  }

  this.io.onVTKeystroke = this.io.sendString = this.sendString_.bind(this);

  this.io.onTerminalResize = this.onTerminalResize_.bind(this);
  chrome.terminalPrivate.onProcessOutput.addListener(
      this.onProcessOutput_.bind(this));
  document.body.onunload = this.close_.bind(this);

  const pidInit = (id) => {
    if (id === undefined) {
      this.io.println(
          `Launching ${this.commandName} failed: ${lib.f.lastError('')}`);
      this.exit(1);
      return;
    }

    window.onbeforeunload = this.onBeforeUnload_.bind(this);
    this.id_ = id;
    this.isFirstOutput_ = true;

    // Setup initial window size.
    this.onTerminalResize_(
        this.io.terminal_.screenSize.width,
        this.io.terminal_.screenSize.height);
  };

  // TODO(crbug.com/1056049): Remove openTerminalProcess once chrome supports
  // openVmshellProcess on all releases.
  if (chrome.terminalPrivate.openVmshellProcess) {
    chrome.terminalPrivate.openVmshellProcess(this.argv_.args, pidInit);
  } else {
    chrome.terminalPrivate.openTerminalProcess(
        this.commandName, this.argv_.args, pidInit);
  }
};

/**
 * Registers with window.onbeforeunload and runs when page is unloading.
 *
 * @param {?Event} e Before unload event.
 */
terminal.Command.prototype.onBeforeUnload_ = function(e) {
  // Set e.returnValue to any string for chrome to display a warning.
  e.returnValue = '';
};

/**
 * Send a string to the terminal process.
 *
 * @param {string} string The string to send.
 */
terminal.Command.prototype.sendString_ = function(string) {
  chrome.terminalPrivate.sendInput(this.id_, string);
};

/**
 * Closes the terminal and exits the command.
 */
terminal.Command.prototype.close_ = function() {
  chrome.terminalPrivate.closeTerminalProcess(this.id_);
  this.id_ = null;
};

/**
 * Notify process about new terminal size.
 *
 * @param {string|number} width The new terminal width.
 * @param {string|number} height The new terminal height.
 */
terminal.Command.prototype.onTerminalResize_ = function(width, height) {
  chrome.terminalPrivate.onTerminalResize(
      this.id_, Number(width), Number(height), function(success) {
        if (!success) {
          console.warn('terminalPrivate.onTerminalResize failed');
        }
      });
};

/**
 * Exit the terminal command.
 *
 * @param {number} code Exit code, 0 for success.
 */
terminal.Command.prototype.exit = function(code) {
  this.close_();
  window.onbeforeunload = null;

  if (code == 0) {
    this.io.pop();
    if (this.argv_.onExit) {
      this.argv_.onExit(code);
    }
  }
};

/**
 * Set background image from local storage and listen for changes.
 *
 * @param {!hterm.Terminal} term
 */
terminal.watchLocalStorageBackgroundImage = function(term) {
  const setBackgroundImage = (dataUrl) => {
    if (!term.getPrefs().get('background-image')) {
      term.setBackgroundImage(dataUrl ? `url(${dataUrl})` : '');
    }
  };
  setBackgroundImage(window.localStorage.getItem('background-image'));
  window.addEventListener('storage', (e) => {
    if (e.key === 'background-image') {
      setBackgroundImage(e.newValue);
    }
  });
};
