const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf-8');

const match = html.match(/<script data-module="v148Economy">([\s\S]*?)<\/script>/i);
if (!match) {
  console.log('v148Economy script not found!');
  process.exit(1);
}

console.log('Found v148Economy, testing execution...');

const createdElements = [];
const mockBox = {
  appendChild: (el) => {
    console.log('Box appendChild:', el.id);
    createdElements.push(el);
  }
};

const domMap = new Map();

const mockD = {
  querySelector: (sel) => {
    console.log('querySelector:', sel);
    if (sel === '#paneG .chart-box') return mockBox;
    return null;
  },
  getElementById: (id) => domMap.get(id) || null,
  createElement: (tag) => {
    const el = {
      tag,
      id: '',
      title: '',
      style: {},
      className: '',
      innerHTML: '',
      addEventListener: () => {}
    };
    return el;
  },
  body: {
    appendChild: (el) => {
      console.log('body appendChild:', el.id);
      domMap.set(el.id, el);
    }
  },
  addEventListener: (evt, cb) => {
    if (evt === 'DOMContentLoaded') setTimeout(cb, 10);
  },
};

const mockW = {
  v121: { last: { speed: 1.0, iv: 35, rv6: 30, rv24: 32 } },
  v139: null,
  AudioContext: function() {},
  Notification: { permission: 'denied' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
};

try {
  const code = match[1];
  // Replace references to window, document
  const fn = new Function('window', 'document', 'localStorage', code);
  fn(mockW, mockD, mockW.localStorage);
  console.log('v148Economy successfully executed without errors!');
  console.log('Mock elements mounted:', createdElements.map(e => e.id));
} catch(e) {
  console.error('Execution error in v148Economy:', e);
}
