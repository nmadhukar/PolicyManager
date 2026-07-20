/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  // FINDING-013: sanitize-html's parser chain (htmlparser2, domutils,
  // dom-serializer, domhandler, domelementtype, entities) ships ESM-only
  // ("type": "module", no CJS build), so those six must be transformed like
  // our own source. Scoped narrowly — transforming ALL of node_modules
  // (clearing this entirely) works but roughly 10x's suite runtime and breaks
  // unrelated specs (e.g. azure-oidc's openid-client mocking), so list
  // exactly the offenders instead of the default skip-everything pattern.
  transformIgnorePatterns: [
    '/node_modules/(?!(htmlparser2|domutils|dom-serializer|domhandler|domelementtype|entities)/)',
  ],
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@policymanager/shared$': '<rootDir>/../../../packages/shared/src/index.ts',
  },
};
