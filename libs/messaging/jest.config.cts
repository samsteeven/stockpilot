const { readFileSync } = require('fs');

// Reading the SWC compilation config for the spec files
const swcJestConfig = JSON.parse(
  readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'),
);

// Disable .swcrc look-up by SWC core because we're passing in swcJestConfig ourselves
swcJestConfig.swcrc = false;

module.exports = {
  displayName: 'messaging',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // Tests contre PostgreSQL réel (voir libs/testing).
  globalSetup: '<rootDir>/../testing/src/lib/global-setup.ts',
  globalTeardown: '<rootDir>/../testing/src/lib/global-teardown.ts',
  testTimeout: 60_000,
  passWithNoTests: true,
  coverageDirectory: 'test-output/jest/coverage',
};
