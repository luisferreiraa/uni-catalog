const nextJest = require('next/jest');

const createJestConfig = nextJest({
    // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
    dir: './',
});

// Add any custom config to be passed to Jest
const customJestConfig = {
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    testEnvironment: 'jest-environment-jsdom',
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
    },
    transform: {
        '^.+\\.(ts|tsx)$': 'ts-jest',
    },
    globals: {
        'ts-jest': {
            tsconfig: '<rootDir>/tsconfig.jest.json', // Use a specific tsconfig for Jest
        },
    },
    testPathIgnorePatterns: ['/node_modules/', '/.next/'],
    collectCoverageFrom: [
        'app/**/*.{ts,tsx}',
        'components/**/*.{ts,tsx}',
        'lib/**/*.{ts,tsx}',
        '!app/layout.tsx', // Exclude layout as it's usually boilerplate
        '!app/globals.css', // Exclude CSS
        '!lib/template-cache.ts', // Exclude as it's a simple cache, not complex logic
        '!lib/prompt-optimizer.ts', // Exclude as it's mostly string concatenation
        '!lib/database.ts', // Exclude as it's an external dependency wrapper
    ],
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
module.exports = createJestConfig(customJestConfig);