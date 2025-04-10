/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/js-with-ts-esm',
  testEnvironment: 'jsdom', // Using jsdom instead of node to support Worker-like behavior
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      useESM: true,
    }],
  },
  testMatch: ['**/__tests__/**/*.ts?(x)', '**/?(*.)+(spec|test).ts?(x)'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!**/node_modules/**',
    '!**/vendor/**',
  ],
  testTimeout: 10000, // Default timeout of 10 seconds for all tests
  setupFilesAfterEnv: ['./__tests__/setup.ts'],
  modulePathIgnorePatterns: ['<rootDir>/__tests__/setup.ts'],
};