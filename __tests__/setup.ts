// Jest setup file
import { jest, afterEach, beforeEach } from '@jest/globals';

// Mock global.crypto.randomUUID if needed
if (!global.crypto) {
  global.crypto = {
    randomUUID: () => {
      return Math.random().toString(36).substring(2, 15) +
        Math.random().toString(36).substring(2, 15);
    }
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// Reset mocks after each test
afterEach(() => {
  jest.clearAllMocks();
});

// Default timeout is set in jest.config.ts

// Polyfill for window.MessageChannel and other web APIs if needed
if (typeof MessageChannel === 'undefined') {
  const mockFn = () => { };
  global.MessageChannel = class MessageChannel {
    port1 = { postMessage: mockFn };
    port2 = { postMessage: mockFn };
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// Store original console methods
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

// Reset console methods before each test
beforeEach(() => {
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  console.log = originalConsoleLog;
});