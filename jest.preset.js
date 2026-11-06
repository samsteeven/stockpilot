const nxPreset = require('@nx/jest/preset').default;

module.exports = {
  ...nxPreset,
  resolver: require.resolve('./jest.resolver.cjs'),
};
